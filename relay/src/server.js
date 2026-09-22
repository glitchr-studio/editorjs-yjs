#!/usr/bin/env node
'use strict';

// This file is an authentication-gated y-websocket relay. This relay
// supports the real-time collaboration feature of editorjs-yjs.
// glitchr/base-bundle is the reference backend: it issues the tickets
// and receives the autosave requests (refer to README.md).
//
// Persistence method: a room's Y.Doc object exists in memory only. This
// relay has no database of its own. A content room, from editorjs-yjs,
// holds data in a `blocks` Y.Array. This relay sends this data to the
// app's own database, through a debounced POST request to
// ux_editorjs_autosave. This request uses service authentication. Refer
// to mintServiceToken below. This request does not use a user session,
// because this relay has no browser context and no CSRF context. A
// presence-only room, from a regular field through
// form-type-collab-presence.js, never writes data to `blocks`. Because
// of this, the room's Y.Doc object never sends an `update` event, and
// this persistence bridge never activates for that room. This design
// needs no separate rule for presence-only rooms. Refer to
// wss.on('connection', ...) below for this code.
//
// Version selection: this file uses version 2.x of y-websocket. Refer to
// package.json for the exact version. This choice is deliberate. The
// current "y-websocket" package, version 3.x, contains client code only.
// This client code targets yjs version 13. A separate new server
// package, "@y/websocket-server", targets yjs version 14. Version 14 is
// still a pre-release version. Version 14 is not wire-compatible with a
// yjs version 13 client. Version 2.x is the last version with both a
// client and a matched server, on the stable yjs version 13 line. To
// confirm this compatibility, this project installed both packages and
// checked the node_modules directory, before this file was written. This
// project did not assume this compatibility from documentation alone.
//
// Authentication method: the browser first sends a request to
// ux_editorjs_collabTicket. This action uses the Symfony session. This
// action uses CSRF protection. This action returns a short-lived ticket.
// The ticket has this format: base64url(payload) + "." +
// hmac_sha256(payload, COLLAB_TICKET_SECRET). The payload has this
// format: {uid, name, avatar, color, room, exp}. This relay checks the
// signature and the expiry time by itself. This relay does not send
// requests to PHP. This relay does not read the session store. Because
// of this, an operator must set the same COLLAB_TICKET_SECRET value in
// the app and in this relay. Use a separate secret for this value. Do
// not use the Symfony APP_SECRET value. This separation keeps session
// security and CSRF security apart from relay security, if an operator
// compromises the relay.

const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const WebSocket = require('ws');
const { setupWSConnection, getYDoc } = require('y-websocket/bin/utils');

const PORT = parseInt(process.env.COLLAB_RELAY_PORT || '1234', 10);
const SECRET = process.env.COLLAB_TICKET_SECRET;
const AUTOSAVE_URL = process.env.COLLAB_AUTOSAVE_URL || '';
const PERSIST_DEBOUNCE_MS = parseInt(process.env.COLLAB_PERSIST_DEBOUNCE_MS || '5000', 10);

// AUTOSAVE_URL holds the app's internal Docker address (e.g.
// http://web/ux/editorjs/autosave), not its public domain. This relay
// must send that request with a Host header matching the app's real
// public domain, or base-bundle's RouterSubscriber does not recognize it
// as a configured domain and silently redirects to the app's fallback
// host instead of handling it (confirmed live: a 302, then a 500 from
// that unrelated host). fetch()/undici treats "Host" as a forbidden
// header name and silently drops any attempt to set it through the
// headers option (confirmed live: the header simply never left this
// process) - persistRoom() below uses Node's low-level http.request()
// instead of fetch() specifically so this header takes effect.
// COLLAB_RELAY_WS_URL is reused here only to read the app's real public
// domain - it is already required for collab_live to activate at all.
const AUTOSAVE_HOST = (() => {
    try { return new URL(process.env.COLLAB_RELAY_WS_URL || '').hostname || null; }
    catch (e) { return null; }
})();
const TICKET_MAX_AGE_SKEW_S = 5; // This value is a small clock-skew allowance. This value is not a TTL extension.

