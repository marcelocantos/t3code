# Defect hunt, 2026-11-20

Worktree `filler/defect-hunt-2026-11-20-b` at `504c850afb`. The fork-only delta against `upstream/main` (merge-base `7d32075e3757ded707914e2450c3e392a9665765`) is the plugin host. Every confirmed defect below is in that delta. Existing tests do not cover these cases. Product code was not changed. Each reproduction was run in this worktree with `node --experimental-strip-types` against fakes on `127.0.0.1` and an ephemeral port, and those processes were stopped before this file was written.

## Confirmed defects

### 1. A dead plugin's endpoint never receives another thread's workspace

**Severity: high.** After the process that owned a saved plugin URL exits, T3 sends the subscribed thread's workspace path (and, for an environment subscription, every project path) to whoever binds that port next. That is the lifecycle case this hunt was aimed at: a provider-side process dies mid-session and a different process inherits the conversation's location. It is reliable within one second. Any local user can bind `127.0.0.1` once the port is free; they do not need to read the `0700` manifest directory.

**Mechanism.** `PanelPluginConnection.retry` waits one second and calls `start`. A `server` connection then opens a WebSocket to the saved `baseUrl` and never repeats the HTTP identity probe. On open, `send` writes `cwd` and `threadId` for every live thread subscription, or the environment's project list. `PluginDiscovery.withLiveScopes` leaves an enabled decision as it is when the live probe finds no candidate, so a dead endpoint stays enabled while the socket retries on its own. The second listener in the reproduction answered no discovery request and still received the workspace frame.

**Where.** `apps/server/src/plugins/PanelPluginConnection.ts:261` (`retry`), `:331` (`connect`), `:402` (`send`). `apps/server/src/plugins/PluginDiscovery.ts:193` (`if (!live) return decision`).

**Reproduction.** Save as `apps/server/src/plugins/_repro_port_hijack.ts` and run `node --experimental-strip-types apps/server/src/plugins/_repro_port_hijack.ts`. Observed: `[{"who":"first","cwd":"/secret/worktree","threadId":"thread-1"},{"who":"second","cwd":"/secret/worktree","threadId":"thread-1"}]`.

```typescript
import * as http from "node:http";
import { WebSocketServer } from "ws";
import { ThreadId } from "@t3tools/contracts";
import { PanelPluginConnection } from "./PanelPluginConnection.ts";

const received: Array<{ who: string; cwd?: string; threadId?: string }> = [];
const first = http.createServer();
const wss1 = new WebSocketServer({ server: first });
const port = await new Promise<number>((resolve) =>
  first.listen(0, "127.0.0.1", () => resolve((first.address() as { port: number }).port)),
);
const gotFirst = new Promise<void>((resolve) => {
  wss1.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      received.push({ who: "first", cwd: message.cwd, threadId: message.threadId });
      socket.close();
      resolve();
    });
  });
});

const connection = new PanelPluginConnection({
  id: "github.com/acme/panels",
  connection: { kind: "server", baseUrl: `http://127.0.0.1:${port}/plugins/t3` },
});
connection.subscribe({
  target: { scope: "thread", threadId: ThreadId.make("thread-1"), cwd: "/secret/worktree" },
  filters: [],
  emit: () => undefined,
});
await gotFirst;
await new Promise<void>((resolve) => first.close(() => resolve()));

