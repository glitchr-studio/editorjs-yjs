import './index.css';

/**
 * This class is a Block Tune. This class is not a content Tool. This
 * class decorates a block, when another connected user has that block
 * in focus: a colored ring and a name badge. This class also flags a
 * block whose content changed remotely, when this client also edited
 * that block very recently: a highlighted background, with restore
 * controls and suppress controls. Refer to ContentBinding's conflict
 * handling for the trigger condition.
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

    constructor({ block, hub }) {
        this.block = block;
        this.hub = hub;
        this.wrapperEl = null;
        this.badgeEl = null;
        this.conflictEl = null;

        this._unsubscribePresence = null;
        this._unsubscribeConflict = null;
    }

    wrap(pluginsContent) {
        const wrapper = document.createElement('div');
        wrapper.classList.add('ce-collab-block');
        wrapper.appendChild(pluginsContent);

        this.badgeEl = document.createElement('div');
        this.badgeEl.className = 'ce-collab-badge';
        wrapper.appendChild(this.badgeEl);

        this.conflictEl = document.createElement('div');
        this.conflictEl.className = 'ce-collab-conflict';
        this.conflictEl.style.display = 'none';
        wrapper.appendChild(this.conflictEl);

        this.wrapperEl = wrapper;

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
    }

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
    }
}
