# Sidebar panel plugins

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
and sends only changed results. Run it from a T3 source installation with dependencies installed.

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
and thread; do not reuse panel or row IDs within a snapshot. Version 1 renders text and list
filters, not HTML or executable UI. The external-process transport is independent of any
future panel renderer.

Frames are limited to 1 MiB, snapshots to 20 panels, and panels to 2,000 rows. Malformed
frames disconnect the plugin and show an error. Plugins should validate all incoming messages
and bind locally unless deliberately deployed remotely. The example rejects browser Origins;
a separately deployed plugin must provide its own transport access controls.