const second = http.createServer();
const wss2 = new WebSocketServer({ server: second });
const gotSecond = new Promise<void>((resolve) => {
  wss2.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      received.push({ who: "second", cwd: message.cwd, threadId: message.threadId });
      resolve();
    });
  });
});
await new Promise<void>((resolve) => second.listen(port, "127.0.0.1", resolve));
const timer = setTimeout(() => {
  console.log("TIMEOUT", JSON.stringify(received));
  process.exitCode = 2;
}, 4000);
await gotSecond;
clearTimeout(timer);
connection.stop();
await new Promise<void>((resolve) => second.close(() => resolve()));
console.log(JSON.stringify(received));
```

**Smallest fix.** Do not open the WebSocket, and do not send a workspace frame, until a fresh HTTP probe of that `baseUrl` returns the same plugin id. Stop retrying a `server` connection across process death until that probe succeeds. A per-enable secret the plugin must present is stronger. The small fix still loses if an impostor answers the probe with the public plugin id in the gap between the probe and the socket; that race wants the secret, and it is the limit of the probe check.

### 2. A link pattern never claims a URL whose normalized form is outside the path it names

**Severity: high.** `pluginLinkMatches` is the boundary that decides which plugin receives a URL and may rewrite it, resolve it, or swallow the click. The contract comment says a path is already normalized, so `..` cannot walk out of the directory a pattern names. For `http:` and `https:` the `..` guard is skipped, and both the web client and `claimedLink` match the href as written. A pattern the user approved for `https://viewer.example/msg/` therefore claims `https://viewer.example/msg/../admin`, which the browser opens as `https://viewer.example/admin`.

**Mechanism.** Prefixes use `target.startsWith`. Globs run the compiled regular expression and then skip `/(^|\/)\.\.?(\/|$)/` whenever the target starts with `http:` or `https:`. `pluginLinkTarget` returns an `http(s)` URL unchanged. `ChatMarkdown` passes `writtenHref` into the takeover, and `PanelPlugins.claimedLink` calls `pluginLinkMatches` on `input.url`. `new URL` collapses both `../` and `%2e%2e/` before navigation. Existing tests cover a POSIX file path containing `..`, and prefixes that already end in `/`.

**Where.** `packages/contracts/src/panelPlugins.ts:383` (`pluginLinkMatches`). Callers: `packages/client-runtime/src/state/panelPlugins.ts:131` and `:115`; `apps/web/src/components/ChatMarkdown.tsx:1187`; `apps/server/src/plugins/PanelPlugins.ts:459`.

**Reproduction.** Save as `packages/client-runtime/src/state/_repro_links.ts` and run `node --experimental-strip-types packages/client-runtime/src/state/_repro_links.ts`. Observed for both raw URLs: `prefixRaw: true`, `globRaw: true`, `matchRaw: "message"`, `normalized: "https://viewer.example/admin"`, and `matchPluginLink` on the normalized href is absent (`undefined`, omitted by `JSON.stringify`).

```typescript
import { pluginLinkMatches, type PluginLink } from "@t3tools/contracts";
import { matchPluginLink } from "./panelPlugins.ts";

const prefix = {
  pluginId: "p",
  linkId: "message",
  prefix: "https://viewer.example/msg/",
} satisfies PluginLink;
const glob = {
  pluginId: "p",
  linkId: "message",
  glob: "https://viewer.example/msg/**",
} satisfies PluginLink;
for (const raw of [
  "https://viewer.example/msg/../admin",
  "https://viewer.example/msg/%2e%2e/admin",
]) {
  console.log(
    JSON.stringify({
      raw,
      normalized: new URL(raw).href,
      prefixRaw: pluginLinkMatches(prefix, raw),
      prefixNormalized: pluginLinkMatches(prefix, new URL(raw).href),
      globRaw: pluginLinkMatches(glob, raw),
      matchRaw: matchPluginLink([prefix], raw)?.linkId ?? null,
      matchNormalized: matchPluginLink([prefix], new URL(raw).href)?.linkId ?? null,
    }),
  );
}
```

**Smallest fix.** Compare prefixes and globs against `new URL(target).href` for `http(s)` targets, and apply the `..` segment check to that normalized path. Require a non-slash-terminated prefix to be followed by `/` or by end of string (defect 6 is the same boundary check).

### 3. A link-card gateway never proxies a path outside the card's directory

**Severity: medium.** A panel snapshot is rewritten so its gateway token can reach only that panel's path, and the path must end in `/`. A link card grants the plugin origin instead. The token is returned by the `pluginLinksCard` RPC to any client with operate permission, including a remote phone, so that client can `GET` other paths on the origin without the sandboxed iframe. A port that serves only the plugin exposes nothing new. A shared loopback port that also serves an unauthenticated admin API is opened for the life of the grant.

