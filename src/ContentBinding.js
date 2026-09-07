/**
 * This class synchronizes content between an EditorJS instance and a Yjs
 * Y.Array, at whole-block granularity, not at character-level
 * granularity. When two users edit the exact same block, this class
 * reports a conflict, through onConflict. This class does not merge the
 * two edits. When two users edit different blocks, at the same time,
 * this class merges the changes automatically. This is the typical
 * case.
 *
 * This class reconciles local changes through one debounced, full-state
 * comparison. This class does not dispatch one update action for each
 * EditorJS onChange event type or event id. An earlier version of this
 * class used that per-event method. Real browser tests, with two live
 * EditorJS instances, not code review alone, found two problems with
 * that method, and the two problems compounded each other.
 *
 * First problem: EditorJS's own onChange callback has an internal delay.
 * The applyingRemote mutex resets to false immediately after
 * applyRemoteToEditor() returns. Because of the onChange delay, this
 * reset could occur before EditorJS's own delayed onChange callback
 * fired, for a change that this class had just applied. This timing
 * caused the class to push that change again, as if it were a new local
 * edit.
 *
 * Second problem: a block's `id` value is not always stable between its
 * 'block-added' event and its next 'block-changed' event, for what is,
 * in effect, the same block. Test evidence: a user typed into a
 * freshly-created empty block; the 'block-added' event reported one id
 * value; the 'block-changed' event reported a different id value. This
 * instability broke the earlier id-keyed, per-event method. Combined
 * with separate async operations that raced each other across rapid
 * keystrokes, this instability produced an unlimited number of
 * duplicate blocks.
 *
 * The single debounced, full-state comparison method avoids both
 * problems. This method allows exactly one reconciliation operation at
 * a time. This method compares complete snapshots. This method does not
 * trust an individual event's payload. This method also detects a
 * no-op, when the content already matches, at low cost, and skips
 * unnecessary work.
 */
export default class ContentBinding {
    /**
     * @param {object} opts
     * @param {Y.Doc} opts.ydoc
     * @param {(blockId: string, remoteData: any) => void} opts.onConflict
     *   This class calls this function when a block changes remotely, and
     *   this client also edited that same block very recently. The
     *   caller, the hub, is responsible for the display of this conflict,
     *   through the PresenceTune. This class does not apply the remote
     *   change silently in this case.
     * @param {number} [opts.conflictWindowMs] This value sets the time
     *   window for a live conflict. A local edit to the same block,
     *   inside this window, counts as a live conflict. A local edit
     *   outside this window does not count as a live conflict.
     * @param {number} [opts.localSyncDebounceMs] This value sets the wait
     *   time after the last local change, before this class compares the
     *   local state to the Y.Array and pushes any difference.
     */
    constructor({ ydoc, onConflict, conflictWindowMs = 4000, localSyncDebounceMs = 250 }) {
        this.ydoc = ydoc;
        this.yarray = ydoc.getArray('blocks');
        this.onConflict = onConflict;
        this.conflictWindowMs = conflictWindowMs;
        this.localSyncDebounceMs = localSyncDebounceMs;

        this.editor = null;
        this.applyingRemote = false;
        this._localSyncTimer = null;
        this.recentLocalEdits = new Map(); // This map holds a timestamp for each block id.

        this._pendingRemoteApply = false;

        this._observer = (event, transaction) => {
            if (transaction.origin === 'local') return;
            this._maybeApplyRemote();
        };
        this.yarray.observe(this._observer);
    }

    /**
     * This method controls access to applyRemoteToEditor(), against a
     * local edit that is still inside its debounce delay. If this class
     * ran the remote comparison against editor.save() while a user was
     * actively typing, this class would read a half-updated local
     * snapshot, because the latest keystrokes were not yet flushed to
     * the Y.Array. This exact condition produced real data corruption,
     * confirmed through tests: a block's own in-progress text combined
     * with an older copy of itself. This method delays the remote
     * operation until the pending local synchronization completes. This
     * order keeps the two directions strict and separate. This order
     * prevents interleaving.
     */
    _maybeApplyRemote() {
        if (this._localSyncTimer) {
            this._pendingRemoteApply = true;
            return;
        }
        this.applyRemoteToEditor();
    }

    /**
     * This method connects this class to a live EditorJS instance. This
     * method also performs the first synchronization action. If the
     * room already has content, from an earlier client or from a
     * persistence bridge, that content takes priority over the content
     * that the editor loaded from the database. Both sets of content
     * represent the same document. The room's content is a possibly
     * newer copy of that document, through the CRDT.
     */
    async attach(editor) {
        this.editor = editor;
        if (this.yarray.length > 0) {
            await this.applyRemoteToEditor();
        } else {
            await this.syncLocalToYArray();
        }
    }

