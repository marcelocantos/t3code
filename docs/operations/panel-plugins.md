# Sidebar panel plugins

## Install the macOS plugin build

Download the Apple Silicon DMG from [this fork's releases](https://github.com/marcelocantos/t3code/releases), open it, and drag **T3 Code Plugins.app** to Applications. This unsigned build may require approval in **System Settings → Privacy & Security → Open Anyway** after the first launch attempt.

The fork runs alongside the official app. Its data lives in `~/.t3-plugins/userdata` and its browser profile in `~/Library/Application Support/t3code-plugins`. It starts with a separate workspace list; add your existing project directories. Automatic updates are disabled for this build; install subsequent releases from the same release page. Do not set `T3CODE_HOME` to the official app's data directory.

Use this fork's desktop app or bundled web client for panels; official T3 clients do not include the panel renderers. Both desktop apps register the upstream `t3code` link scheme, so external sign-in/deep links can open either app. Direct environment connections avoid that ambiguity.

A plugin that advertises itself (see [Discovery](#discovery)) appears in thread details with an **Enable** button; nothing needs configuring by hand. The URL it advertises is resolved by the T3 environment hosting the thread, so a loopback address refers to that machine. T3 does not bundle or launch any plugin: each one is a service its own project runs.

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
type and a body of at most 1 KiB:

```json
{ "protocol": 1, "id": "github.com/example/example", "name": "Example" }
```

`id` and `name` must equal the manifest's. Redirects, other statuses and unreachable endpoints mean
the advertisement is stale and it is ignored. The same route's WebSocket upgrade is the
[protocol](#protocol-version-1) connection and is unaffected.

**Consent.** T3 re-checks advertisements when the directory changes and every ten seconds while a
client has thread details open. A compatible plugin is offered with **Enable** and **Dismiss**.
Nothing connects, and no workspace or thread reaches the plugin, until the user enables it. Enabling
saves the endpoint the user saw to `plugin-discovery.json` beside `settings.json` and shows the panel
in already-open threads without a restart. The choice requires the `settings:write` permission;
viewing offers requires only `orchestration:read`.

- **Dismiss** is remembered per plugin id across restarts and endpoint changes; the plugin is not
  offered again until the user chooses **Ask again**.
- **Disable** removes the panel but remembers the endpoint, so **Enable** works again even while the
  plugin is not running. **Forget** returns it to the undecided state.
- If an enabled plugin advertises a different endpoint (for example it restarted on another port), T3
  keeps using the endpoint the user approved and offers **Switch** or **Keep current**. A changed
  endpoint is never trusted silently.
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
`plugin:spa-demo`) serves a thread counter. Configure it as a sidecar using the example above.
It exercises a stylesheet, module entrypoint, dynamic import, a JSON API, a POST mutation and
live WebSocket updates. Its “Isolated” indicator checks parent DOM and local-storage denial.