**Mechanism.** `linkCard` turns the WebSocket endpoint into an HTTP origin and calls `gateway.grant` with `new URL("/", base).href`. The gateway then proxies any request whose upstream URL starts with that root. `pluginRelativePath` still confines the card path the plugin declared; it does not confine later requests that present the token.

**Where.** `apps/server/src/plugins/PanelPlugins.ts:522`.

**Reproduction.** Save as `apps/server/src/plugins/_repro_gateway.ts` and run `node --experimental-strip-types apps/server/src/plugins/_repro_gateway.ts`. Observed: `{"cardStatus":200,"secretStatus":200,"hits":["/cards/one","/admin/secret"]}` (the endpoint port varies).

```typescript
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as ServerHttp from "../http.ts";
import * as ServerConfig from "../config.ts";
import * as PluginGateway from "./PluginGateway.ts";
import * as PluginGatewayHttp from "./PluginGatewayHttp.ts";
import { PluginGatewaySessions } from "./PluginGatewaySessions.ts";

const hits: string[] = [];
const upstream = NodeHttp.createServer((request, response) => {
  hits.push(request.url ?? "");
  response.writeHead(200, { "content-type": "text/plain" }).end("ok");
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const address = upstream.address();
if (!address || typeof address === "string") throw new Error("no address");
const sessions = new PluginGatewaySessions();
const grant = sessions.grant(`http://127.0.0.1:${address.port}/`);
const { handler, dispose } = HttpRouter.toWebHandler(
  Layer.merge(
    PluginGatewayHttp.layer,
    ServerHttp.layerBrowserApiCors.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "plugin-repro-" })),
      Layer.provide(NodeServices.layer),
    ),
  ).pipe(Layer.provideMerge(Layer.succeed(PluginGateway.PluginGateway, sessions))),
  { disableLogger: true },
);
const card = await handler(
  new Request(`http://t3.test/api/plugin-panels/${grant.token}/cards/one`),
);
const secret = await handler(
  new Request(`http://t3.test/api/plugin-panels/${grant.token}/admin/secret`),
);
console.log(JSON.stringify({ cardStatus: card.status, secretStatus: secret.status, hits }));
await dispose();
sessions.close();
await new Promise<void>((resolve) => upstream.close(() => resolve()));
```

**Smallest fix.** Grant the directory of `web.path` (`new URL("./", new URL(web.path, origin)).href`), the same scoping `PluginGatewaySessions.session().rewrite` already applies to panel roots.

### 4. A later resolution for a link never loses to an older in-flight lookup

**Severity: medium.** Hover cards on the web and link cards on the phone share this cache. After the cache evicts a key that is still in flight, the late answer overwrites the lookup the user is now looking at. The href and the label can be the previous plugin answer. A rejected RPC is stored as `{}` by the same path, so a failure can also erase a newer answer.

**Mechanism.** `request` treats `requested.has(key)` as "this call is the latest" and stores whatever promise completes while the key is present. Eviction at 500 entries removes the key from `requested` and `values` without cancelling the promise. A new `request` for the same key is therefore allowed, and the older completion still passes the `requested.has(key)` check. There is no generation token. Callers: `apps/web/src/components/plugins/PluginLinkHover.tsx:40` and `apps/mobile/src/features/plugins/PluginLinkCard.tsx:47`.

**Where.** `packages/client-runtime/src/state/panelPlugins.ts:219`.

**Reproduction.** In the same client-runtime file as defect 2, after the imports of `createPluginLinkResolutions`. Observed: `secondDone: true` and `final: {"href":"https://old.example/stale"}`.

```typescript
import { createPluginLinkResolutions } from "./panelPlugins.ts";

