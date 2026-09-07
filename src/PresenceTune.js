import './index.css';

/**
 * This class is a Block Tune. This class is not a content Tool. This
 * class decorates a block, when another connected user has that block
 * in focus: a colored ring and a name badge, and - when that user's
 * awareness state carries a caret position - a colored caret at that
 * exact spot in the text, with the user's name on hover, plus a tinted
 * range when they have text selected. This class also flags a block
 * whose content changed remotely, when this client also edited that
 * block very recently: a highlighted background, with restore controls
 * and suppress controls. Refer to ContentBinding's conflict handling
 * for the trigger condition.
 *
 * Carets are drawn from a character offset, not from a CRDT position:
 * this package syncs whole blocks, so there is no Y.Text to anchor to.
 * The offset is resolved against the block's contenteditable at render
 * time, and re-resolved whenever that content changes (a MutationObserver
 * on the tool's own element, never on this class's overlay) - so a
 * remote caret stays put through local typing and remote updates alike,
 * and drifts only for the instant between someone else's edit and their
 * next awareness update.
 *
 * This class connects to a specific collaboration session, through the
 * `hub` object. This object exposes three methods:
 * onPresenceChange(blockId, cb), onConflict(blockId, cb), and
 * resolveConflict(blockId, action). Refer to the EditorYjs constructor
 * in index.js: this constructor produces a fresh, closure-bound class
 * for each EditorYjs instance, because EditorJS's tools configuration
 * needs a plain, constructable class, not an instance.
 */
export default class PresenceTune {
    static get isTune() {
        return true;
    }

    // How long a caret's name label stays up after the caret moves.
    static get LABEL_FLASH_MS() {
        return 1500;
    }

    constructor({ block, hub }) {
        this.block = block;
        this.hub = hub;
        this.wrapperEl = null;
        this.badgeEl = null;
        this.overlayEl = null;
        this.conflictEl = null;

        // clientId -> { el, labelEl, selectionEls, user, positionKey, freshTimer }
        this._carets = new Map();
        this._contentEl = null;
        this._observer = null;
        this._resizeObserver = null;
        this._repositionFrame = null;

        this._unsubscribePresence = null;
        this._unsubscribeConflict = null;
    }