    /**
     * Pass this method to EditorJS's `onChange` option. This method
     * accepts two possible input shapes: a single event, or a batched
     * array of events. This method performs no per-event action, beyond
     * a record of each event for the conflict-window heuristic. The
     * actual synchronization action is one debounced pass over the
     * editor's full current state. Refer to the class-level comment
     * above for the reason.
     */
    handleLocalChange = (api, events) => {
        if (this.applyingRemote) return;

        const list = Array.isArray(events) ? events : [events];
        for (const event of list) {
            const id = event?.detail?.target?.id;
            if (id) this.recentLocalEdits.set(id, Date.now());
        }

        if (this._localSyncTimer) clearTimeout(this._localSyncTimer);
        this._localSyncTimer = setTimeout(async () => {
            this._localSyncTimer = null;
            await this.syncLocalToYArray();
            if (this._pendingRemoteApply) {
                this._pendingRemoteApply = false;
                await this.applyRemoteToEditor();
            }
        }, this.localSyncDebounceMs);
    };

    /**
     * This method compares the editor's complete current state against
     * the Y.Array. This method applies the minimal set of operations to
     * make the two states equal. This method runs once for each
     * debounce window. This method does not run for each keystroke or
     * event separately.
     */
    async syncLocalToYArray() {
        if (this.applyingRemote || !this.editor) return;

        const saved = await this.editor.save();
        // A remote operation can start during the await statement above.
        if (this.applyingRemote) return;

        // Deduplicate by id. EditorJS should never report the same block id
        // twice, but a mis-applied remote patch can leave the editor in that
        // state, and _findYIndexById() below resolves BOTH copies to the same
        // first match - so the second copy deletes that entry and then tries
        // to insert past the (now shorter) array, which is exactly Yjs's
        // "Length exceeded!". Dropping the extras here also stops one bad
        // local render from propagating into the CRDT, where it would corrupt
        // the document for every other connected client rather than just this
        // one.
        const seenIds = new Set();
        const localBlocks = [];
        for (const b of (saved?.blocks || [])) {
            if (!b || seenIds.has(b.id)) continue;
            seenIds.add(b.id);
            localBlocks.push({ id: b.id, type: b.type, data: b.data });
        }

        const currentSnapshot = this.yarray.toArray();
        if (this._blocksEqual(currentSnapshot, localBlocks)) return;

        this.ydoc.transact(() => {
            // This code removes each yarray entry for a block that no
            // longer exists locally.
            for (let i = this.yarray.length - 1; i >= 0; i--) {
                const entry = this.yarray.get(i);
                if (!entry || !seenIds.has(entry.id)) this.yarray.delete(i, 1);
            }

            // This code inserts, updates, or reorders entries, to match
            // the local order. This code changes only an entry that
            // actually differs. This method keeps an unrelated block
            // stable, for another connected client that renders the same
            // document.
            localBlocks.forEach((lb, index) => {
                const idx = this._findYIndexById(lb.id);

                if (idx < 0) {
                    this._insertAt(index, lb);
                    return;
                }

                const existing = this.yarray.get(idx);
                const changed = existing.type !== lb.type || JSON.stringify(existing.data) !== JSON.stringify(lb.data);
                if (changed || idx !== index) {
                    this.yarray.delete(idx, 1);
                    this._insertAt(index, lb);
                }
            });
        }, 'local');
    }

    /**
     * Yjs throws "Length exceeded!" for any insert index past the array's
     * current length, and that length moves under the reconciliation loop on
     * every delete/insert. Clamping keeps one drifted index from aborting the
     * whole transaction (which would leave the CRDT half-updated); worst case
     * the block lands at the end and the next pass reorders it.
     */
    _insertAt(index, block) {
        const at = Math.max(0, Math.min(index, this.yarray.length));
        this.yarray.insert(at, [block]);
    }

    _findYIndexById(blockId) {
        for (let i = 0; i < this.yarray.length; i++) {
            const entry = this.yarray.get(i);
            if (entry && entry.id === blockId) return i;
        }
        return -1;
    }