const resolutions = createPluginLinkResolutions();
let releaseFirst: (value: { href: string }) => void = () => undefined;
const first = new Promise<{ href: string }>((resolve) => {
  releaseFirst = resolve;
});
resolutions.request("A", () => first);
for (let index = 0; index < 500; index++) {
  resolutions.request(`k${index}`, () => Promise.resolve({ href: "https://filler.example/" }));
}
let secondDone = false;
resolutions.request("A", () =>
  Promise.resolve({ href: "https://new.example/ok" }).then((value) => {
    secondDone = true;
    return value;
  }),
);
await Promise.resolve();
releaseFirst({ href: "https://old.example/stale" });
await Promise.resolve();
await Promise.resolve();
console.log(JSON.stringify({ secondDone, final: resolutions.read("A") }));
```

**Smallest fix.** Stamp each `request` with a generation. Ignore a completion whose generation is no longer the one stored for that key.

### 5. A file glob never claims a path that climbs out of its directory

**Severity: medium.** On Windows, `\` is a separator. A glob the user approved for one project directory also matches a path that climbs out of it, and the client keeps that climbed path as the target it sends to the plugin. On macOS and Linux `\` is a filename character, so the same spelling is not a traversal there. The slash spelling of the same path is already rejected.

**Mechanism.** `pluginLinkMatches` escapes `\` inside the glob and treats `**` as `.*`, so `C:\Users\me\proj\**` matches `C:\Users\me\proj\..\..\Windows\secret.md`. The `..` guard looks for `/` only. `pluginLinkTarget` splits on `/` only, and `segments.length > 1` never sees a `..` segment, so it returns the climbed path unchanged. `isAbsolutePath` treats a drive path as absolute, so the path is not re-joined against the workspace.

**Where.** `packages/contracts/src/panelPlugins.ts:383` and `packages/client-runtime/src/state/panelPlugins.ts:141`.

**Reproduction.** Same runner as defect 2. Observed: `{"matches":true,"target":"C:\\Users\\me\\proj\\..\\..\\Windows\\secret.md","slashForm":false}`.

```typescript
import { pluginLinkMatches } from "@t3tools/contracts";
import { pluginLinkTarget } from "./panelPlugins.ts";

const climbed = "C:\\Users\\me\\proj\\..\\..\\Windows\\secret.md";
console.log(
  JSON.stringify({
    matches: pluginLinkMatches(
      { pluginId: "p", linkId: "files", glob: "C:\\Users\\me\\proj\\**" },
      climbed,
    ),
    target: pluginLinkTarget(climbed, null),
    slashForm: pluginLinkMatches(
      { pluginId: "p", linkId: "files", glob: "C:/Users/me/proj/**" },
      "C:/Users/me/proj/../../Windows/secret.md",
    ),
  }),
);
```

**Smallest fix.** Before matching, rewrite a Windows-style path with the slash canonicalization `fileLinks.ts` already uses, then reject `..` on the result. Do that inside `pluginLinkTarget` and inside `pluginLinkMatches` for non-URL targets.

### 6. A URL prefix never matches a longer final path segment

**Severity: medium.** The prefix schema already refuses a host boundary (`https://a.example` cannot match `a.example.evil`) by requiring a slash after the host. It does not require a path-segment boundary. A prefix the user approved for one repository also claims a sibling whose name only starts with that repository. Documented examples end in `/`, and the tests use those. `https://github.com/org/repo/secret` is ordinary prefix behaviour once the prefix names a directory; the defect is the sibling.

**Mechanism.** `pluginLinkMatches` is `target.startsWith(link.prefix)`. `PluginLinkPrefix` is `/^https?:\/\/[^\s/?#@]+\/\S*$/`, which accepts `https://github.com/org/repo` with no trailing slash.

**Where.** `packages/contracts/src/panelPlugins.ts:21` and `:385`.

**Reproduction.** Same runner as defect 2. Observed: `{"private":true,"secret":true}`.

```typescript
import { pluginLinkMatches } from "@t3tools/contracts";

const link = { pluginId: "p", linkId: "repo", prefix: "https://github.com/org/repo" };
console.log(
  JSON.stringify({
    private: pluginLinkMatches(link, "https://github.com/org/repo-private"),
    secret: pluginLinkMatches(link, "https://github.com/org/repo/secret"),
  }),
);
```

**Smallest fix.** After URL normalization, if the prefix does not end in `/`, the next character of the target must be `/` or the target must end. Fold this into the normalization in defect 2.

### 7. Stopping a plugin never leaves a descendant process running

**Severity: medium.** `stop` reports the plugin disconnected, then SIGTERM and, two seconds later, SIGKILL reach only the direct child. A grandchild keeps the server's environment and any port it bound. A later sidecar start announces a new port, so the orphan is not automatically the next connection. It becomes defect 1 when the orphan, or anything else, binds a `server` connection's saved port.

