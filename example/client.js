// This file is the editorjs-yjs test harness. This file creates two real
// EditorJS instances, on one page. Each instance uses editorjs-yjs
// separately. Both instances connect to the same collab room, over a
// separate collab-relay instance. You must run this relay instance
// yourself. This file creates a false ticket inside the browser, through
// a Web Crypto HMAC signature, against a shared dev secret. This method
// matches collab-relay's own example/client.js file. This method
// replaces the host app's real ticket endpoint, because editorjs-yjs
// makes no assumption about that endpoint.
import EditorJS from '@editorjs/editorjs';
import Header from '@editorjs/header';
import Paragraph from '@editorjs/paragraph';
import EditorYjs from '../src/index.js';

// The relay's origin. `localhost` was hard-coded here, which breaks in two
// ordinary cases: opening the demo from another machine on the network, and
// remapping the relay's port because 1234 is already taken. So: an explicit
// global wins, then a `?ws=` query parameter, then the page's own host on the
// default port - which is what `localhost` used to mean anyway.
const WS_URL = window.COLLAB_DEMO_WS_URL
    || new URLSearchParams(window.location.search).get('ws')
    || 'ws://' + (window.location.hostname || 'localhost') + ':1234';
// This code creates a fresh, unpredictable room, for each page load.
// This method avoids a problem: an old browser tab, from an earlier
// manual test, can stay connected to a fixed room name, and that tab can
// send stale data into this new session.
const ROOM = 'demo\\EditorYjs:1:content:' + Math.random().toString(36).slice(2);
const DEV_SECRET = window.COLLAB_DEMO_SECRET || 'dev-secret';

function base64url(buf) {
    let str = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(buf) {
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function mintDevTicket(room, user) {
    const payload = { uid: user.id, name: user.name, avatar: null, color: user.color, room, exp: Math.floor(Date.now() / 1000) + 300 };
    const payloadB64 = base64url(new TextEncoder().encode(JSON.stringify(payload)));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(DEV_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
    return payloadB64 + '.' + toHex(sig);
}

async function createInstance(paneEl, user) {
    const holderId = 'editor-' + user.name;
    const holderEl = paneEl.querySelector('.editor-holder');
    holderEl.id = holderId;

    const collab = new EditorYjs({
        wsUrl: WS_URL,
        room: ROOM,
        getTicket: () => mintDevTicket(ROOM, user),
        user: { id: user.id, name: user.name, color: user.color },
    });

    const editor = new EditorJS({
        holder: holderId,
        tools: {
            header: Header,
            paragraph: Paragraph,
            presence: { class: collab.Tune },
        },
        tunes: ['presence'],
        onChange: collab.onChange,
        onReady: () => collab.attach(editor, holderId),
        data: { blocks: [] },
        autofocus: false,
    });

    collab.provider.on('status', (e) => {
        const statusEl = paneEl.querySelector('.status');
        statusEl.textContent = e.status;
        statusEl.className = 'status status--' + e.status;
    });

    window['collab_' + user.name] = collab; // This code exposes this object, for eval-based test checks.
}

document.querySelectorAll('.pane').forEach((paneEl) => {
    createInstance(paneEl, { id: paneEl.dataset.name, name: paneEl.dataset.name, color: paneEl.dataset.color });
});
