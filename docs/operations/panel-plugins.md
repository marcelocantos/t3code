# Sidebar panel plugins

## Install the macOS plugin build

Download the Apple Silicon DMG from [this fork's releases](https://github.com/marcelocantos/t3code/releases), open it, and drag **T3 Code Plugins.app** to Applications. This unsigned build may require approval in **System Settings → Privacy & Security → Open Anyway** after the first launch attempt.

The fork runs alongside the official app. Its data lives in `~/.t3-plugins/userdata` and its browser profile in `~/Library/Application Support/t3code-plugins`. It starts with a separate workspace list; add your existing project directories. Automatic updates are disabled for this build; install subsequent releases from the same release page. Do not set `T3CODE_HOME` to the official app's data directory.

Use this fork's desktop app or bundled web client for panels; official T3 clients do not include the panel renderers. Both desktop apps register the upstream `t3code` link scheme, so external sign-in/deep links can open either app. Direct environment connections avoid that ambiguity.

A plugin that advertises itself (see [Discovery](#discovery)) appears in **Settings → Plugins**; nothing needs configuring by hand. The URL it advertises is resolved by the T3 environment hosting the thread, so a loopback address refers to that machine. T3 does not bundle or launch any plugin: each one is a service its own project runs.

## Build modes

`T3CODE_PLUGIN_BUILD` selects the packaging variant. Set the same value for both `vp run build:desktop` and `vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 --skip-build`; the build rejects any other value.

| Value     | Variant              | App identity                                            | State                                     | Updates          |
| --------- | -------------------- | ------------------------------------------------------- | ----------------------------------------- | ---------------- |
| unset     | Upstream             | `com.t3tools.t3code`, **T3 Code (Beta)**                | `~/.t3`, `t3code-v2` profile              | Upstream feed    |
| `1`       | Parallel (above)     | `com.marcelocantos.t3code.plugins`, **T3 Code Plugins** | `~/.t3-plugins`, `t3code-plugins` profile | No feed          |
| `upgrade` | In-place replacement | `com.t3tools.t3code`, **T3 Code (Beta)**                | `~/.t3`, `t3code-v2` profile              | Disabled in code |

The `upgrade` build is for replacing an installed official app with this fork while keeping its settings, projects, threads, browser profile and Keychain entry name. It shares the official bundle identifier, package name, product name and state paths, so installing it over `T3 Code (Beta).app` continues the same installation. Plugin configuration lives in its own files and this mode adds no schema of its own. The merged upstream code may still migrate the shared database, which an older official build may not open, so keep the backup until the new build has proven itself. A build signed with a different identity than the installed app may prompt for Keychain access.

The updater is switched off by the build itself, not only by the absence of a publish feed: the packaged app carries no `app-update.yml`, and the desktop refuses to configure or check any feed, including a managed-policy or mock feed. Otherwise an official release could replace the fork without notice. About shows "Plugin panels build" to tell the two apart.

Back up `~/.t3` and `~/Library/Application Support/t3code-v2` before the first launch. Chromium and the SQLite database are not safe to share between two running versions, so quit the old app first. This repository does not take or verify backups.

### Mobile

`T3CODE_PLUGIN_BUILD=1` gives the mobile app the matching identity: `com.marcelocantos.t3code.plugins`, **T3 Code Plugins**, scheme `t3code-plugins`, signed by the maintainer's Personal Team. It installs beside the store app and never checks the upstream OTA feed. A Personal Team cannot sign extension targets, App Groups, push or associated domains, so the build has no widgets, share extension or push notifications, and `app.t3.codes` links keep opening the official app. `upgrade` is rejected on mobile because the official identifiers only sign inside T3's team.

Both builds bundle the JavaScript, so no Metro server is needed. Run them from `apps/mobile`.

Android release APK:

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
T3CODE_PLUGIN_BUILD=1 APP_VARIANT=production EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform android
(cd android && ./gradlew assembleRelease)
"$ANDROID_HOME"/build-tools/37.0.0/apksigner sign --ks ~/.local/state/t3-fork-android.keystore \
  --out t3-code-plugins.apk android/app/build/outputs/apk/release/app-release.apk
adb -s <serial> install -r t3-code-plugins.apk
```

Gradle signs the release with the template's debug key. Re-sign with a keystore kept outside the repository so later installs upgrade in place instead of failing on a signature change.

iOS on a physical device:

```bash
T3CODE_PLUGIN_BUILD=1 APP_VARIANT=production EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform ios
DERIVED="${TMPDIR:-/tmp}/t3-code-plugins-ios"
xcodebuild -workspace ios/T3CodePlugins.xcworkspace -scheme T3CodePlugins -configuration Release \
  -destination "id=<hardware udid>" -allowProvisioningUpdates -derivedDataPath "$DERIVED" build
xcrun devicectl device install app --device <coredevice id> "$DERIVED"/Build/Products/Release-iphoneos/T3CodePlugins.app
```

Keep derived data outside the repository: Swift package checkouts under it carry TypeScript that `vp run typecheck` would otherwise pick up. `xcodebuild` takes the hardware UDID and `devicectl` the CoreDevice identifier; `xcrun devicectl list devices` shows both. The first launch needs the developer profile trusted under Settings → General → VPN & Device Management.

Both builds read the public relay and Clerk values from the environment, like the release workflow does from `.env.example`: set `T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY` and `T3CODE_CLERK_JWT_TEMPLATE` for the prebuild, or T3 Connect sign-in has nothing to talk to. Sign in with an email code: T3's Clerk instance only accepts the official apps' OAuth callback URLs, so Google, Apple, GitHub and Microsoft sign-in fail with a redirect URL error in the fork. Direct pairing from the desktop's Settings → Sharing & access also works once that environment has Network access on.

## Discovery

A plugin running on the same machine as a T3 environment can advertise itself instead of being
configured by hand. Discovery runs on the environment that hosts the thread, so web, desktop and
mobile clients, local or remote, see the same offers through their existing connection and permissions.

**Advertise.** Write one JSON file into `$XDG_DATA_HOME/t3code/plugins/` (`~/.local/share/t3code/plugins/`
when `XDG_DATA_HOME` is unset or not an absolute path), and write it atomically: create a temporary file
in the same directory beginning with `.`, then rename it. Keep the directory private to the user (mode
`0700`; T3 ignores a directory other users can write), remove the file when the service stops, and
replace it only if it still holds what you wrote. Files left by a crashed service are harmless: they
fail the probe below and are ignored.

The file is named after the plugin's identity: `host+owner+repo.json`, optionally `host+owner+repo+instance.json`.
Give each simultaneously running instance its own `instance` (for example its port) so they never
share a file. T3 ignores a file whose name does not decode to the manifest's `id`.

```json
{
  "protocol": 1,
  "id": "github.com/example/example",
  "name": "Example",
  "connection": { "kind": "server", "baseUrl": "http://127.0.0.1:49152/plugins/t3" }
}
```

(for example `github.com+example+example+49152.json`)

- `id` is the plugin's stable identity: the `host/owner/repo` of the project that runs it, in lowercase
  (`github.com/example/example`). The host is a DNS name; owner and repo are letters, digits, `.`,
  `_` and `-`, starting with a letter or digit; the whole id is at most 128 characters. `+` never occurs
  in an id, so replacing `/` with `+` gives the file name without ambiguity, and two ids can never share
  a name. `instance` is 1 to 32 characters of `a-z`, `0-9`, `.`, `_` and `-`. The id becomes the plugin id in panels
  (including the `pluginId` of filter selections), and a user's decision is remembered under it.
- `name` is the display name, at most 128 characters.
- `connection.kind` must be `"server"`. A discovered file can never name a command: T3 does not start
  discovered programs. Managed sidecars remain a hand-written configuration.
- `baseUrl` is the plugin's panel endpoint described below. Discovered endpoints must be `http` on
  `127.0.0.1`, `localhost` or `[::1]` with an explicit port, no credentials, query or fragment.
- Files are limited to 4 KiB, T3 reads at most 32 files per directory, and unknown properties are
  ignored. Symbolic links and anything that is not a regular file are skipped.

**Probe.** Before offering a plugin, T3 sends a plain `GET` to `baseUrl` with `Accept: application/json`
and no `Upgrade` header, cookies, thread or workspace. The plugin must answer `200` with a JSON content
type and a body of at most 48 KiB:

```json
{ "protocol": 1, "id": "github.com/example/example", "name": "Example" }
```

`id` and `name` must equal the manifest's. Redirects, other statuses and unreachable endpoints mean
the advertisement is stale and it is ignored. The same route's WebSocket upgrade is the
[protocol](#protocol-version-1) connection and is unaffected.

**Consent.** T3 re-checks advertisements when the directory changes and every ten seconds while a
client is connected. New plugins appear in **Settings → Plugins**, which explains why it opened:
the first time a desktop or web client sees an undecided plugin, it opens that page once; a plugin
found later in the session gets a "New plugin found" notice instead. Mobile shows a count on its
Plugins settings row. Select plugins and choose **Enable selected** (the unselected ones are
dismissed) or **Not now** (nothing is decided). Nothing connects, and no workspace or thread reaches
the plugin, until the user enables it. Enabling saves the endpoint the user saw, and the scopes it
declared, to `plugin-discovery.json` beside `settings.json` and shows its panels without a restart.
The choice requires the `settings:write` permission; viewing requires only `orchestration:read`.

- **Dismiss** is remembered per plugin id across restarts and endpoint changes; the plugin is not
  offered again until the user chooses **Ask again**.
- **Disable** removes the panel but remembers the endpoint, so **Enable** works again even while the
  plugin is not running. **Forget** returns it to the undecided state.
- If an enabled plugin advertises a different endpoint (for example it restarted on another port), T3
  keeps using the endpoint the user approved and offers **Switch** or **Keep current**. A changed
  endpoint is never trusted silently.
- If an enabled plugin starts declaring a scope the user did not approve, such as `environment`
  (which reveals every project root), T3 keeps the approved scopes and asks again with **Allow**.
  Dropping a scope needs no consent.
- When several instances advertise one id, the newest advertisement is offered; each live endpoint
  can still be enabled by its own address.
- A plugin in `panel-plugins.json` takes precedence over a discovered one with the same id, and T3
  never rewrites that file. A hand-written entry may use any id (a short one such as `example` keeps
  working); it is a different plugin from the advertised `github.com/...` identity, so a service that
  accepts filter selections should treat its old short id as an alias of its canonical one.

## Configure other installations

A plugin runs outside T3 Code and supplies live, thread-scoped sidebar sections over a
WebSocket. T3 connects from the environment hosting the thread and relays snapshots over its
authenticated client connection. A remote browser or phone never connects to a localhost
plugin directly. Web and desktop show sections in thread details; mobile shows them below
the thread list in the sidebar for the selected thread.

Configure the environment's `panel-plugins.json` beside `settings.json` in its userdata
folder. Configuration is read when a sidebar subscribes and when a discovery decision changes: close and reopen the sidebar after editing the file.
This file is environment-owned because sidecar commands execute with the server's privileges.
Repository `t3.json` does not install or execute plugins.

```json
[
  {
    "id": "example",
    "connection": {
      "kind": "sidecar",
      "command": "node",
      "args": ["/path/to/t3code/apps/server/scripts/plugin-spa-demo.mjs"]
    }
  }
]
```

This source example needs the checkout's dependencies. It demonstrates managed sidecars;
an independently running service uses the server connection below instead.

To connect to an existing plugin server, replace `connection` with:

```json
{ "kind": "server", "baseUrl": "https://plugins.example.test/panels" }
```

The base URL identifies the WebSocket endpoint itself: the path and query are preserved,
`http` becomes `ws`, and `https` becomes `wss`. There is no appended discovery path.
Existing servers remain running after T3 disconnects. Remove the configuration entry to
remove the plugin on the next subscription.

## Protocol version 1

A managed sidecar binds a random loopback port and writes one newline-terminated readiness
record to stdout within ten seconds:

```json
{ "type": "ready", "protocol": 1, "url": "ws://127.0.0.1:49152" }
```

Other stdout lines and stderr are drained as diagnostics. T3 shares one process and socket
per plugin configuration across all subscribing threads. After the last subscription leaves,
a short grace period allows filter changes to reuse it; then T3 closes the socket and sends
SIGTERM, escalating to SIGKILL if needed. Disconnections restart managed processes or reconnect
to existing servers every second while a subscription remains. Plugins must accept replayed
subscriptions after reconnect and provide a fresh snapshot.

T3 sends:

```json
{
  "type": "subscribe",
  "protocol": 1,
  "subscriptionId": "opaque-id",
  "threadId": "thread-id",
  "cwd": "/workspace",
  "filters": []
}
```

A filter selection adds `{ "pluginId": "example", "panelId": "targets", "filter": "all" }`
to `filters`. Unsubscription sends `{ "type": "unsubscribe", "subscriptionId": "opaque-id" }`.
The plugin responds with a complete replacement snapshot for that subscription:

```json
{
  "type": "panels",
  "subscriptionId": "opaque-id",
  "panels": [
    {
      "id": "targets",
      "title": "Example",
      "rows": [{ "id": "row-1", "label": "A row", "detail": "Optional detail" }],
      "filters": [
        { "id": "frontier", "label": "Frontier" },
        { "id": "all", "label": "All" }
      ],
      "filter": "frontier"
    }
  ]
}
```

An empty `panels` array removes all panels for that subscription. IDs are scoped to plugin
and thread; do not reuse panel or row IDs within a snapshot. Panels without a `kind` remain native lists for backwards compatibility.
Use `kind: "web"` for the isolated SPA renderer described below.

Frames are limited to 1 MiB, snapshots to 20 panels, and panels to 2,000 rows. Malformed
frames disconnect the plugin and show an error. Plugins should validate all incoming messages
and bind locally unless deliberately deployed remotely. The example rejects browser Origins;
a separately deployed plugin must provide its own transport access controls.

## Row actions, surfaces and environment panels

These additions keep `protocol: 1`. A plugin that sends none of the new fields behaves exactly as before.

**Rows** may carry `badges` (`{ "label", "tone"? }`, tones `default`, `muted`, `info`, `success`,
`warning`, `danger`), `actions`, a `primaryActionId` shown as a visible button, a `hoverSurfaceId`
fetched as a hover card, and, in environment panels, `navigate: { "projectIds": [...] }`. Every other
action appears in the row's `…` menu. Action kinds:

| `kind`    | T3 does                                                                                                                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`   | Sends `prompt` to the thread as the user's own message, then offers Stop while that run is active. Thread panels only; needs `orchestration:operate`. The plugin never sees it.                                        |
| `plugin`  | Sends an `action` frame. `confirm` asks the user first.                                                                                                                                                                |
| `date`    | Offers Tomorrow, the day after tomorrow (by weekday name), Next week (the coming Monday), Custom… and, when `value` is set, Clear (`clearLabel`). The value is a local calendar date `YYYY-MM-DD`, or `null` to clear. |
| `surface` | Requests surface `surfaceId` for the row and opens it as a dialog (`modal: true` blocks the panel).                                                                                                                    |
| `menu`    | A submenu of the kinds above.                                                                                                                                                                                          |

**Surfaces** are structured content T3 renders: `{ "title", "blocks", "width"? }` with blocks `heading`,
`text`, `fields`, `list` (an item with `surfaceId` opens a child card anchored to it and sends the item
id), `form` (submitting sends `actionId` with `{ fieldId: value }`), and `actions` (buttons). Children
close with their parent. A plugin never supplies executable UI to T3's page.

**Requests.** T3 sends:

```json
{ "type": "action", "requestId": "r1", "scope": "thread", "threadId": "…", "cwd": "/workspace",
  "panelId": "targets", "rowId": "T12", "actionId": "due", "surfaceId": "details", "value": "2026-11-12" }
{ "type": "surface", "requestId": "r2", "scope": "thread", "threadId": "…", "cwd": "/workspace",
  "panelId": "targets", "rowId": "T12", "surfaceId": "details", "itemId": "T9" }
```

`surfaceId`, `value` and `itemId` are omitted when not applicable. The plugin answers each with
`{ "type": "result", "requestId": "r1", "ok": true, "surface"?: {…}, "close"?: true }` or
`{ "type": "result", "requestId": "r1", "ok": false, "error": "Shown to the user" }`. A surface request
must answer with a `surface`. For an action, `close` closes the surface it came from and `surface`
opens a child of it (or a dialog for a row action). T3 waits ten seconds and allows 64 outstanding
requests per connection; a result for an unknown request is ignored. Push a fresh `panels` snapshot
after a change rather than waiting for your own refresh cycle. Actions need `orchestration:operate`;
surfaces need `orchestration:read`.

**Scopes.** A plugin declares where its panels go with `"scopes": ["thread", "environment"]` in its
discovery probe answer, or in its `panel-plugins.json` entry. The default is `["thread"]`, so an older
plugin never receives the frames below. Thread panels sit in thread details; environment panels sit
in the left sidebar. An environment subscription has no thread:

```json
{
  "type": "subscribe",
  "protocol": 1,
  "scope": "environment",
  "subscriptionId": "opaque-id",
  "projects": [{ "projectId": "…", "title": "t3code", "cwd": "/work/t3code" }],
  "filters": []
}
```

`projects` lists the environment's unarchived projects. When it changes, T3 sends `subscribe` again
with the same `subscriptionId`; treat that as a replacement. Environment `action` and `surface` frames
carry `"scope": "environment"` and the same `projects` instead of `threadId` and `cwd`, so encode
enough in row ids to find your data. A row's `navigate.projectIds` lets T3 open a thread of one of
those projects, ask the user to choose when several exist, or offer a new thread. Environment web
panels receive neither `x-t3-thread-id` nor `x-t3-workspace`.

## Link cards

A plugin can show a card when the user hovers or focuses a chat link it recognizes, for example a
staff profile or a message viewer. On mobile, tapping the link shows the card with an Open link button. It needs no panels. Declare the `links` scope and up to 16 link
prefixes in the probe answer or the `panel-plugins.json` entry:

```json
{
  "scopes": ["links"],
  "links": [{ "id": "message", "prefix": "https://viewer.example/msg/" }]
}
```

A prefix is an absolute `http` or `https` URL with a path (at most 2,048 characters); a malformed
one is ignored. A link whose URL starts with a prefix gets the card, the longest prefix winning;
clicking it still opens the link. Adding `links` to an enabled plugin's scopes asks the user again,
like `environment`; changing the prefixes does not. T3 keeps a plugin with link prefixes connected
while a client is open, and lists its prefixes to clients only while it is connected.

On hover T3 sends a request with no thread or projects, after checking the URL against the prefix:

```json
{
  "type": "surface",
  "requestId": "r3",
  "scope": "link",
  "linkId": "message",
  "url": "https://viewer.example/msg/42"
}
```

Answer with a structured `surface`, or with `"web": { "path": "/cards/msg/42", "height"?: 160 }`, a
page on the plugin's own origin that T3 shows in a sandboxed frame through the gateway (heights
80–800 px). Card pages receive neither `x-t3-thread-id` nor `x-t3-workspace`, the path cannot carry
a query, and assets should be relative or inline. Web cards need `orchestration:operate`; structured
cards need only `orchestration:read`. Cards are read-only: actions in them are not run. Clients
cache a URL's card for the page session.

## Embedded web applications

A plugin may also send a web panel alongside native lists:

```json
{ "kind": "web", "id": "dashboard", "title": "Dashboard", "path": "/app/", "height": 420 }
```

`path` is a directory ending in `/` on the **same origin as the plugin's WebSocket**.
The plugin serves its HTML at that directory. T3 replaces the path with a temporary gateway
capability before sending it to clients. HTML, styles, module scripts, dynamic imports, HTTP
API calls, and WebSocket connections all travel through that gateway, including on remote
web, desktop, and mobile clients. The capability is scoped to this subscription and panel;
removing the panel, losing the plugin connection, or closing the subscription revokes it and
closes active requests and sockets. Do not persist or share gateway URLs.

Build the SPA with relative asset URLs and a relative base, for example `./main.js`,
`import('./chunk.js')`, and `fetch('./api/context')`. Use a hash router, or keep all paths within
the panel's directory. Absolute `/api` and `/assets` paths address T3, not the plugin. For a
WebSocket, resolve a relative path against `location.href` and change `http:` to `ws:` or
`https:` to `wss:`. External origins and redirects are not supported.

Each upstream HTTP request and socket handshake receives `x-t3-thread-id` and
`x-t3-workspace` (the workspace is URI-component encoded). Use these server-supplied values to
scope data; do not trust a client-provided thread identifier in an API payload. T3's cookies,
authorization, DPoP and other client headers are not forwarded. Plugin response cookies are
also discarded. Store state in the plugin backend, keyed by thread.

Web panels run in an opaque-origin sandbox with scripts and forms enabled. They cannot read
T3's DOM, cookies, local storage, or credentials. Local storage, service workers, popups,
embedding other frames, arbitrary external resources and JavaScript `eval` are unavailable.
The gateway's response CSP applies even when a panel URL is navigated directly. Module/API
responses allow the sandbox's `null` origin without credentialed CORS. Native mobile uses a
sandboxed iframe inside an isolated WebView with no native message bridge.

Requests are limited to 1 MiB, HTTP responses to 8 MiB, WebSocket frames to 1 MiB and concurrent
operations to 32 per capability. HTTP requests time out after 30 seconds. Web panels require `orchestration:operate`; read-only viewers see a permission notice and
receive no web capability. Native lists remain available with `orchestration:read`. Configure
only trusted plugins. Use a DNS name or IPv4 address for the T3 browser connection: Chromium
does not accept IPv6 literal hosts in the gateway’s path-restricted CSP sources.

### Host bridge

A web panel cannot draw outside its iframe, so T3 offers a narrow bridge for hover cards, dialogs
and agent requests. After each load T3 posts `{ "type": "t3.bridge.init", "version": 1 }` with a
`MessagePort` (`event.ports[0]`); talk only over that port. A script that starts listening late,
for example after a top-level `await`, can post `{ "type": "t3.bridge.hello" }` to `parent` and T3 sends
a fresh init (closing anything opened over the previous port). Messages are JSON, at most 256 KiB, and
validated; an invalid one gets an `error` reply.

| Panel → T3                                                                                                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `surface.open { requestId, surfaceId, parentSurfaceId?, presentation, anchor?, placement?, size?, content }` | `presentation` is `popover`, `dialog` or `modal`. `anchor` is a `{ x, y, width, height }` rectangle from `getBoundingClientRect()` in the panel's viewport; T3 translates and clamps it. `placement` is `left`, `right`, `top` or `bottom`, optionally with `-start` or `-end`. `content` is `{ "kind": "structured", "surface": {…} }` or `{ "kind": "web", "path": "./card.html" }`; a web path is relative and must stay inside the panel's directory. Sizes are clamped to 160–800 × 80–900 px. |
| `surface.update { surfaceId, anchor?, content? }`                                                            | Move or refresh an open surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `surface.close { surfaceId, result? }`                                                                       | Close a surface this frame opened, or the frame's own surface.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `agent.prompt { requestId, prompt }`, `agent.stop { requestId }`                                             | Ask to send a message to the thread, or stop a run this panel started. T3 asks the user first.                                                                                                                                                                                                                                                                                                                                                                                                      |

| T3 → panel                                                                | Meaning                                                                                                    |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `surface.opened { requestId, surfaceId }`                                 | The surface is showing.                                                                                    |
| `surface.closed { surfaceId, reason, result? }`                           | `reason` is `closed`, `dismissed` or `parent`. A child web surface's `result` reaches its parent this way. |
| `surface.action { surfaceId, actionId, value? }`                          | A button, form or list item in a structured surface this frame opened.                                     |
| `agent.result { requestId, ok, error? }`, `error { requestId?, message }` | Outcomes.                                                                                                  |

On mobile every presentation is a sheet and anchors are ignored; the protocol is otherwise the same.
Surfaces with web content are sandboxed frames like the panel and get their own bridge, whose init
message also carries their `surfaceId`. Surface ids are chosen by the frame and unique within it.
Closing a surface closes its children, and everything closes when the panel unmounts or the thread
changes. The demo plugin opens a structured hover card, a web dialog that returns a result to its
parent, and an agent request.

The runnable example `apps/server/scripts/plugin-spa-demo.mjs` (server package script
`plugin:spa-demo`) serves a thread counter. Configure it as a sidecar using the example above.
Add `"scopes": ["thread", "links"]` and `"links": [{ "id": "message", "prefix": "https://example.invalid/msg/" }, { "id": "page", "prefix": "https://example.invalid/page/" }]`
to see a structured link card and a web link card on chat links such as
`https://example.invalid/msg/42`.
It exercises a stylesheet, module entrypoint, dynamic import, a JSON API, a POST mutation and
live WebSocket updates. Its “Isolated” indicator checks parent DOM and local-storage denial.