**Mechanism.** `start` spawns the sidecar with `stdio` pipes and neither `detached: true` nor a new process group. `stopChild` signals `child.pid` only. SIGKILL of that pid does not kill its children. The reproduction waited 2.5 seconds after `stop`, past the two-second SIGKILL, and the grandchild was still alive. The reproduction then SIGKILLed that grandchild.

**Where.** `apps/server/src/plugins/PanelPluginConnection.ts:243` (`stopChild`) and `:283` (`spawn`).

**Reproduction.** Save as `apps/server/src/plugins/_repro_orphan.ts` and run `node --experimental-strip-types apps/server/src/plugins/_repro_orphan.ts`. Observed: `{"grandchild":74147,"aliveAfterStop":true}`. The script SIGKILLs the grandchild when it is still alive.

```typescript
import * as fs from "node:fs";
import { ThreadId } from "@t3tools/contracts";
import { PanelPluginConnection } from "./PanelPluginConnection.ts";

const pidFile = "/tmp/plugin-repro-grandchild.pid";
process.env.PIDFILE = pidFile;
fs.rmSync(pidFile, { force: true });
const connection = new PanelPluginConnection({
  id: "sidecar",
  connection: {
    kind: "sidecar",
    command: process.execPath,
    args: [
      "-e",
      `require("node:fs").writeFileSync(process.env.PIDFILE, String(require("node:child_process").spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], {stdio:"ignore"}).pid)); setInterval(()=>{}, 1e9);`,
    ],
  },
});
connection.subscribe({
  target: { scope: "thread", threadId: ThreadId.make("thread-1"), cwd: "/tmp" },
  filters: [],
  emit: () => undefined,
});
const deadline = Date.now() + 4000;
while (!fs.existsSync(pidFile)) {
  if (Date.now() > deadline) {
    console.log("NO PID");
    process.exit(2);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const pid = Number(fs.readFileSync(pidFile, "utf8"));
connection.stop();
await new Promise((resolve) => setTimeout(resolve, 2500));
let alive = true;
try {
  process.kill(pid, 0);
} catch {
  alive = false;
}
console.log(JSON.stringify({ grandchild: pid, aliveAfterStop: alive }));
if (alive) process.kill(pid, "SIGKILL");
```

**Smallest fix.** Spawn the sidecar in its own session and signal the process group (negative pid) on both the SIGTERM and the SIGKILL timer.

## Unconfirmed suspicions

1. **`child.kill` throws `ESRCH` out of the stop timer.** `stopChild` calls `child.kill` with no `try`, from `retry` and from the two-second timer. If the pid has exited and the `exit` event has not yet cleared the timer, that throw leaves the timer callback. Read `PanelPluginConnection.ts:243`. Not reproduced; the orphan run's parent was killed by `stop` itself, and a separate already-dead `kill` was not isolated.

2. **A failed scope-narrowing save is ignored, then memory still updates.** `PluginDiscovery.ts:288` runs `save(...).pipe(Effect.ignore)` and `:289` then writes the narrowed decisions into the `SubscriptionRef`. A crash after that update and before a later successful save reloads the previous file, which can still list scopes the user had approved and the live probe had since dropped, until the next scan that manages to save. Read the `refresh` path. No crash-during-save harness was built. This does not widen past a set the user once approved. `withLiveScopes` itself refuses to add a scope.

3. **`globCache` grows without a bound.** `packages/contracts/src/panelPlugins.ts:352` keeps one compiled `RegExp` per distinct glob for the process lifetime. An enabled plugin that changes glob text on every rescan grows the map. Read the compiler. A rotation loop was not executed. This is a slow leak in a local process, not a wrong match.

4. **A surface-tree `onClosed` can re-enter `open`.** `pluginSurfaceTree.ts` `open` (`:40`) calls `close` before inserting, and `close` (`:68`) invokes `onClosed` before it returns. A callback that calls `open` or `close` again re-enters `set` while the outer call still has work to do. Read the module. A re-entrant callback was not executed.

