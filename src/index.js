import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

import ContentBinding from './ContentBinding';
import PresenceTune from './PresenceTune';

/**
 * This class adds Yjs-based, real-time collaboration to Editor.js. This
 * class is framework-agnostic. This class needs only these values: a
 * WebSocket URL, a room name, a ticket, or a function that supplies a
 * ticket, and a user's display identity. This class has no dependency
 * on ticket creation method, backend identity, or app identity. A host
 * application, for example glitchr/base-bundle's EditorType class, must
 * supply real values for these items.
 *
 * This class uses two-phase construction. EditorJS needs the Block Tune
 * inside its `tools` configuration before the EditorJS instance exists.
 * But a Tune needs an active hub, for presence data and conflict data.
 * Because of this order, create the EditorYjs object first:
 *
 *   const collab = new EditorYjs({ wsUrl, room, ticket, user });
 *   const editor = new EditorJS({
 *     tools: { ...., presence: { class: collab.Tune, tunes: ['presence'] } },
 *     tunes: ['presence'],
 *     onReady: () => collab.attach(editor, 'editor-holder-id'),
 *   });
 *   // later: collab.destroy();
 */
export default class EditorYjs {
    /**
     * @param {object} opts
     * @param {string} opts.wsUrl - This is the base WebSocket URL, for
     *   example "wss://host/collab". Do not add a room or a ticket to
     *   this value.
     * @param {string} opts.room - This is an opaque room identifier. This
     *   package does not parse this value or assume its shape.
     * @param {string} [opts.ticket] - This is a ready-made ticket string.
     * @param {() => Promise<string>} [opts.getTicket] - This class calls
     *   this function for the initial connection. This class also calls
     *   this function on a timer, through ticketRefreshMs, to keep the
     *   connection authorized across a reconnection. Because of this
     *   function, this package does not need information about ticket
     *   creation or ticket duration.
     * @param {number} [opts.ticketRefreshMs] - This value sets the call
     *   interval for getTicket(), when a caller supplies that function.
     *   The default value is 45000.
     * @param {{id?: string|number, name: string, color: string}} opts.user
     *   - This class sends this object through the awareness channel.
     * @param {number} [opts.conflictWindowMs] - Refer to the class
     *   ContentBinding for this value.
     */
    constructor({ wsUrl, room, ticket, getTicket, ticketRefreshMs = 45000, user, conflictWindowMs = 4000 }) {
        if (!wsUrl || !room) {
            throw new Error('editorjs-yjs: wsUrl and room are required');
        }
        if (!ticket && !getTicket) {
            throw new Error('editorjs-yjs: either ticket or getTicket must be provided');
        }

        this.user = user || { name: 'Anonymous', color: '#999999' };
        this.getTicket = getTicket;

        this.ydoc = new Y.Doc();

        // This code uses connect:false here. A fresh ticket must exist
        // in `params`, before the first connection attempt. The
        // getTicket() function is asynchronous. An immediate connection,
        // the library's default behavior, would race against that
        // function and send an empty ticket or a stale ticket. The
        // method _resolveInitialTicket() calls provider.connect() by
        // itself, after a real ticket exists.
        const base = wsUrl.replace(/\/+$/, '') + '/collab/';
        this.provider = new WebsocketProvider(base, encodeURIComponent(room), this.ydoc, {
            connect: false,
            params: { ticket: ticket || '' },
        });

        this.provider.awareness.setLocalStateField('user', { name: this.user.name, color: this.user.color });

        // These are per-block subscriber registries. These registries
        // let each Tune instance, one for each block, react to awareness
        // changes and conflict changes. With these registries, each Tune
        // instance needs no separate WebSocket connection and no
        // separate awareness connection.
        this._presenceSubscribers = new Map(); // This map holds a Set of callback functions, for each block id.
        this._conflictSubscribers = new Map(); // This map holds a Set of callback functions, for each block id.
        this._conflictState = new Map(); // This map holds the remote data, for each block id.

        this.binding = new ContentBinding({
            ydoc: this.ydoc,
            conflictWindowMs,
            onConflict: (blockId, remoteData) => this._setConflict(blockId, remoteData),
        });

        this._onAwarenessChange = () => this._dispatchPresence();
        this.provider.awareness.on('change', this._onAwarenessChange);

        // This code creates a bound class for each instance. Because of
        // this method, EditorJS's `tools` configuration receives a
        // plain, constructable class, and this class holds a closure
        // over this EditorYjs instance.
        const hub = this;
        this.Tune = class extends PresenceTune {
            constructor(opts) {
                super({ ...opts, hub });
            }
        };

        this._connectReady = this._resolveInitialTicket(ticket).then(() => {
            this.provider.connect();
            if (this.getTicket && ticketRefreshMs > 0) {
                this._ticketTimer = setInterval(() => this._refreshTicket(), ticketRefreshMs);
            }
        });

        // A timer alone is not a sufficient refresh strategy, and relying on
        // one produced "WebSocket connection failed: There was a bad response
        // from the server" in normal use.
        //
        // Tickets are short-lived by design (CollabTicketFactory mints them
        // with a small ttl), and the interval above is only a little shorter
        // than that ttl. Browsers clamp setInterval in background tabs to once
        // a minute, and suspend timers outright while the machine sleeps, so
        // the interval slips past the ttl exactly when the tab is not in front
        // of the user. y-websocket then auto-reconnects, re-encoding
        // provider.params into the URL - carrying the stale ticket - and the
        // relay answers 401, which surfaces as that error.
        //
        // Both hooks below close that window regardless of timer throttling:
        //
        //   connection-close: refresh as soon as the socket drops, so the
        //   pending auto-retry has a fresh ticket to send. y-websocket reads
        //   provider.params on every connection attempt, so updating it
        //   mid-backoff is picked up; an early retry may still 401, but the
        //   retry after it succeeds rather than looping forever on a ticket
        //   that can never become valid again.
        //
        //   visibilitychange: refresh the moment the tab is foregrounded,
        //   which is precisely when throttling ends and a suspended session
        //   resumes.
        if (this.getTicket) {
            this._onConnectionClose = () => { this._refreshTicket(); };
            this.provider.on('connection-close', this._onConnectionClose);

            if (typeof document !== 'undefined') {
                this._onVisibilityChange = () => {
                    if (document.visibilityState === 'visible') this._refreshTicket();
                };
                document.addEventListener('visibilitychange', this._onVisibilityChange);
            }
        }
    }