if (!SECRET) {
    console.error('COLLAB_TICKET_SECRET is not set. This relay will not start. Every ticket would fail the signature check.');
    process.exit(1);
}
if (!AUTOSAVE_URL) {
    console.warn('COLLAB_AUTOSAVE_URL is not set. Live collaboration will still work. This relay will not save content to the app database.');
}

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/**
 * This function checks a ticket against the room the client wants to
 * join. This function returns the decoded payload on success. This
 * function returns null on failure. Failure cases: a bad signature, an
 * expired ticket, a malformed ticket, or a ticket for a different room.
 */
function verifyTicket(ticket, room) {
    if (!ticket || typeof ticket !== 'string') return null;

    const dot = ticket.lastIndexOf('.');
    if (dot < 0) return null;

    const payloadPart = ticket.slice(0, dot);
    const signaturePart = ticket.slice(dot + 1);

    const expectedSignature = crypto.createHmac('sha256', SECRET).update(payloadPart).digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const providedBuf = Buffer.from(signaturePart, 'hex');
    if (expectedBuf.length !== providedBuf.length) return null;
    if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) return null;

    let payload;
    try {
        payload = JSON.parse(base64urlDecode(payloadPart));
    } catch (e) {
        return null;
    }

    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || (Date.now() / 1000) > (payload.exp + TICKET_MAX_AGE_SKEW_S)) return null;
    // The ticket is valid for a different room. This function rejects
    // reuse of the ticket for this room.
    if (payload.room !== room) return null;

    return payload;
}

/**
 * This function expects this path format: /collab/<urlencoded room key>.
 * The room key itself already contains ":" characters, with this format:
 * fqcn:id:field:locale. Because of this, the URL carries the room key as
 * one encoded path segment. The URL does not split the room key across
 * separate segments.
 */