    wrap(pluginsContent) {
        const wrapper = document.createElement('div');
        wrapper.classList.add('ce-collab-block');
        wrapper.appendChild(pluginsContent);
        this._contentEl = pluginsContent;

        this.badgeEl = document.createElement('div');
        this.badgeEl.className = 'ce-collab-badge';
        wrapper.appendChild(this.badgeEl);

        // Carets and selection tints live here, as siblings of the tool's
        // element rather than inside it, so they never end up in the
        // block's saved data and never trip the observer below.
        this.overlayEl = document.createElement('div');
        this.overlayEl.className = 'ce-collab-overlay';
        wrapper.appendChild(this.overlayEl);

        this.conflictEl = document.createElement('div');
        this.conflictEl.className = 'ce-collab-conflict';
        this.conflictEl.style.display = 'none';
        wrapper.appendChild(this.conflictEl);

        this.wrapperEl = wrapper;

        if (typeof MutationObserver !== 'undefined') {
            this._observer = new MutationObserver(() => this._scheduleReposition());
            this._observer.observe(pluginsContent, { childList: true, characterData: true, subtree: true });
        }
        // Line wrapping follows the block's width, and that changes without
        // any DOM mutation in the block - a viewport resize, a sidebar
        // opening. Observing the wrapper catches every case; a window
        // `resize` listener would miss all but the first.
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => this._scheduleReposition());
            this._resizeObserver.observe(wrapper);
        }

        if (this.hub) {
            this._unsubscribePresence = this.hub.onPresenceChange(this.block.id, (users) => this.renderPresence(users));
            this._unsubscribeConflict = this.hub.onConflict(this.block.id, (remoteData) => this.renderConflict(remoteData));
        }

        return wrapper;
    }

    render() {
        // This Tune adds no settings-menu entry. This Tune only decorates
        // the block. This Tune takes no other action.
        return {};
    }

    renderPresence(users) {
        if (!this.wrapperEl) return;

        if (!users || users.length === 0) {
            this.wrapperEl.classList.remove('ce-collab-block--focused');
            this.badgeEl.innerHTML = '';
            this._renderCarets([]);
            return;
        }

        this.wrapperEl.classList.add('ce-collab-block--focused');
        this.wrapperEl.style.setProperty('--collab-color', users[0].color || '#3a9bd9');
        this.badgeEl.innerHTML = '';
        users.forEach((user) => {
            const el = document.createElement('span');
            el.className = 'ce-collab-name';
            el.style.background = user.color || '#3a9bd9';
            el.textContent = user.name || '?';
            this.badgeEl.appendChild(el);
        });

        this._renderCarets(users);
    }

    // ── Carets ──────────────────────────────────────────────────────

    _renderCarets(users) {
        const seen = new Set();

        users.forEach((user) => {
            if (!user.cursor) return;
            const key = user.clientId != null ? user.clientId : user.name;
            seen.add(key);

            let entry = this._carets.get(key);
            if (!entry) {
                entry = this._createCaret();
                this._carets.set(key, entry);
            }
            entry.user = user;
            this._updateCaret(entry, /* announce */ true);
        });

        this._carets.forEach((entry, key) => {
            if (seen.has(key)) return;
            this._removeCaret(entry);
            this._carets.delete(key);
        });
    }

    _createCaret() {
        const el = document.createElement('div');
        el.className = 'ce-collab-caret';

        const labelEl = document.createElement('span');
        labelEl.className = 'ce-collab-caret-label';
        el.appendChild(labelEl);

        this.overlayEl.appendChild(el);
        return { el, labelEl, selectionEls: [], user: null, positionKey: null, freshTimer: null };
    }

    _removeCaret(entry) {
        clearTimeout(entry.freshTimer);
        entry.el.remove();
        entry.selectionEls.forEach((s) => s.remove());
    }

    /**
     * @param {boolean} announce - true when the user actually moved (an
     *   awareness change), which flashes the name label; false for a pure
     *   re-layout after content changed under a caret that did not move.
     */
    _updateCaret(entry, announce) {
        const { user } = entry;
        const color = user.color || '#3a9bd9';
        const host = this._editableHost();
        if (!host) {
            entry.el.style.display = 'none';
            return;
        }

        const wrapperRect = this.wrapperEl.getBoundingClientRect();
        const anchor = Math.max(0, user.cursor.anchor | 0);
        const head = Math.max(0, user.cursor.head | 0);

        // Caret at the head.
        const headRect = this._rectAt(host, head);
        entry.el.style.display = '';
        entry.el.style.left = (headRect.left - wrapperRect.left) + 'px';
        entry.el.style.top = (headRect.top - wrapperRect.top) + 'px';
        entry.el.style.height = headRect.height + 'px';
        entry.el.style.setProperty('--collab-color', color);
        entry.labelEl.textContent = user.name || '?';

        // Selection tint between anchor and head, one box per line.
        entry.selectionEls.forEach((s) => s.remove());
        entry.selectionEls = [];
        if (anchor !== head) {
            const range = document.createRange();
            const from = this._pointAt(host, Math.min(anchor, head));
            const to = this._pointAt(host, Math.max(anchor, head));
            range.setStart(from.node, from.offset);
            range.setEnd(to.node, to.offset);
            Array.from(range.getClientRects()).forEach((r) => {
                if (r.width === 0) return;
                const s = document.createElement('div');
                s.className = 'ce-collab-selection';
                s.style.left = (r.left - wrapperRect.left) + 'px';
                s.style.top = (r.top - wrapperRect.top) + 'px';
                s.style.width = r.width + 'px';
                s.style.height = r.height + 'px';
                s.style.setProperty('--collab-color', color);
                this.overlayEl.appendChild(s);
                entry.selectionEls.push(s);
            });
        }

        // Flash the label only when the caret genuinely moved, not on every
        // re-layout - otherwise typing next to someone's caret would keep
        // their name permanently lit.
        const positionKey = anchor + ':' + head;
        if (announce && positionKey !== entry.positionKey) {
            entry.el.classList.add('is-fresh');
            clearTimeout(entry.freshTimer);
            entry.freshTimer = setTimeout(() => entry.el.classList.remove('is-fresh'), PresenceTune.LABEL_FLASH_MS);
        }
        entry.positionKey = positionKey;
    }

    _scheduleReposition() {
        if (this._repositionFrame != null || this._carets.size === 0) return;
        this._repositionFrame = requestAnimationFrame(() => {
            this._repositionFrame = null;
            this._carets.forEach((entry) => this._updateCaret(entry, false));
        });
    }

    _editableHost() {
        if (!this._contentEl) return null;
        if (this._contentEl.isContentEditable && this._contentEl.getAttribute('contenteditable') === 'true') return this._contentEl;
        return this._contentEl.querySelector('[contenteditable="true"]');
    }

    /**
     * Character offset -> DOM point, counting text nodes in document order.
     * This is the mirror of how the hub measures the local offset
     * (Range.toString().length from the host's start), so both sides agree
     * without either needing to know the tool's markup.
     */
    _pointAt(host, offset) {
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        let remaining = offset;
        let last = null;
        let node;
        while ((node = walker.nextNode())) {
            const len = node.data.length;
            if (remaining <= len) return { node, offset: remaining };
            remaining -= len;
            last = node;
        }
        if (last) return { node: last, offset: last.data.length };
        return { node: host, offset: 0 };
    }

    _rectAt(host, offset) {
        const point = this._pointAt(host, offset);
        const range = document.createRange();
        range.setStart(point.node, point.offset);
        range.setEnd(point.node, point.offset);
        const rects = range.getClientRects();
        if (rects.length > 0) return rects[0];

        // A collapsed range in an empty element reports no rects at all.
        // Fall back to the host's own box, one line tall, at its text start.
        const hostRect = host.getBoundingClientRect();
        const style = window.getComputedStyle(host);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4 || hostRect.height;
        return {
            left: hostRect.left + (parseFloat(style.paddingLeft) || 0),
            top: hostRect.top + (parseFloat(style.paddingTop) || 0),
            height: Math.min(lineHeight, hostRect.height) || lineHeight,
        };
    }

    // ── Conflicts ───────────────────────────────────────────────────

    renderConflict(remoteData) {
        if (!this.wrapperEl) return;

        if (!remoteData) {
            this.wrapperEl.classList.remove('ce-collab-block--conflict');
            this.conflictEl.style.display = 'none';
            this.conflictEl.innerHTML = '';
            return;
        }

        this.wrapperEl.classList.add('ce-collab-block--conflict');
        this.conflictEl.style.display = '';
        this.conflictEl.innerHTML = '';

        const text = document.createElement('span');
        text.textContent = 'Modified by someone else while you were editing.';

        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.textContent = 'Keep mine';
        restoreBtn.addEventListener('click', () => this.hub?.resolveConflict(this.block.id, 'restore'));

        const suppressBtn = document.createElement('button');
        suppressBtn.type = 'button';
        suppressBtn.textContent = 'Accept theirs';
        suppressBtn.addEventListener('click', () => this.hub?.resolveConflict(this.block.id, 'suppress'));

        this.conflictEl.append(text, restoreBtn, suppressBtn);
    }

    /**
     * EditorJS version 2.31 has no formal Tune destroy hook. Because of
     * this gap, ContentBinding calls this method itself, as a
     * precaution, when ContentBinding removes a block. This call
     * prevents the hub from holding a closure for a block that no
     * longer exists.
     */
    destroy() {
        this._unsubscribePresence?.();
        this._unsubscribeConflict?.();
        this._observer?.disconnect();
        this._observer = null;
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        if (this._repositionFrame != null) cancelAnimationFrame(this._repositionFrame);
        this._repositionFrame = null;
        this._carets.forEach((entry) => this._removeCaret(entry));
        this._carets.clear();
    }
}
