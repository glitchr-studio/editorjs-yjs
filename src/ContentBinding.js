/**
 * Whole-block content sync between an EditorJS instance and a Yjs Y.Array —
 * NOT character-level: two people editing the exact same block is handled
 * as a conflict (reported via onConflict), not merged. Different blocks
 * edited concurrently merge automatically, which is the common case.
 *
 * Local changes are reconciled via a single DEBOUNCED full-state diff, not
 * per-event dispatch keyed by EditorJS's onChange event types/ids. That was
 * the first design tried here, and real browser testing (two live EditorJS
 * instances, not just code review) surfaced two compounding problems with
 * it: (1) EditorJS's onChange is itself debounced, so the applyingRemote
 * mutex — reset synchronously right after applyRemoteToEditor() returns —
 * could already be back to false by the time EditorJS's own debounced
 * onChange fired for a change WE had just applied, causing it to be
 * re-pushed as if it were a fresh local edit; (2) a block's `id` is not
 * guaranteed stable between its 'block-added' event and the following
 * 'block-changed' event for what is semantically the same block (observed
 * directly: typing into a freshly-created empty block fired 'block-added'
 * with one id and 'block-changed' with a different one), which broke
 * id-keyed per-event reconciliation and, combined with per-event async
 * awaits racing each other across rapid keystrokes, produced runaway
 * duplicate blocks. A single debounced full-state diff sidesteps both:
 * there is exactly one in-flight reconciliation at a time, it compares
 * complete snapshots rather than trusting individual event payloads, and a
 * no-op (content already matches) is cheap to detect and skip.
 */
export default class ContentBinding {
    /**
     * @param {object} opts
     * @param {Y.Doc} opts.ydoc
     * @param {(blockId: string, remoteData: any) => void} opts.onConflict
     *   Called when a block changed remotely while this client also edited
     *   it very recently — caller (the hub) is responsible for surfacing
     *   this via the PresenceTune rather than silently applying it.
     * @param {number} [opts.conflictWindowMs] How recently a local edit to
     *   the same block counts as a live conflict rather than a stale one.
     * @param {number} [opts.localSyncDebounceMs] How long to wait after the
     *   last local change before diffing/pushing to the Y.Array.
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
        this.recentLocalEdits = new Map(); // blockId -> timestamp

        this._pendingRemoteApply = false;

        this._observer = (event, transaction) => {
            if (transaction.origin === 'local') return;
            this._maybeApplyRemote();
        };
        this.yarray.observe(this._observer);
    }

    /**
     * Gatekeeps applyRemoteToEditor() against a local edit that's still
     * mid-debounce: running the remote diff against editor.save() while the
     * user is actively typing (their latest keystrokes not yet flushed to
     * the Y.Array) means reading a half-updated local snapshot, which
     * produced real, reproduced-in-testing corruption — a block's own
     * in-progress text getting spliced against an older copy of itself.
     * Deferring until the pending local sync flushes keeps the two
     * directions strictly ordered instead of interleaved.
     */
    _maybeApplyRemote() {
        if (this._localSyncTimer) {
            this._pendingRemoteApply = true;
            return;
        }
        this.applyRemoteToEditor();
    }

    /**
     * Wires up to a live EditorJS instance and does the initial sync: if
     * the room already has content (another client got there first, or a
     * persistence bridge pre-populated it), that wins over whatever the
     * editor loaded from the database — it's the same document, just a
     * possibly-newer copy of it via the CRDT.
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
     * Feed this to EditorJS's `onChange` option — accepts both the single-
     * event and batched-array shapes EditorJS's onChange can call with.
     * Deliberately does no per-event work beyond bookkeeping for the
     * conflict-window heuristic; the actual sync is one debounced pass over
     * the editor's full current state (see class doc for why).
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
     * Diffs the editor's complete current state against the Y.Array and
     * applies the minimal set of operations to make them match — run once
     * per debounce window rather than per keystroke/event.
     */
    async syncLocalToYArray() {
        if (this.applyingRemote || !this.editor) return;

        const saved = await this.editor.save();
        if (this.applyingRemote) return; // a remote apply started during the await above

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
            // Remove yarray entries for blocks no longer present locally.
            for (let i = this.yarray.length - 1; i >= 0; i--) {
                const entry = this.yarray.get(i);
                if (!entry || !seenIds.has(entry.id)) this.yarray.delete(i, 1);
            }

            // Insert/update/reorder to match local order, touching only
            // entries that actually differ (keeps unrelated blocks stable
            // for other connected clients rendering the same document).
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
     * current length, and that length moves under this loop on every
     * delete/insert. Clamping keeps one drifted index from aborting the whole
     * transaction (which would leave the CRDT half-updated); worst case the
     * block lands at the end and the next reconciliation pass reorders it.
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
     * Reconciles the editor's current blocks with the Y.Array's content —
     * called on every remote change. Blocks this client edited within
     * conflictWindowMs are NOT silently overwritten; they're reported via
     * onConflict instead (see PresenceTune's restore/suppress UI).
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
            // snapshot is what produced EditorJS's "indices cannot be lower
            // than 0 or greater than the amount of blocks" warning, and - once
            // the drift let a block be inserted that was already present - the
            // duplicate ids that then made syncLocalToYArray() throw Yjs's
            // "Length exceeded!". Positions are re-read live, per iteration,
            // via _editorBlockIds().
            const localDataById = new Map(localBlocks.map((b) => [b.id, b.data]));
            const remoteIds = new Set(remoteBlocks.map((b) => b.id));

            // Deletions: local block no longer present remotely. Resolved
            // against the live list each time, since each delete reindexes
            // everything after it.
            for (const lb of localBlocks) {
                if (remoteIds.has(lb.id)) continue;
                const idx = this._editorBlockIds().indexOf(lb.id);
                if (idx >= 0) this.editor.blocks.delete(idx);
            }

            // Insertions, updates, and reordering, in remote order.
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
     * User-initiated resolution from the PresenceTune's restore/suppress
     * buttons. "restore" re-syncs this client's current block content
     * (overwriting the remote value for everyone); "suppress" just accepts
     * whatever's already in the Y.Array by applying it immediately.
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
