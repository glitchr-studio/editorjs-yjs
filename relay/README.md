# editorjs-yjs relay

This is an authentication-gated WebSocket relay. The relay makes real-time
collaboration possible for `editorjs-yjs`. The relay uses the
[y-websocket](https://github.com/yjs/y-websocket) protocol.

The relay needs a backend for two things only: the backend issues the
tickets (refer to "Authentication method") and receives the content to
save (refer to "Persistence contract"). glitchr/base-bundle is the
reference backend. In glitchr/base-bundle, two features use the relay:
- The `collab_live` option of `EditorType`.
- The `collab: "live"` option of `FormTypeCollabExtension`, for regular
  fields.

A content room is a room with data in the `blocks` Y.Array. EditorJS fields
use content rooms, through the `editorjs-yjs` package. The relay sends the
content of a content room to the app database. The relay sends this content
on a timer. The relay sends this content through a service-authenticated
POST request to `ux_editorjs_autosave`.

A presence room is a room with no data in the `blocks` Y.Array. Regular
fields use presence rooms. The relay does not send data from a presence
room to the app database, because the room has no `blocks` data. Refer to
`persistRoom` and `schedulePersist` in `src/server.js` for this logic.

This relay is in the `relay/` directory of the `editorjs-yjs` repository.
The relay is not part of the npm package: the `files` list in the root
`package.json` does not include `relay/`. An app builds the relay image
directly from the repository, with a Docker git build context. The app
pins the build context to a commit. Refer to "Deployment with the app".

## Why the relay is necessary

In this project, Symfony Messenger uses only the Doctrine transport. The
Doctrine transport reads the database on a timer. This method is correct
for background jobs. This method is not correct for presence data or
cursor data, because these data types need updates in less than one
second.

This project has no Mercure infrastructure. This project has no other
publish-subscribe infrastructure.

The relay is small. The relay stores no persistent data of its own. An app
that does not use the `collab_live` option does not need to deploy the
relay.

## Authentication method

The browser sends a request to `ux_editorjs_collabTicket`. This request
uses the Symfony session. This request uses CSRF protection. The response
contains a ticket. The ticket is valid for a short time only.

The ticket has this format:
```
base64url(json_payload) + "." + hex(hmac_sha256(json_payload, COLLAB_TICKET_SECRET))
```

The `json_payload` data has these fields: `uid`, `name`, `avatar`, `color`,
`room`, `exp`.

The relay checks the ticket signature and the ticket expiry time by itself.
The relay does not send requests to PHP. The relay does not read the
session store. Because of this, `COLLAB_TICKET_SECRET` must have the same
value in the app and in the relay.

Use a separate secret for `COLLAB_TICKET_SECRET`. Do not use the Symfony
`APP_SECRET` value. This keeps session security and CSRF security separate
from relay security, if an operator compromises the relay.

A client connects to this address:
`wss://<host>/collab/<urlencoded room>?ticket=<ticket>`.

The relay sends a `401` response and closes the connection in these cases:
- The ticket is not present.
- The ticket has expired.
- The ticket signature is not correct.
- The ticket is valid for a different room.

## Persistence contract

The relay sends the content of a content room with a `POST` request to
`COLLAB_AUTOSAVE_URL`. The request body is JSON, with these fields:

| Field          | Description |
|----------------|-------------|
| `serviceToken` | This is a token that the relay signs itself. The token has the same format as a ticket. The payload has only `room` and `exp` (30 seconds). The backend checks the signature with `COLLAB_TICKET_SECRET`. |
| `room`         | This is the room name: `<fqcn>:<id>:<field>:<locale>`. The value `_` means "no locale". |
| `fqcn`, `id`, `field`, `locale` | These are the four parts of `room`. `locale` is `null` for `_`. |
| `value`        | This is the EditorJS JSON document, as a string: `{"time": ..., "blocks": [...]}`. |
| `baseVersion`  | This is the last `version` value that the backend returned for this room, or `null`. |

The backend returns JSON with a `version` field. The relay keeps this
value and sends it back as `baseVersion` in the next request. A `409`
response means that the version is not current. The relay also keeps the
`version` value of a `409` response.

The relay sends the request with the `Host` header set to the host of
`COLLAB_RELAY_WS_URL`, and with `X-Forwarded-Proto: https`. Because of
this, the backend routes the request as a request to its public domain.

## Environment variables

| Variable                     | Required | Description |
|--------------------------------|----------|-------------|
| `COLLAB_TICKET_SECRET`       | yes      | This is the HMAC secret. The app must use the same secret. The relay also uses this secret to sign its own requests to `ux_editorjs_autosave`. |
| `COLLAB_RELAY_PORT`          | no       | This is the listen port. The default value is `1234`. |
| `COLLAB_AUTOSAVE_URL`        | no       | This is the full URL of the app's `ux_editorjs_autosave` action. Example: `http://web/ux/editorjs/autosave`. Use the app's internal Docker network address. Do not use the public proxy address. If this variable is not set, live collaboration still works, but the relay does not save content to the database. |
| `COLLAB_PERSIST_DEBOUNCE_MS` | no       | This is the wait time, in milliseconds, before the relay saves a quiet content room. The default value is `5000`. The relay also saves a room immediately when the last client disconnects. |

The app also needs the `COLLAB_RELAY_WS_URL` variable. This variable holds
the public `wss://` address for client connections. This value is the bare
origin only, with no `/collab` path — the browser client appends
`/collab/<room>` itself. Example: `wss://your-host`, not
`wss://your-host/collab`. The `CollabTicketFactory::isConfigured()` method
keeps the `collab_live` option inactive until the app sets both
`COLLAB_TICKET_SECRET` and `COLLAB_RELAY_WS_URL`. While the option is
inactive, the app does not create tickets.

## Deployment with the app

Add a service to the app's `docker-compose.yml` file. Docker builds the
image from the `relay/` directory of this repository, at the pinned commit.
The Docker host must reach gitlab.glitchr.dev when it builds the image. Use the same format
as the `search` service and the `minio` service.

Connect the service to the `extranet` network, because browsers connect to
the relay directly. Do not use only the `intranet` network, as with the
`minio` service.

Also connect the service to the `intranet` network. The relay needs this
network to reach the `web` service for the persistence bridge.

```yaml
  collab:
    container_name: ${APP_NAME}-collab
    build:
      # Pin the commit. Use the same commit for every environment.
      context: https://gitlab.glitchr.dev/public-repository/javascript/editor-js/yjs.git#<commit>:relay
    restart: unless-stopped
    environment:
      COLLAB_TICKET_SECRET: ${COLLAB_TICKET_SECRET}
      COLLAB_AUTOSAVE_URL: http://web/ux/editorjs/autosave
    networks:
      - extranet
      - intranet
```

Add a WebSocket-upgrade location to the file
`deployments/docker/proxy/conf.d/default.conf`. Add this location inside
the existing `server { listen 443 ssl ... }` block. This block already
sets the `Upgrade` header and the `Connection` header for all locations.
Because of this, the new location needs only the `proxy_pass` directive.

```nginx
    location /collab/ {
        proxy_cache off;
        set $collab http://collab:1234;
        proxy_pass $collab;
    }
```

Set the `COLLAB_RELAY_WS_URL` variable to `wss://<your-host>` (no `/collab` suffix). Set
the same `COLLAB_TICKET_SECRET` value in the app's `.env.local` file.

## Local development

```sh
npm install
COLLAB_TICKET_SECRET=dev-secret npm start
```

The `GET /health` request returns a `200 ok` response when the relay is
active. Use this request for the Dockerfile `HEALTHCHECK` instruction. Use
this request also for a quick manual check.

## Local demonstration

This demonstration does not need the Symfony app. This demonstration uses
only the relay and a browser page.

The file `docker-compose.yml` in this directory starts the relay and a
static demo page. This file is not the production configuration. Refer to
the section "Deployment with the app" for the production configuration.

Run this command:
```sh
docker compose up --build
```

Open this address: http://localhost:8088.

The page shows two users, "Marco" and "Sasha". Each user has a separate
`Y.Doc` object and a separate `WebsocketProvider` connection. Both
connections use the same room. The two users appear side by side on one
page. This layout represents two separate browser tabs.

Type a message in one pane. The message appears immediately in the other
pane. Each pane also shows a colored badge for the other user.

This demonstration uses the content-sync channel and the awareness
channel. These are the same two channels that the `editorjs-yjs` package
uses. This demonstration uses the raw `yjs` and `y-websocket` client APIs
directly. This demonstration does not use the `editorjs-yjs` package. Use
this demonstration to check the relay by itself.

The file `example/client.js` creates its own ticket inside the browser.
This file uses the Web Crypto API for the HMAC signature. This file uses
the same `dev-secret` value as the `docker-compose.yml` file. This method
is only for this demonstration. When the Symfony app is present,
`ux_editorjs_collabTicket` is the only correct ticket source.

After a change to `example/client.js`, run this command:
```sh
npm run example:build
```

This command uses esbuild. This command uses the same `yjs` version and
`y-websocket` version as the relay. Because of this, the demonstration
always matches the current relay code.

Run this command to stop the demonstration:
```sh
docker compose down
```