5. **A manual `panel-plugins.json` sidecar runs as the server user without the Settings consent dialog.** Discovery loads that file and spawns its command. The operations doc describes it as an admin file under userdata. Read the manual-load path and `docs/operations/panel-plugins.md`. Not shown to be unintentional.

## Coverage

The three-dot diff `upstream/main...HEAD` is the plugin host (about ten fork commits: plugin features and the upstream v0.1.10 merge). Orchestrator and delegation tools, thread launch, worktree creation and cleanup, scheduled tasks, environment links, and pull-request linking and watching have no files in that diff. They were not line-reviewed. Upstream code was not treated as a defect source for this hunt.

Read in full: `PluginGateway.ts`, `PluginGatewaySessions.ts`, `PluginGatewayHttp.ts`, `PanelPluginConnection.ts`, `PanelPlugins.ts`, `PluginDiscovery.ts`, `PluginManifests.ts`, `packages/contracts/src/panelPlugins.ts`, `packages/contracts/src/pluginDiscovery.ts`, `packages/client-runtime/src/state/panelPlugins.ts`, `pluginBridge.ts`, `pluginNavigation.ts`, `pluginSurfaceTree.ts`, `apps/desktop/src/app/PluginBuild.ts`, and `apps/desktop/resources/entitlements.plugins.mac.plist`.

Read in part: `PanelPluginConnection.test.ts` (through about line 220), `PluginDiscovery.test.ts` (opening and the live-scope assertions), `PluginGatewayHttp.test.ts`, `PluginGatewaySpa.test.ts` (opening), `RpcAuthorization.ts` and its test for the new method scopes, `apps/server/src/ws.ts` and `http.ts` plugin routes, `apps/server/src/auth/utils.ts` `resolveClientIpAddress`, `packages/shared/src/hostClassification.ts` `isLocalLoopbackHost`, `path.ts`, `fileLinks.ts`, `markdownLinks.ts` `parseMarkdownFileLink`, `ChatMarkdown.tsx` at the plugin takeover, `PluginLinkHover.tsx`, `PluginLinkCard.tsx`, `pluginBridgeHost.ts`, the bridge handler in `PluginSurfaceHost.tsx` (the file is longer than the handler), `docs/operations/panel-plugins.md` (consent, remote `baseUrl`, link-pattern changes, the `local` caveat), and the first 120 lines of `scripts/release-plugin-desktop.ts`. React plugin surfaces other than those were sampled, not read line by line. The desktop entitlements (JIT, unsigned executable memory, library validation off, camera, microphone) are documented as the terminal and agent inheriting the app's TCC identity and were not confirmed as a defect. The release script is maintainer signing, not a runtime path.

Checked and not reported as defects:

- Gateway `ACTIVE_LIMIT` of 32. Forty concurrent holds against a panel path peaked at 32 in flight, with 8 responses of 429. The cap held.
- `{rest}` substitution in `pluginLinkHref`. Values containing `@`, `https://`, a backslash, `%2F`, and CRLF stayed on `https://internal.example` (`%40x`, `https%3A//elsewhere.example`, `..%5C%40x`, `%252F..%252Fadmin`, `line%0D%0AHost%3A%20evil.example`).
- Loopback spelling. `ws://[::1]/` is allowed. Decimal, hex, and shorthand IPv4 loopback normalize to `127.0.0.1` before the hostname check. `http://[::ffff:127.0.0.1]/` is rejected. `localhost.` (trailing dot) is rejected, which is fail-closed.
- `pluginDiscoveryAct` is in `CLIENT_GUARDED_RPC_SCOPES` (`AuthSettingsWriteScope`), and the authorization test requires a scope for every RPC method.
- `X-Forwarded-For` is consulted only when the TCP peer is loopback, last hop only. A remote client cannot become `local: true` by setting that header. A local client can look remote, which fails closed. The operations doc already says an SSH tunnel arrives on loopback, so `local` is not authentication.
- A remote manual `baseUrl` is the documented configuration. Link-pattern text can change without a new consent; adding the `links` scope cannot. Scope widening in `withLiveScopes` is the intersection of approved and live scopes.
