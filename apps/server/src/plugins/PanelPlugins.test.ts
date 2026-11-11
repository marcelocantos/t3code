// @effect-diagnostics nodeBuiltinImport:off -- The slice runs a real plugin: one loopback listener answers the probe and the panel socket.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { WebSocketServer } from "ws";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ThreadId, type PluginLink, type PluginPanelSnapshot } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PanelPlugins from "./PanelPlugins.ts";
import * as PluginDiscovery from "./PluginDiscovery.ts";
import * as PluginGateway from "./PluginGateway.ts";
import { PLUGIN_GATEWAY_PREFIX } from "./PluginGatewaySessions.ts";

/** A plugin: probe answer on plain GET, panel snapshots on the same route's WebSocket. */
const ALPHA = "github.com/acme/alpha";

type Frame = { readonly path: string; readonly message: Record<string, any> };

const startPlugin = Effect.acquireRelease(
  Effect.promise(async () => {
    const sockets = new Set<import("ws").WebSocket>();
    const socketsByPath = new Map<string, import("ws").WebSocket>();
    const connected = new Array<Deferred.Deferred<void>>();
    const closed = new Array<Deferred.Deferred<void>>();
    const frames = new Array<Frame>();
    const frameWaiters = new Array<{
      test: (frame: Frame) => boolean;
      done: Deferred.Deferred<Frame>;
    }>();
    const server = NodeHttp.createServer((_request, response) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ protocol: 1, id: ALPHA, name: "Alpha" })),
    );
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket, request) => {
      const path = request.url ?? "";
      sockets.add(socket);
      socketsByPath.set(path, socket);
      for (const deferred of connected) Deferred.doneUnsafe(deferred, Effect.void);
      socket.on("close", () => {
        sockets.delete(socket);
        for (const deferred of closed) Deferred.doneUnsafe(deferred, Effect.void);
      });
      const reply = (value: unknown) => socket.send(JSON.stringify(value));
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        const frame = { path, message };
        frames.push(frame);
        for (const waiter of frameWaiters)
          if (waiter.test(frame)) Deferred.doneUnsafe(waiter.done, Effect.succeed(frame));
        const result = { type: "result", requestId: message.requestId };
        switch (message.type) {
          case "subscribe": {
            const title =
              message.scope === "environment"
                ? `projects ${message.projects.map((project: { cwd: string }) => project.cwd).join(" ")}`
                : `cwd ${message.cwd}`;
            reply({
              type: "panels",
              subscriptionId: message.subscriptionId,
              panels: [{ id: "list", title, rows: [], filters: [], filter: "all" }],
            });
            break;
          }
          case "action":
            if (message.actionId === "silent") break;
            if (message.actionId === "reject") reply({ ...result, ok: false, error: "Nope" });
            else reply({ ...result, ok: true, close: true });
            break;
          case "resolve":
            reply({
              ...result,
              ok: true,
              link: { href: `https://internal.example/view?u=${message.url}`, text: "Resolved" },
            });
            break;
          case "surface":
            if (message.scope === "link")
              reply(
                message.linkId === "page"
                  ? { ...result, ok: true, web: { path: "/cards/msg.html", height: 200 } }
                  : { ...result, ok: true, surface: { title: `card ${message.url}`, blocks: [] } },
              );
            else if (message.surfaceId === "empty") reply({ ...result, ok: true });
            else
              reply({
                ...result,
                ok: true,
                surface: { title: `surface ${message.surfaceId}`, blocks: [] },
              });
            break;
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No plugin address");
    return {
      origin: `http://127.0.0.1:${address.port}`,
      baseUrl: `http://127.0.0.1:${address.port}/plugins/alpha`,
      sockets,
      frames,
      /** The first frame, past or future, that passes `test`. */
      frame: (test: (frame: Frame) => boolean) => {
        const done = Deferred.makeUnsafe<Frame>();
        const seen = frames.find(test);
        if (seen) Deferred.doneUnsafe(done, Effect.succeed(seen));
        else frameWaiters.push({ test, done });
        return Deferred.await(done);
      },
      send: (path: string, value: unknown) => socketsByPath.get(path)?.send(JSON.stringify(value)),
      nextConnection: () => {
        const deferred = Deferred.makeUnsafe<void>();
        connected.push(deferred);
        return deferred;
      },
      nextClose: () => {
        const deferred = Deferred.makeUnsafe<void>();
        closed.push(deferred);
        return deferred;
      },
      stop: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.terminate();
          wss.close(() => server.close(() => resolve()));
        }),
    };
  }),
  (plugin) => Effect.promise(() => plugin.stop()),
);

