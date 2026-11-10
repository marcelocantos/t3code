# Sidebar panel plugins

## Install the macOS plugin build

Download the Apple Silicon DMG from [this fork's releases](https://github.com/marcelocantos/t3code/releases), open it, and drag **T3 Code Plugins.app** to Applications. This unsigned build may require approval in **System Settings → Privacy & Security → Open Anyway** after the first launch attempt.

The fork runs alongside the official app. Its data lives in `~/.t3-plugins/userdata` and its browser profile in `~/Library/Application Support/t3code-plugins`. It starts with a separate workspace list; add your existing project directories. Automatic updates are disabled for this build; install subsequent releases from the same release page. Do not set `T3CODE_HOME` to the official app's data directory.

Use this fork's desktop app or bundled web client for panels; official T3 clients do not include the panel renderers. Both desktop apps register the upstream `t3code` link scheme, so external sign-in/deep links can open either app. Direct environment connections avoid that ambiguity.

Keep your existing Bullseye installation. Create `~/.t3-plugins/userdata/panel-plugins.json` with the following configuration (create the directory first if the app has not run):

```json
[
  {
    "id": "bullseye",
    "connection": {
      "kind": "sidecar",
      "command": "/usr/bin/env",
      "args": [
        "ELECTRON_RUN_AS_NODE=1",
        "/Applications/T3 Code Plugins.app/Contents/MacOS/T3 Code Plugins",
        "/Applications/T3 Code Plugins.app/Contents/Resources/app.asar/apps/server/dist/bullseye-panel.mjs"
      ]
    }
  }
]
```

Open a thread and expand its sidebar to see Bullseye's frontier. The adapter uses the app's bundled runtime, so no Node installation, npm dependencies, or source checkout is needed. `bullseye` must be available on the app's PATH; a normal Homebrew installation is supported. Adjust the app paths above if you install it somewhere other than Applications.

Maintainers build this variant with `T3CODE_PLUGIN_BUILD=1` set for both `vp run build:desktop` and `vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 --skip-build`. Omitting the switch preserves upstream packaging and profiles.

## Configure other installations

A plugin runs outside T3 Code and supplies live, thread-scoped sidebar sections over a
WebSocket. T3 connects from the environment hosting the thread and relays snapshots over its
authenticated client connection. A remote browser or phone never connects to a localhost
plugin directly. Web and desktop show sections in thread details; mobile shows them below
the thread list in the sidebar for the selected thread.

Configure the environment's `panel-plugins.json` beside `settings.json` in its userdata
folder. Configuration is read when a sidebar subscribes: close and reopen it after edits.
This file is environment-owned because sidecar commands execute with the server's privileges.
Repository `t3.json` does not install or execute plugins.

```json
[
  {
    "id": "bullseye",
    "connection": {
      "kind": "sidecar",
      "command": "node",
      "args": ["/path/to/t3code/apps/server/scripts/bullseye-panel.mjs"]
    }
  }
]
```

The example adapter requires `bullseye` on PATH. It queries the thread's workspace through
Bullseye's CLI, preserving its external-ledger discovery and frontier computation. Frontier
is the default; Active and All are available. It refreshes every two seconds while subscribed
and sends only changed results. The source example above needs the checkout's dependencies; the packaged installation above does not.

To connect to an existing plugin server, replace `connection` with:

```json
{ "kind": "server", "baseUrl": "https://plugins.example.test/bullseye" }
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

A filter selection adds `{ "pluginId": "bullseye", "panelId": "targets", "filter": "all" }`
to `filters`. Unsubscription sends `{ "type": "unsubscribe", "subscriptionId": "opaque-id" }`.
The plugin responds with a complete replacement snapshot for that subscription:

```json
{
  "type": "panels",
  "subscriptionId": "opaque-id",
  "panels": [
    {
      "id": "targets",
      "title": "Bullseye",
      "rows": [{ "id": "T1", "label": "🎯T1 A desired state", "detail": "Optional detail" }],
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

The runnable example `apps/server/scripts/plugin-spa-demo.mjs` (server package script
`plugin:spa-demo`) serves a thread counter. Configure it as a sidecar like the Bullseye example.
It exercises a stylesheet, module entrypoint, dynamic import, a JSON API, a POST mutation and
live WebSocket updates. Its “Isolated” indicator checks parent DOM and local-storage denial.