    async _resolveInitialTicket(staticTicket) {
        if (this.getTicket) {
            await this._refreshTicket();
        } else {
            this.provider.params.ticket = staticTicket;
        }
    }

    async _refreshTicket() {
        try {
            const fresh = await this.getTicket();
            if (fresh) this.provider.params.ticket = fresh;
        } catch (e) {
            // A network problem occurred, or the app's session expired.
            // In this case, the existing connection, if a connection
            // exists, continues to run. The next timer event or
            // reconnection attempt will try this operation again.
            console.warn('editorjs-yjs: getTicket() failed, will retry', e);
        }
    }

    /**
     * @param {import('@editorjs/editorjs').default} editor
     * @param {HTMLElement|string} holder - This value must be the same
     *   holder, an element or an id string, that the caller used to
     *   construct the editor. This method does not read this value from
     *   the editor instance itself. The `editor.configuration` property
     *   is not part of EditorJS's documented public API, so this package
     *   has no dependency on that property.
     */
    async attach(editor, holder) {
        this.editor = editor;

        this._onFocusIn = (e) => {
            const blockAPI = editor.blocks.getBlockByElement(e.target);
            this._focusedBlockId = blockAPI ? blockAPI.id : undefined;
            this.provider.awareness.setLocalStateField('focusedBlockId', this._focusedBlockId);
        };
        this._onFocusOut = () => {
            this._focusedBlockId = undefined;
            this.provider.awareness.setLocalStateField('focusedBlockId', undefined);
        };

        const holderEl = typeof holder === 'string' ? document.getElementById(holder) : holder;
        this._holderEl = holderEl || null;
        if (this._holderEl) {
            this._holderEl.addEventListener('focusin', this._onFocusIn);
            this._holderEl.addEventListener('focusout', this._onFocusOut);
        }

        // Wait for the room's existing state to arrive BEFORE handing over to
        // ContentBinding.attach(), which decides "does this room already have
        // content?" by reading this.yarray.length.
        //
        // Without this wait that check is meaningless: the WebsocketProvider
        // connects asynchronously, so at attach() time the local Y.Doc is
        // still empty no matter what the room actually holds. Every client
        // therefore took the "empty room" branch and pushed its OWN full copy
        // of the document; when the server state then merged in, the CRDT kept
        // both - the room's blocks AND the freshly pushed duplicates. Y.Array
        // items are identified by (client, clock), not by block id, so
        // re-inserting "the same" blocks genuinely appends new entries rather
        // than matching the existing ones. Each page load added another full
        // copy (observed live: 235 -> 267 -> 275 blocks over three loads), and
        // a host app persisting the room (e.g. via an autosave bridge) writes
        // that growth straight into its database.
        //
        // Times out rather than hanging: if the relay is unreachable the
        // provider never syncs, and editing must still work - falling through
        // with an empty yarray makes ContentBinding push the local document,
        // which is the correct offline behaviour.
        await this._connectReady;
        await this._whenSynced();

        await this.binding.attach(editor);
    }