function roomFromPath(pathname) {
    const match = pathname.match(/^\/collab\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

/**
 * The room parameter has this format: "fqcn:id:field:locale". The fqcn
 * segment is a PHP namespace. A PHP namespace uses backslash characters.
 * A PHP namespace never uses a colon character. Because of this, a plain
 * split operation on the colon character is safe. This function returns
 * null for a string with a different format than
 * CollabRoomResolver::buildRoom()'s room key.
 */
function parseRoom(room) {
    const parts = room.split(':');
    if (parts.length !== 4) return null;
    const [fqcn, id, field, locale] = parts;
    return { fqcn, id, field, locale: locale === '_' ? null : locale };
}

/**
 * This function uses the same wire format as verifyTicket()'s tickets,
 * with no user fields. This relay signs its own short-lived token, to
 * authenticate its autosave POST request back to ux_editorjs_autosave.
 * The PHP method CollabTicketFactory::verifyServiceToken() checks this
 * token, against the same shared secret as the browser-facing tickets.
 */
function mintServiceToken(room) {
    const payload = { room, exp: Math.floor(Date.now() / 1000) + 30 };
    const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
    const signature = crypto.createHmac('sha256', SECRET).update(payloadB64).digest('hex');
    return payloadB64 + '.' + signature;
}

const persistTimers = new Map(); // This map holds a Timeout object for each room.
const lastKnownVersion = new Map(); // This map holds the version string from the last save attempt, for each room.
const instrumentedRooms = new Set(); // This set holds each room with an active update listener on its Y.Doc object.

async function persistRoom(room, doc) {
    persistTimers.delete(room);

    if (!AUTOSAVE_URL) return;

    const parsed = parseRoom(room);
    if (!parsed) return;

    const blocks = doc.getArray('blocks').toArray();
    // This room has no data yet, or this room is not a content room.
    if (blocks.length === 0) return;

    const value = JSON.stringify({ time: Date.now(), blocks });

    const body = JSON.stringify({
        serviceToken: mintServiceToken(room),
        room,
        fqcn: parsed.fqcn,
        id: parsed.id,
        field: parsed.field,
        locale: parsed.locale,
        value,
        baseVersion: lastKnownVersion.get(room) || null,
    });

    try {
        const { status, json } = await postAutosave(body);

        // A 409 response still carries the server's current version
        // value. This code adopts that value as the new baseline, in
        // every case. Without this step, a stale relay-side baseVersion
        // value would reject every later attempt. A stale value can
        // occur, for example, when a user saves the same content through
        // the plain browser autosave path, at the same time. The room's
        // live Yjs state stays authoritative for connected clients, in
        // every case, independent of the result of one persistence POST
        // request.
        if (json && json.version) lastKnownVersion.set(room, json.version);

        if (status < 200 || (status >= 300 && status !== 409)) {
            console.error(`collab relay: persistence POST for room ${room} failed with status ${status}`);
        }
    } catch (e) {
        console.error(`collab relay: persistence POST for room ${room} threw`, e);
    }
}

// fetch()/undici refuses to send a caller-supplied Host header (see the
// AUTOSAVE_HOST comment above) - this function uses http.request()
// instead, which has no such restriction, so AUTOSAVE_URL's internal
// Docker address can still resolve the real app while carrying the real
// public Host the app's router expects.
function postAutosave(body) {
    return new Promise((resolve, reject) => {
        const target = new URL(AUTOSAVE_URL);
        const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
        if (AUTOSAVE_HOST) {
            headers['Host'] = AUTOSAVE_HOST;
            headers['X-Forwarded-Proto'] = 'https';
        }

        const req = http.request({
            hostname: target.hostname,
            port: target.port || 80,
            path: target.pathname + target.search,
            method: 'POST',
            headers,
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch (e) { /* non-JSON body */ }
                resolve({ status: res.statusCode, json });
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function schedulePersist(room, doc) {
    if (persistTimers.has(room)) clearTimeout(persistTimers.get(room));
    persistTimers.set(room, setTimeout(() => persistRoom(room, doc), PERSIST_DEBOUNCE_MS));
}

const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }
    res.writeHead(404);
    res.end();
});

const wss = new WebSocket.Server({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
        url = new URL(req.url, 'http://internal');
    } catch (e) {
        socket.destroy();
        return;
    }

    const room = roomFromPath(url.pathname);
    const ticket = url.searchParams.get('ticket');
    const payload = room ? verifyTicket(ticket, room) : null;

    if (!payload) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        ws.collabUser = {
            id: payload.uid,
            name: payload.name,
            avatar: payload.avatar,
            color: payload.color,
        };
        wss.emit('connection', ws, req, room);
    });
});

wss.on('connection', (ws, req, room) => {
    // The getYDoc function is idempotent, through map.setIfUndefined.
    // This function returns the exact same WSSharedDoc object that
    // setupWSConnection() itself finds below. Because of this, this code
    // attaches the persistence listener here, once for each room,
    // through the instrumentedRooms set. This attachment works in every
    // connection order. The gc:true option activates Yjs's own tombstone
    // cleanup. This cleanup has no connection to this external
    // persistence bridge. This cleanup is compatible with this bridge.
    // This cleanup keeps memory use within a limit, for a long-lived room
    // with frequent changes.
    const doc = getYDoc(room, true);
    if (!instrumentedRooms.has(room)) {
        instrumentedRooms.add(room);
        doc.on('update', () => schedulePersist(room, doc));
    }

    setupWSConnection(ws, req, { docName: room, gc: true });

    // This code saves the room's data immediately when the room becomes
    // idle. This code does not wait for the full debounce time, on a
    // document with no active viewer.
    ws.on('close', () => {
        if (doc.conns.size > 0) return;
        if (persistTimers.has(room)) { clearTimeout(persistTimers.get(room)); persistTimers.delete(room); }
        persistRoom(room, doc);
    });
});

httpServer.listen(PORT, () => {
    console.log(`collab relay listening on :${PORT}`);
});

module.exports = { verifyTicket, roomFromPath, parseRoom, mintServiceToken };
