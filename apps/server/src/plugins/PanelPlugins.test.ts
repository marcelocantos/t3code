// @effect-diagnostics nodeBuiltinImport:off -- The slice runs a real plugin: one loopback listener answers the probe and the panel socket.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { WebSocketServer } from "ws";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ThreadId, type PluginPanelSnapshot } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PanelPlugins from "./PanelPlugins.ts";
import * as PluginDiscovery from "./PluginDiscovery.ts";
import * as PluginGateway from "./PluginGateway.ts";

/** A plugin: probe answer on plain GET, panel snapshots on the same route's WebSocket. */
const ALPHA = "github.com/acme/alpha";

const startPlugin = Effect.acquireRelease(
  Effect.promise(async () => {
    const sockets = new Set<import("ws").WebSocket>();
    const connected = new Array<Deferred.Deferred<void>>();
    const closed = new Array<Deferred.Deferred<void>>();
    const server = NodeHttp.createServer((_request, response) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ protocol: 1, id: ALPHA, name: "Alpha" })),
    );
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => {
      sockets.add(socket);
      for (const deferred of connected) Deferred.doneUnsafe(deferred, Effect.void);
      socket.on("close", () => {
        sockets.delete(socket);
        for (const deferred of closed) Deferred.doneUnsafe(deferred, Effect.void);
      });
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "subscribe") return;
        socket.send(
          JSON.stringify({
            type: "panels",
            subscriptionId: message.subscriptionId,
            panels: [
              { id: "list", title: `cwd ${message.cwd}`, rows: [], filters: [], filter: "all" },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No plugin address");
    return {
      baseUrl: `http://127.0.0.1:${address.port}/plugins/alpha`,
      sockets,
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

    const layer = PanelPlugins.layer.pipe(
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
        }),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
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