    /**
     * Resolves once the provider has completed its initial sync with the room
     * (or after `timeoutMs`, so an unreachable relay degrades to offline
     * editing instead of blocking the editor forever).
     *
     * @param {number} [timeoutMs]
     * @returns {Promise<boolean>} true if genuinely synced, false on timeout.
     */
    _whenSynced(timeoutMs = 5000) {
        if (this.provider.synced) return Promise.resolve(true);

        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { this.provider.off('sync', onSync); } catch (e) { /* older y-websocket */ }
                resolve(value);
            };
            const onSync = (isSynced) => { if (isSynced) finish(true); };
            const timer = setTimeout(() => finish(false), timeoutMs);
            this.provider.on('sync', onSync);
        });
    }

    /** Pass this property directly as EditorJS's `onChange` option. */
    get onChange() {
        return this.binding.handleLocalChange;
    }

    onPresenceChange(blockId, callback) {
        if (!this._presenceSubscribers.has(blockId)) this._presenceSubscribers.set(blockId, new Set());
        this._presenceSubscribers.get(blockId).add(callback);
        callback(this._presenceForBlock(blockId));
        return () => this._presenceSubscribers.get(blockId)?.delete(callback);
    }

    onConflict(blockId, callback) {
        if (!this._conflictSubscribers.has(blockId)) this._conflictSubscribers.set(blockId, new Set());
        this._conflictSubscribers.get(blockId).add(callback);
        if (this._conflictState.has(blockId)) callback(this._conflictState.get(blockId));
        return () => this._conflictSubscribers.get(blockId)?.delete(callback);
    }

    resolveConflict(blockId, action) {
        const remoteData = this._conflictState.get(blockId);
        this._setConflict(blockId, null);
        this.binding.resolveConflict(blockId, action, remoteData);
    }

    _setConflict(blockId, remoteData) {
        if (remoteData) this._conflictState.set(blockId, remoteData);
        else this._conflictState.delete(blockId);
        this._conflictSubscribers.get(blockId)?.forEach((cb) => cb(remoteData || null));
    }

    _presenceForBlock(blockId) {
        const users = [];
        this.provider.awareness.getStates().forEach((state, clientId) => {
            // This method never shows a badge for the local user.
            if (clientId === this.ydoc.clientID) return;
            if (state.focusedBlockId === blockId && state.user) users.push(state.user);
        });
        return users;
    }

    _dispatchPresence() {
        // This method recalculates the presence data for every currently
        // subscribed, rendered block. This calculation has low cost, at
        // a realistic document size and awareness size. This method
        // avoids a separate record of each user's previous block, for
        // comparison.
        this._presenceSubscribers.forEach((subs, blockId) => {
            const users = this._presenceForBlock(blockId);
            subs.forEach((cb) => cb(users));
        });
    }

    destroy() {
        if (this._ticketTimer) clearInterval(this._ticketTimer);

        // Both are registered only when getTicket was supplied, and the
        // visibilitychange one lives on `document` - outliving this instance
        // if it is not removed, which in an SPA means one stale listener per
        // editor ever constructed, each refreshing a ticket for a destroyed
        // provider.
        if (this._onConnectionClose) {
            try { this.provider.off('connection-close', this._onConnectionClose); } catch (e) { /* older y-websocket */ }
        }
        if (this._onVisibilityChange && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibilityChange);
        }

        if (this._holderEl) {
            this._holderEl.removeEventListener('focusin', this._onFocusIn);
            this._holderEl.removeEventListener('focusout', this._onFocusOut);
        }
        this.provider.awareness.off('change', this._onAwarenessChange);
        this.binding.destroy();
        this.provider.destroy();
        this.ydoc.destroy();
    }
}