const project = (id: string) => ({ id, title: id, workspaceRoot: `/${id}` });

/** Thread `open-thread` works in `/work/tree`; `projects` and `projectEvents` drive the environment. */
const testLayer = (
  baseDir: string,
  manifestDirectory: string,
  projects: { current: ReadonlyArray<ReturnType<typeof project>> },
  projectEvents: Queue.Queue<unknown>,
) =>
  PanelPlugins.layer.pipe(
    Layer.provideMerge(PluginDiscovery.layerFromDirectory(manifestDirectory)),
    Layer.provideMerge(PluginGateway.layer),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({ projectId: "project", worktreePath: "/work/tree" } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: () => Effect.succeedNone,
        listShells: () => Effect.sync(() => projects.current as never),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
        latestApplicationSequence: Effect.succeed(0),
        streamProjectedApplicationEvents: () => Stream.fromQueue(projectEvents) as never,
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

it.live("activates and removes a panel on an already-open thread as the user decides", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-panel-plugins-" });
    const manifestDirectory = path.join(baseDir, "plugins");
    yield* fs.makeDirectory(manifestDirectory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(manifestDirectory, 0o700);
    yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
    const plugin = yield* startPlugin;
    yield* fs.writeFileString(
      path.join(manifestDirectory, "github.com+acme+alpha+1.json"),
      JSON.stringify({
        protocol: 1,
        id: ALPHA,
        name: "Alpha",
        connection: { kind: "server", baseUrl: plugin.baseUrl },
      }),
    );

    const layer = testLayer(
      baseDir,
      manifestDirectory,
      { current: [] },
      yield* Queue.unbounded<unknown>(),
    );
    yield* Effect.gen(function* () {
      const panels = yield* PanelPlugins.PanelPlugins;
      const discovery = yield* PluginDiscovery.PluginDiscovery;
      const seen = yield* Queue.unbounded<ReadonlyArray<PluginPanelSnapshot>>();
      yield* panels
        .subscribe({ threadId: ThreadId.make("open-thread"), filters: [] }, { allowWeb: false })
        .pipe(
          Stream.runForEach((snapshots) => Queue.offer(seen, snapshots)),
          Effect.forkScoped,
        );
      const next = (condition: (snapshots: ReadonlyArray<PluginPanelSnapshot>) => boolean) =>
        Stream.fromQueue(seen).pipe(Stream.filter(condition), Stream.runHead);
      const showsPanel = (snapshots: ReadonlyArray<PluginPanelSnapshot>) =>
        snapshots.some(
          (snapshot) =>
            snapshot.pluginId === ALPHA &&
            snapshot.status === "connected" &&
            snapshot.panels[0]?.title === "cwd /work/tree",
        );

      // Discovered but not decided: no panel, and nothing has connected to the service.
      yield* Queue.take(seen);
      yield* Stream.runHead(
        discovery.snapshots.pipe(
          Stream.filter((snapshot) => snapshot.plugins.some((p) => p.state === "offered")),
        ),
      );
      assert.equal(plugin.sockets.size, 0);

      const connected = plugin.nextConnection();
      yield* discovery.act({ action: "enable", id: ALPHA, baseUrl: plugin.baseUrl });
      assert.equal(Option.isSome(yield* next(showsPanel)), true);
      yield* Deferred.await(connected);

      const closed = plugin.nextClose();
      yield* discovery.act({ action: "disable", id: ALPHA });
      assert.equal(
        Option.isSome(yield* next((snapshots) => snapshots.every((s) => s.pluginId !== ALPHA))),
        true,
      );
      yield* Deferred.await(closed);

      yield* discovery.act({ action: "enable", id: ALPHA, baseUrl: plugin.baseUrl });
      assert.equal(Option.isSome(yield* next(showsPanel)), true);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const ENVIRONMENT_PLUGIN = "environment-plugin";
const THREAD_PLUGIN = "thread-plugin";

/** Two hand-configured plugins on one listener: one serves both scopes, one only threads. */
const scopedPlugins = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-panel-plugins-" });
  const manifestDirectory = path.join(baseDir, "plugins");
  yield* fs.makeDirectory(manifestDirectory, { recursive: true, mode: 0o700 });
  yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
  const plugin = yield* startPlugin;
  yield* fs.writeFileString(
    path.join(baseDir, "userdata", "panel-plugins.json"),
    JSON.stringify([
      {
        id: ENVIRONMENT_PLUGIN,
        connection: { kind: "server", baseUrl: `${plugin.origin}/plugins/environment` },
        scopes: ["thread", "environment"],
      },
      {
        id: THREAD_PLUGIN,
        connection: { kind: "server", baseUrl: `${plugin.origin}/plugins/thread` },
      },
    ]),
  );
  const projects = { current: [project("one")] };
  const projectEvents = yield* Queue.unbounded<unknown>();
  return {
    plugin,
    projects,
    projectEvents,
    layer: testLayer(baseDir, manifestDirectory, projects, projectEvents),
  };
});

const watchEnvironment = Effect.gen(function* () {
  const panels = yield* PanelPlugins.PanelPlugins;
  const seen = yield* Queue.unbounded<ReadonlyArray<PluginPanelSnapshot>>();
  yield* panels.subscribeEnvironment({ filters: [] }, { allowWeb: false }).pipe(
    Stream.runForEach((snapshots) => Queue.offer(seen, snapshots)),
    Effect.forkScoped,
  );
  return (title: string) =>
    Stream.fromQueue(seen).pipe(
      Stream.filter((snapshots) =>
        snapshots.some(
          (snapshot) =>
            snapshot.pluginId === ENVIRONMENT_PLUGIN && snapshot.panels[0]?.title === title,
        ),
      ),
      Stream.runHead,
    );
});

const row = { panelId: "list", rowId: "row" };

it.live("serves environment panels to environment plugins and routes their requests", () =>
  Effect.gen(function* () {
    const { plugin, projects, projectEvents, layer } = yield* scopedPlugins;
    yield* Effect.gen(function* () {
      const panels = yield* PanelPlugins.PanelPlugins;
      const showing = yield* watchEnvironment;
      const first = yield* showing("projects /one");
      assert.equal(first.pipe(Option.getOrThrow).length, 1);
      const subscribed = yield* plugin.frame((frame) => frame.message.type === "subscribe");
      assert.deepStrictEqual(subscribed.message.projects, [
        { projectId: "one", title: "one", cwd: "/one" },
      ]);

      // A changed project set replaces the subscription rather than opening another.
      projects.current = [project("one"), project("two")];
      yield* Queue.offer(projectEvents, { aggregateKind: "project" });
      assert.equal(Option.isSome(yield* showing("projects /one /two")), true);
      const replaced = plugin.frames.filter((frame) => frame.message.type === "subscribe");
      assert.deepStrictEqual(
        replaced.map((frame) => frame.message.subscriptionId),
        [subscribed.message.subscriptionId, subscribed.message.subscriptionId],
      );

      const target = { scope: "environment" } as const;
      assert.deepStrictEqual(
        yield* panels.act({ target, pluginId: ENVIRONMENT_PLUGIN, ...row, actionId: "done" }),
        { close: true },
      );
      const action = yield* plugin.frame((frame) => frame.message.type === "action");
      assert.equal(action.message.scope, "environment");
      assert.deepStrictEqual(
        action.message.projects.map((value: { cwd: string }) => value.cwd),
        ["/one", "/two"],
      );

      const thread = { scope: "thread", threadId: ThreadId.make("open-thread") } as const;
      const surface = yield* panels.surface({
        target: thread,
        pluginId: ENVIRONMENT_PLUGIN,
        ...row,
        surfaceId: "details",
        itemId: "item",
      });
      assert.equal(surface.title, "surface details");
      const requested = yield* plugin.frame((frame) => frame.message.type === "surface");
      assert.deepStrictEqual(
        [requested.message.scope, requested.message.threadId, requested.message.cwd],
        ["thread", "open-thread", "/work/tree"],
      );
      assert.equal(requested.message.itemId, "item");

      const rejected = yield* Effect.flip(
        panels.act({ target, pluginId: ENVIRONMENT_PLUGIN, ...row, actionId: "reject" }),
      );
      assert.deepStrictEqual([rejected.reason, rejected.detail], ["rejected", "Nope"]);
      const empty = yield* Effect.flip(
        panels.surface({ target, pluginId: ENVIRONMENT_PLUGIN, ...row, surfaceId: "empty" }),
      );
      assert.equal(empty.reason, "invalid-response");

      // The thread-only plugin was never told about the environment, so nothing is connected.
      const unscoped = yield* Effect.flip(
        panels.act({ target, pluginId: THREAD_PLUGIN, ...row, actionId: "done" }),
      );
      assert.equal(unscoped.reason, "not-connected");
      assert.equal(
        plugin.frames.some((frame) => frame.path === "/plugins/thread"),
        false,
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("times out a silent plugin and ignores its late answer", () =>
  Effect.gen(function* () {
    const { plugin, layer } = yield* scopedPlugins;
    yield* Effect.gen(function* () {
      const panels = yield* PanelPlugins.PanelPlugins;
      const showing = yield* watchEnvironment;
      yield* showing("projects /one");
      const target = { scope: "environment" } as const;
      const pending = yield* panels
        .act({ target, pluginId: ENVIRONMENT_PLUGIN, ...row, actionId: "silent" })
        .pipe(Effect.flip, Effect.forkScoped);
      const sent = yield* plugin.frame((frame) => frame.message.actionId === "silent");
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* Fiber.join(pending)).reason, "timeout");

      plugin.send("/plugins/environment", {
        type: "result",
        requestId: sent.message.requestId,
        ok: true,
      });
      assert.deepStrictEqual(
        yield* panels.act({ target, pluginId: ENVIRONMENT_PLUGIN, ...row, actionId: "done" }),
        { close: true },
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("serves link cards only for declared prefixes of plugins with the links scope", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-panel-plugins-" });
    const manifestDirectory = path.join(baseDir, "plugins");
    yield* fs.makeDirectory(manifestDirectory, { recursive: true, mode: 0o700 });
    yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
    const plugin = yield* startPlugin;
    const links = [
      { id: "message", prefix: "https://viewer.example/msg/" },
      { id: "page", prefix: "https://viewer.example/page/" },
      {
        id: "staff",
        prefix: "https://staff.example/u/",
        click: "card" as const,
        href: "https://directory.example/people/{rest}",
        resolve: true,
      },
    ];
    yield* fs.writeFileString(
      path.join(baseDir, "userdata", "panel-plugins.json"),
      JSON.stringify([
        {
          id: "viewer",
          connection: { kind: "server", baseUrl: `${plugin.origin}/plugins/viewer` },
          scopes: ["links"],
          links,
        },
        {
          id: "unscoped",
          connection: { kind: "server", baseUrl: `${plugin.origin}/plugins/unscoped` },
          links: [{ id: "message", prefix: "https://viewer.example/msg/" }],
        },
      ]),
    );
    const layer = testLayer(
      baseDir,
      manifestDirectory,
      { current: [] },
      yield* Queue.unbounded<unknown>(),
    );
    yield* Effect.gen(function* () {
      const panels = yield* PanelPlugins.PanelPlugins;
      const connected = plugin.nextConnection();
      const seen = yield* Queue.unbounded<ReadonlyArray<PluginLink>>();
      yield* panels.subscribeLinks().pipe(
        Stream.runForEach((value) => Queue.offer(seen, value)),
        Effect.forkScoped,
      );
      // Holding the link list keeps the plugin connected, though it has no panels; its links
      // are listed once it is.
      const listed = yield* Stream.fromQueue(seen).pipe(
        Stream.filter((value) => value.length > 0),
        Stream.runHead,
      );
      assert.deepStrictEqual(
        Option.getOrThrow(listed),
        links.map(({ id, ...link }) => ({ pluginId: "viewer", linkId: id, ...link })),
      );
      yield* Deferred.await(connected);
      const card = (input: { pluginId: string; linkId: string; url: string }, allowWeb = true) =>
        panels.linkCard(input, { allowWeb });

      const url = "https://viewer.example/msg/pacs.008/123";
      assert.deepStrictEqual(yield* card({ pluginId: "viewer", linkId: "message", url }), {
        surface: { title: `card ${url}`, blocks: [] },
      });
      const sent = yield* plugin.frame((frame) => frame.message.scope === "link");
      assert.deepStrictEqual(
        [sent.path, sent.message.type, sent.message.linkId, sent.message.url],
        ["/plugins/viewer", "surface", "message", url],
      );
      assert.equal("threadId" in sent.message || "projects" in sent.message, false);

      // A URL outside the prefix never reaches the plugin.
      const outside = yield* Effect.flip(
        card({ pluginId: "viewer", linkId: "message", url: "https://viewer.example/other/1" }),
      );
      assert.equal(outside.reason, "rejected");
      const web = yield* card({
        pluginId: "viewer",
        linkId: "page",
        url: "https://viewer.example/page/1",
      });
      assert.equal("webUrl" in web && web.webUrl.startsWith(PLUGIN_GATEWAY_PREFIX), true);
      assert.equal("webUrl" in web && web.webUrl.endsWith("/cards/msg.html"), true);
      assert.equal("height" in web && web.height, 200);
      const readOnly = yield* Effect.flip(
        card({ pluginId: "viewer", linkId: "page", url: "https://viewer.example/page/1" }, false),
      );
      assert.equal(readOnly.reason, "rejected");
      assert.equal(plugin.frames.filter((frame) => frame.message.scope === "link").length, 3);

      // Only a link declared with `resolve` is resolved, and only within its prefix.
      const staffUrl = "https://staff.example/u/42";
      assert.deepStrictEqual(
        yield* panels.linkResolve({ pluginId: "viewer", linkId: "staff", url: staffUrl }),
        { href: `https://internal.example/view?u=${staffUrl}`, text: "Resolved" },
      );
      const resolved = yield* plugin.frame((frame) => frame.message.type === "resolve");
      assert.deepStrictEqual(
        [resolved.message.scope, resolved.message.linkId, resolved.message.url],
        ["link", "staff", staffUrl],
      );
      const unresolvable = yield* Effect.flip(
        panels.linkResolve({ pluginId: "viewer", linkId: "message", url }),
      );
      assert.equal(unresolvable.reason, "rejected");
      const outsideStaff = yield* Effect.flip(
        panels.linkResolve({ pluginId: "viewer", linkId: "staff", url }),
      );
      assert.equal(outsideStaff.reason, "rejected");

      // Declaring links without the scope gets neither a connection nor link frames.
      const unscoped = yield* Effect.flip(
        panels.linkCard({ pluginId: "unscoped", linkId: "message", url }, { allowWeb: true }),
      );
      assert.equal(unscoped.reason, "not-connected");
      assert.equal(
        plugin.frames.some((frame) => frame.path === "/plugins/unscoped"),
        false,
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
