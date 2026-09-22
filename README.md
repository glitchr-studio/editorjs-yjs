# editorjs-yjs

This package adds real-time collaboration to
[Editor.js](https://editorjs.io). This package uses Yjs.

This package has three features:
- Whole-block content synchronization.
- Presence and awareness. This feature shows a colored cursor and a name
  badge on the block that a remote user has in focus.
- A conflict-highlight Block Tune. This Tune activates when two users edit
  the same block at the same time.

**This package is framework-agnostic.** This package needs only these
values: a WebSocket URL, a room name, a ticket (or a function that supplies
a ticket), and a user's display identity (a name and a color). This
package has no dependency on a specific backend. This package has no
dependency on a specific authentication method. A host application must
supply these values. A host application must also run a compatible relay.

Example host application:
[glitchr/base-bundle](https://gitlab.glitchr.dev/public-repository/symfony/bundles/base-bundle)'s
`EditorType`. This class creates tickets. This class finds the current
user's name and color. This class decides the room key.

Reference relay: [`relay/`](relay/), in this repository. This directory
contains an authentication-gated relay and a local docker-compose
demonstration. The relay is not part of the npm package. An app builds the
relay image from this repository, pinned to a commit. Refer to
[`relay/README.md`](relay/README.md).

## Installation

Run this command:
```sh
yarn add editorjs-yjs
```

This package needs an `@editorjs/editorjs` instance, version 2.24 or a
later version. This package needs this version for the typed `onChange`
block-mutation events. This package also needs a running relay. The relay
must support the `y-websocket` synchronization protocol and the
`y-websocket` awareness protocol.

## Usage

This package uses two-phase construction.

EditorJS needs the Block Tune inside its `tools` configuration before the
EditorJS instance exists. But the Tune needs an active hub for presence
data and conflict data. Because of this, create the `EditorYjs` object
first. The `EditorYjs` object exposes a `.Tune` property and an
`.onChange` property for the EditorJS configuration. Call `.attach()`
after the editor is ready.

```js
import EditorJS from '@editorjs/editorjs';
import EditorYjs from 'editorjs-yjs';

const collab = new EditorYjs({
    wsUrl: 'wss://your-host',       // bare origin — this package appends /collab/<room> itself
    room: 'some-opaque-room-id',       // this package does not parse this value
    getTicket: () => fetchTicketFromYourBackend(),
    user: { name: 'Marco', color: '#3a9bd9' },
});

const editor = new EditorJS({
    holder: 'editor-holder-id',
    tools: {
        paragraph: Paragraph,
        presence: { class: collab.Tune },
    },
    tunes: ['presence'],
    onChange: collab.onChange,
    onReady: () => collab.attach(editor, 'editor-holder-id'),
});

// Call this method later, to disconnect and release resources.
collab.destroy();
```

### Options

| Option              | Required | Description |
|----------------------|----------|-------------|
| `wsUrl`              | yes      | This is the relay's bare origin, with no path. This package appends `/collab/<room>` itself — do not add `/collab`, a room, or a ticket to this value. Example: `"wss://host"`. |
| `room`               | yes      | This is an opaque room identifier. This package does not parse this value. This package makes no assumption about this value. |
| `ticket`             | one of `ticket`/`getTicket` | This is a ready-made ticket string. |
| `getTicket`          | one of `ticket`/`getTicket` | This is a function with this signature: `async () => string`. This package calls this function for the first connection. This package also calls this function on a timer (`ticketRefreshMs`, default 45000 milliseconds). Because of this function, this package does not need information about ticket creation or ticket duration. |
| `user`               | yes      | This is an object with this format: `{ name, color, id? }`. This package sends this object through the awareness channel. This package shows this data on presence badges. |
| `conflictWindowMs`   | no       | This is a time value, in milliseconds. If a local edit to a block occurred inside this time window, this package treats a remote change to the same block as a live conflict. If a local edit did not occur inside this time window, this package accepts the remote value. The default value is 4000. |

## Operation

- **Content channel.** This package holds block data in a `Y.Array`. Each
  entry has this format: `{id, type, data}`. This is whole-block
  granularity, not character-level granularity. When two users edit
  *different* blocks, this package merges the changes automatically. This
  is the typical case. When two users edit the *same* block inside
  `conflictWindowMs`, the Block Tune shows a highlighted banner. This
  banner has two controls: **Keep mine** and **Accept theirs**. This
  package does not merge or overwrite the block silently.
- **Presence channel.** This package uses `y-protocols/awareness`, through
  `y-websocket`'s `WebsocketProvider.awareness` property. Each client
  sends this data: `{user, focusedBlockId, cursor}`. This package updates
  `focusedBlockId` through `focusin` events and `focusout` events on the
  editor holder. This package updates `cursor` through the document's
  `selectionchange` event, coalesced to one animation frame and ignored
  when the selection is outside the holder. This package finds the
  correct block through EditorJS's `blocks.getBlockByElement()` method.
- **Carets.** `cursor` has this format: `{blockId, anchor, head}`. The
  offsets are character counts inside the block's `contenteditable`,
  measured over text nodes in document order. On the receiving side, the
  Block Tune draws a caret in the other user's color at `head`, with a
  small flag on top so it stays findable, and shows the user's name on
  hover - and for a moment after each move. When `anchor` and `head`
  differ, the Tune tints the selected range too. The Tune re-resolves
  every caret when the block's content changes (a `MutationObserver` on
  the tool's element) and when the block's width changes (a
  `ResizeObserver` on the wrapper), so a caret stays in place through
  typing and reflow. This is not a CRDT position: this package syncs whole
  blocks, so there is no `Y.Text` to anchor to. A caret can therefore be
  briefly off between someone else's edit to that block and the owner's
  next `selectionchange`, which follows as soon as the edit reaches them.
- **Local-to-remote synchronization.** This package uses one debounced,
  full-state comparison for this direction. Refer to
  `ContentBinding.syncLocalToYArray`. This package does not use one
  update action for each EditorJS onChange event type. Refer to the long
  comment at the top of `src/ContentBinding.js` for the reason. In
  summary: real browser tests, not only code review, showed two problems.
  First, EditorJS's own `onChange` callback has an internal delay.
  Second, a block's `id` value is not always stable between its
  `block-added` event and its next `block-changed` event. These two
  problems broke an earlier, per-event method. That method created
  duplicate blocks without limit. The full-state comparison method does
  not have this problem.
- **Strict order between local changes and remote changes.** A remote
  update can arrive while a local edit is still inside its delay period.
  In this case, this package waits for the local edit to complete first.
  This package does not process the two changes at the same time. Tests
  during development showed data corruption when the two changes
  interleaved: this package read a half-typed block during a remote
  update.

## Known limitations

- This package supports only whole-block synchronization. This package
  does not support character-level synchronization in one block, as in
  Google Docs. Character-level synchronization needs a separate `Y.Text`
  binding for each tool type, similar to `y-quill` or `y-prosemirror`.
  This work is a much larger task.
- An empty DOM block can remain on the screen after EditorJS reassigns a
  new block `id`. This event can occur on a block that a user just
  created. Example: a user creates a block with the Enter key, then types
  text into the block; EditorJS can then assign a different `id` value
  than the `block-added` event reported. This problem affects only the
  screen. This problem does not affect saved data: the `editor.save()`
  output is correct. The cause of this problem is not yet known.

## Local test harness

The `example/` directory contains two real EditorJS instances on one page.
Each instance uses this package. Both instances join the same room. Type in
one pane; the other pane follows.

Run this command:
```sh
make demo       # Then open this address: http://localhost:8089
```

This command needs Docker. This command needs nothing else: no local Node,
no global installs. This command starts two containers. The first container
is a websocket relay. The second container builds `example/client.js` and
serves `example/`. The build step rebuilds on request, so a change to
`src/` or to `example/` needs only a page reload.

Run `make` alone for the full target list. Run `make stop` to stop the
demo. Run `make clean` to also remove the dependency volume.

If port 1234 is already in use, run this command instead:
```sh
make demo RELAY_PORT=1235
# Then open this address: http://localhost:8089/?ws=ws://localhost:1235
```
The browser reaches the relay directly, so the page cannot discover a
remapped port on its own. The `?ws=` parameter supplies it.

The relay in this demo is `y-websocket`'s own bundled server, not
the reference [`relay/`](relay/). This package assumes nothing
about the backend, so its demo must not require a particular one. That
server ignores the ticket, which suits a demo. To exercise a real
ticket-checking relay, start that relay and pass its address through the
same `?ws=` parameter. The reference relay accepts the demo's tickets when
it runs with `COLLAB_TICKET_SECRET=dev-secret`, as in
`relay/docker-compose.yml`.

The example creates a false ticket inside the browser. This ticket uses a
Web Crypto HMAC signature. This ticket uses a shared `dev-secret` value.
This method replaces the host app's real ticket endpoint, for this
demonstration only. Refer to `example/client.js` for this code.