    _blocksEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i].id !== b[i].id || a[i].type !== b[i].type) return false;
            if (JSON.stringify(a[i].data) !== JSON.stringify(b[i].data)) return false;
        }
        return true;
    }

    /**
     * This method reconciles the editor's current blocks with the
     * Y.Array's content. This class calls this method on every remote
     * change. This method does not overwrite a block silently, if this
     * client edited that block inside the conflictWindowMs time window.
     * Instead, this method reports the conflict, through onConflict.
     * Refer to the PresenceTune's restore-and-suppress UI for the
     * display of this report.
     */
    async applyRemoteToEditor() {
        if (!this.editor) return;

        this.applyingRemote = true;
        try {
            const remoteBlocks = this.yarray.toArray();
            const localSaved = await this.editor.save();
            const localBlocks = localSaved?.blocks || [];

            // Snapshot of local block DATA only, keyed by id, used solely for
            // the "did this block's content change" comparison below.
            // Positions are deliberately NOT taken from here: every
            // delete/insert/move in the loops below shifts the index of every
            // block after it, so a snapshot taken once up front is stale from
            // the first mutation onward. Reading positions from that stale
            // snapshot produced EditorJS's "indices cannot be lower than 0 or
            // greater than the amount of blocks" warning, and - once the drift
            // let a block be inserted that was already present - the duplicate
            // ids that then made syncLocalToYArray() throw Yjs's "Length
            // exceeded!". Positions are re-read live, per iteration, via
            // _editorBlockIds().
            const localDataById = new Map(localBlocks.map((b) => [b.id, b.data]));
            const remoteIds = new Set(remoteBlocks.map((b) => b.id));

            // This code deletes each local block that no longer exists
            // in the remote data. The index is resolved against the live list
            // each time, since each delete reindexes everything after it.
            for (const lb of localBlocks) {
                if (remoteIds.has(lb.id)) continue;
                const idx = this._editorBlockIds().indexOf(lb.id);
                if (idx >= 0) this.editor.blocks.delete(idx);
            }

            // This code inserts, updates, and reorders blocks, in the
            // remote order.
            for (let index = 0; index < remoteBlocks.length; index++) {
                const rb = remoteBlocks[index];
                let ids = this._editorBlockIds();

                if (ids.indexOf(rb.id) < 0) {
                    // Clamp: EditorJS silently ignores an out-of-range insert
                    // index, which would leave this block missing entirely and
                    // desync the two sides again on the next pass.
                    const at = Math.min(index, ids.length);
                    this.editor.blocks.insert(rb.type, rb.data, {}, at, false, false, rb.id);
                    continue;
                }

                const changed = JSON.stringify(localDataById.get(rb.id)) !== JSON.stringify(rb.data);
                const recentlyEditedLocally = (Date.now() - (this.recentLocalEdits.get(rb.id) || 0)) < this.conflictWindowMs;

                if (changed && recentlyEditedLocally) {
                    this.onConflict?.(rb.id, rb.data);
                } else if (changed) {
                    await this.editor.blocks.update(rb.id, rb.data);
                }

                // Re-read after the update above: blocks.update() can replace
                // the block instance, and earlier iterations have mutated the
                // list. Both indices passed to move() must be valid against
                // the list as it exists right now.
                ids = this._editorBlockIds();
                const currentIndex = ids.indexOf(rb.id);
                const target = Math.min(index, ids.length - 1);
                if (currentIndex >= 0 && target >= 0 && currentIndex !== target) {
                    this.editor.blocks.move(target, currentIndex);
                }
            }
        } finally {
            this.applyingRemote = false;
        }
    }

    /**
     * The editor's block ids in their current on-screen order.
     *
     * Deliberately not editor.blocks.getBlockIndex(id): that API returns
     * `undefined` (not -1) for an unknown id AND logs its own "There is no
     * block with id" warning as a side effect, so probing it for presence
     * both breaks `< 0` checks and spams the console. Walking the live list
     * by index answers presence and position together, with no side effects.
     */
    _editorBlockIds() {
        const ids = [];
        const count = this.editor.blocks.getBlocksCount();
        for (let i = 0; i < count; i++) {
            const block = this.editor.blocks.getBlockByIndex(i);
            if (block) ids.push(block.id);
        }
        return ids;
    }

    /**
     * A user action from the PresenceTune's restore button or suppress
     * button calls this method. The "restore" action synchronizes this
     * client's current block content again, and this action overwrites
     * the remote value, for every connected client. The "suppress"
     * action accepts the value already in the Y.Array, and applies that
     * value immediately.
     */
    async resolveConflict(blockId, action, remoteData) {
        this.recentLocalEdits.delete(blockId);

        if (action === 'restore') {
            await this.syncLocalToYArray();
            return;
        }

        if (action === 'suppress' && remoteData) {
            this.applyingRemote = true;
            try {
                await this.editor.blocks.update(blockId, remoteData);
            } finally {
                this.applyingRemote = false;
            }
        }
    }

    destroy() {
        if (this._localSyncTimer) clearTimeout(this._localSyncTimer);
        this.yarray.unobserve(this._observer);
        this.editor = null;
    }
}
