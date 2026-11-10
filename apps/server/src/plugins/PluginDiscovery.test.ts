// @effect-diagnostics nodeBuiltinImport:off -- Tests advertise plugins through real files and a real loopback HTTP service.
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { PluginDiscoveryActionInput, PluginDiscoverySnapshot } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as PluginDiscovery from "./PluginDiscovery.ts";

interface Service {
  readonly baseUrl: string;
  readonly stop: Effect.Effect<void>;
}

/** A loopback service that answers the context-free probe as the named plugin. */
const startService = (id: string, name: string, path = "/plugins/t3") =>
  Effect.promise(async (): Promise<Service> => {
    const server = NodeHttp.createServer((_request, response) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ protocol: 1, id, name })),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No service address");
    return {
      baseUrl: `http://127.0.0.1:${address.port}${path}`,
      stop: Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    };
  });

const runningService = (id: string, name: string, path?: string) =>
  Effect.acquireRelease(startService(id, name, path), (service) => service.stop);

const withEnvironment = <A, E>(
  body: (environment: {
    readonly manifestDirectory: string;
    readonly stateDirectory: string;
    readonly advertise: (
      file: string,
      id: string,
      name: string,
      baseUrl: string,
    ) => Effect.Effect<void>;
    /** A fresh service over the same state, as after a restart. */
    readonly start: <B, F>(
      effect: Effect.Effect<B, F, PluginDiscovery.PluginDiscovery | Scope.Scope>,
    ) => Effect.Effect<B, F | PlatformError.PlatformError>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-plugin-discovery-" });
    const manifestDirectory = path.join(baseDir, "plugins");
    yield* fs.makeDirectory(manifestDirectory, { recursive: true, mode: 0o700 });
    yield* fs.chmod(manifestDirectory, 0o700);
    const stateDirectory = path.join(baseDir, "userdata");
    yield* fs.makeDirectory(stateDirectory, { recursive: true });
    const service = PluginDiscovery.layerFromDirectory(manifestDirectory).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provide(NodeServices.layer),
    );
    return yield* body({
      manifestDirectory,
      stateDirectory,
      advertise: (file, id, name, baseUrl) =>
        Effect.orDie(
          fs.writeFileString(
            path.join(manifestDirectory, file),
            JSON.stringify({
              protocol: 1,
              id,
              name,
              connection: { kind: "server", baseUrl },
            }),
          ),
        ),
      start: (effect) => effect.pipe(Effect.scoped, Effect.provide(service)),
    });
  }).pipe(Effect.scoped);

/** First snapshot, from a stream that scans while open, satisfying the condition. */
const until = (
  discovery: PluginDiscovery.PluginDiscovery["Service"],
  condition: (snapshot: PluginDiscoverySnapshot) => boolean,
) =>
  discovery.snapshots.pipe(
    Stream.filter(condition),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const item = (snapshot: PluginDiscoverySnapshot | undefined, id: string) =>
  snapshot?.plugins.find((plugin) => plugin.id === id);

const act = (
  discovery: PluginDiscovery.PluginDiscovery["Service"],
  input: PluginDiscoveryActionInput,
) => Effect.flip(discovery.act(input));

const firstConfigs = (discovery: PluginDiscovery.PluginDiscovery["Service"]) =>
  discovery.configs.pipe(Stream.runHead);

const test = <E>(name: string, effect: Effect.Effect<void, E, FileSystem.FileSystem | Path.Path>) =>
  it.live(name, () => effect.pipe(Effect.provide(NodeServices.layer)));

test(
  "offers an advertised service and notices later additions",
  withEnvironment(({ advertise, start }) =>
    Effect.gen(function* () {
      const first = yield* runningService("alpha", "Alpha");
      const second = yield* runningService("beta", "Beta");
      yield* advertise("alpha-1.json", "alpha", "Alpha", first.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const offers = yield* Queue.unbounded<PluginDiscoverySnapshot>();
          yield* discovery.snapshots.pipe(
            Stream.runForEach((snapshot) => Queue.offer(offers, snapshot)),
            Effect.forkScoped,
          );
          const initial = yield* Stream.fromQueue(offers).pipe(
            Stream.filter((snapshot) => item(snapshot, "alpha")?.state === "offered"),
            Stream.runHead,
          );
          assert.deepEqual(item(initial._tag === "Some" ? initial.value : undefined, "alpha"), {
            id: "alpha",
            name: "Alpha",
            state: "offered",
            baseUrl: first.baseUrl,
            live: true,
          });
          // Nothing is connected or enabled by being offered.
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(configs._tag === "Some" ? configs.value.configs : undefined, []);

          yield* advertise("beta-1.json", "beta", "Beta", second.baseUrl);
          const later = yield* Stream.fromQueue(offers).pipe(
            Stream.filter((snapshot) => item(snapshot, "beta")?.state === "offered"),
            Stream.runHead,
          );
          assert.equal(later._tag, "Some");
        }),
      );
    }),
  ),
);

test(
  "enabling saves the configuration, activates it live, and survives a restart",
  withEnvironment(({ advertise, start, stateDirectory }) =>
    Effect.gen(function* () {
      const service = yield* runningService("alpha", "Alpha");
      yield* advertise("alpha-1.json", "alpha", "Alpha", service.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const configs = yield* Queue.unbounded<PluginDiscovery.EffectivePluginConfigs>();
          yield* discovery.configs.pipe(
            Stream.runForEach((value) => Queue.offer(configs, value)),
            Effect.forkScoped,
          );
          assert.deepEqual((yield* Queue.take(configs)).configs, []);
          yield* until(discovery, (snapshot) => item(snapshot, "alpha")?.state === "offered");

          yield* discovery.act({ action: "enable", id: "alpha", baseUrl: service.baseUrl });
          // The already-open consumer learns of the new plugin without reopening anything.
          assert.deepEqual((yield* Queue.take(configs)).configs, [
            { id: "alpha", connection: { kind: "server", baseUrl: service.baseUrl } },
          ]);
        }),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const saved = yield* fs.readFileString(path.join(stateDirectory, "plugin-discovery.json"));
      assert.deepEqual(JSON.parse(saved), {
        version: 1,
        plugins: [{ id: "alpha", name: "Alpha", status: "enabled", baseUrl: service.baseUrl }],
      });
      // After a restart the choice stands, with no manifest and no live service needed.
      yield* service.stop;
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(configs._tag === "Some" ? configs.value.configs.map((c) => c.id) : [], [
            "alpha",
          ]);
        }),
      );
    }),
  ),
);

test(
  "refuses endpoints the user did not see or that do not answer",
  withEnvironment(({ advertise, start }) =>
    Effect.gen(function* () {
      const service = yield* runningService("alpha", "Alpha");
      const impostor = yield* runningService("other", "Other");
      yield* advertise("alpha-1.json", "alpha", "Alpha", service.baseUrl);
      // A second manifest claims the id but its service identifies as something else.
      yield* advertise("alpha-2.json", "alpha", "Alpha", impostor.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const reasons = [];
          for (const baseUrl of [
            impostor.baseUrl,
            "http://127.0.0.1:1/plugins/t3",
            "https://example.com/plugins/t3",
            "http://127.0.0.1:9/plugins/t3?x=1",
          ]) {
            reasons.push(
              (yield* act(discovery, { action: "enable", id: "alpha", baseUrl })).reason,
            );
          }
          assert.deepEqual(reasons, [
            "not-available",
            "not-available",
            "not-available",
            "not-available",
          ]);
          assert.equal(
            (yield* act(discovery, { action: "enable", id: "unknown", baseUrl: service.baseUrl }))
              .reason,
            "not-available",
          );
          // A service that vanished between display and click is not enabled.
          yield* service.stop;
          assert.equal(
            (yield* act(discovery, { action: "enable", id: "alpha", baseUrl: service.baseUrl }))
              .reason,
            "not-available",
          );
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(configs._tag === "Some" ? configs.value.configs : undefined, []);
        }),
      );
    }),
  ),
);

test(
  "remembers dismissal across restarts and endpoint changes until reset",
  withEnvironment(({ advertise, start }) =>
    Effect.gen(function* () {
      const first = yield* runningService("alpha", "Alpha");
      yield* advertise("alpha-1.json", "alpha", "Alpha", first.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          yield* until(discovery, (snapshot) => item(snapshot, "alpha")?.state === "offered");
          yield* discovery.act({ action: "dismiss", id: "alpha" });
        }),
      );
      // The service restarts on another port and advertises again; the user is not asked again.
      const moved = yield* runningService("alpha", "Alpha");
      yield* advertise("alpha-1.json", "alpha", "Alpha", moved.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const snapshot = yield* until(discovery, (value) => item(value, "alpha")?.live === true);
          assert.equal(item(snapshot, "alpha")?.state, "dismissed");
          assert.deepEqual(
            snapshot?.plugins.filter((plugin) => plugin.state === "offered"),
            [],
          );
          assert.equal(
            (yield* act(discovery, { action: "disable", id: "alpha" })).reason,
            "invalid-state",
          );

          // Resetting forgets the decision, so the live service is offered afresh.
          yield* discovery.act({ action: "reset", id: "alpha" });
          const offered = yield* until(
            discovery,
            (value) => item(value, "alpha")?.state === "offered",
          );
          assert.equal(item(offered, "alpha")?.baseUrl, moved.baseUrl);
        }),
      );
    }),
  ),
);

test(
  "disables and re-enables without needing the service to be live",
  withEnvironment(({ advertise, start }) =>
    Effect.gen(function* () {
      const service = yield* runningService("alpha", "Alpha");
      yield* advertise("alpha-1.json", "alpha", "Alpha", service.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          yield* discovery.act({ action: "enable", id: "alpha", baseUrl: service.baseUrl });
          assert.equal(
            (yield* act(discovery, { action: "reset", id: "alpha" })).reason,
            "invalid-state",
          );

          yield* discovery.act({ action: "disable", id: "alpha" });
          const disabled = yield* until(
            discovery,
            (snapshot) => item(snapshot, "alpha")?.state === "disabled",
          );
          assert.equal(item(disabled, "alpha")?.baseUrl, service.baseUrl);
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(configs._tag === "Some" ? configs.value.configs : undefined, []);

          // Disabled plugins are not re-offered, even though the manifest is still there.
          assert.deepEqual(
            (yield* until(discovery, () => true))?.plugins.filter((p) => p.state === "offered"),
            [],
          );

          yield* service.stop;
          yield* discovery.act({ action: "enable", id: "alpha", baseUrl: service.baseUrl });
          const again = yield* firstConfigs(discovery);
          assert.deepEqual(again._tag === "Some" ? again.value.configs.map((c) => c.id) : [], [
            "alpha",
          ]);
        }),
      );
    }),
  ),
);

test(
  "does not silently follow an enabled plugin to a different endpoint",
  withEnvironment(({ advertise, start }) =>
    Effect.gen(function* () {
      const original = yield* runningService("alpha", "Alpha");
      yield* advertise("alpha-1.json", "alpha", "Alpha", original.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          yield* discovery.act({ action: "enable", id: "alpha", baseUrl: original.baseUrl });
        }),
      );
      yield* original.stop;
      const moved = yield* runningService("alpha", "Alpha");
      yield* advertise("alpha-1.json", "alpha", "Alpha", moved.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const snapshot = yield* until(
            discovery,
            (value) => item(value, "alpha")?.discoveredBaseUrl !== undefined,
          );
          assert.equal(item(snapshot, "alpha")?.baseUrl, original.baseUrl);
          assert.equal(item(snapshot, "alpha")?.discoveredBaseUrl, moved.baseUrl);
          // Until the user agrees, the connection still points at what they approved.
          const before = yield* firstConfigs(discovery);
          assert.deepEqual(before._tag === "Some" ? before.value.configs : undefined, [
            { id: "alpha", connection: { kind: "server", baseUrl: original.baseUrl } },
          ]);
          // Declining stops the prompt; so does approving.
          yield* discovery.act({ action: "dismiss", id: "alpha" });
          const declined = yield* until(discovery, () => true);
          assert.equal(item(declined, "alpha")?.discoveredBaseUrl, undefined);
          assert.equal(item(declined, "alpha")?.state, "enabled");
        }),
      );
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const snapshot = yield* until(
            discovery,
            (value) => item(value, "alpha")?.state === "enabled",
          );
          // The refusal persisted; no prompt returns after a restart.
          assert.equal(item(snapshot, "alpha")?.discoveredBaseUrl, undefined);
          yield* discovery.act({ action: "enable", id: "alpha", baseUrl: moved.baseUrl });
          const after = yield* firstConfigs(discovery);
          assert.deepEqual(after._tag === "Some" ? after.value.configs : undefined, [
            { id: "alpha", connection: { kind: "server", baseUrl: moved.baseUrl } },
          ]);
        }),
      );
    }),
  ),
);

test(
  "keeps hand-written configuration authoritative",
  withEnvironment(({ advertise, start, stateDirectory }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* runningService("alpha", "Alpha");
      yield* advertise("alpha-1.json", "alpha", "Alpha", service.baseUrl);
      const manual = {
        id: "alpha",
        connection: { kind: "server" as const, baseUrl: "http://127.0.0.1:5/x" },
      };
      yield* fs.writeFileString(
        path.join(stateDirectory, "panel-plugins.json"),
        JSON.stringify([manual]),
      );
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const snapshot = yield* until(discovery, (value) => item(value, "alpha") !== undefined);
          assert.equal(item(snapshot, "alpha")?.state, "manual");
          assert.equal(
            (yield* act(discovery, { action: "enable", id: "alpha", baseUrl: service.baseUrl }))
              .reason,
            "invalid-state",
          );
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(configs._tag === "Some" ? configs.value : undefined, {
            configs: [manual],
            error: false,
          });
        }),
      );
    }),
  ),
);

test(
  "reports an unusable hand-written file but still honours decisions",
  withEnvironment(({ advertise, start, stateDirectory }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* runningService("alpha", "Alpha");
      yield* advertise("alpha-1.json", "alpha", "Alpha", service.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          yield* discovery.act({ action: "enable", id: "alpha", baseUrl: service.baseUrl });
        }),
      );
      yield* fs.writeFileString(path.join(stateDirectory, "panel-plugins.json"), "{broken");
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const configs = yield* firstConfigs(discovery);
          assert.equal(configs._tag === "Some" ? configs.value.error : undefined, true);
          assert.deepEqual(configs._tag === "Some" ? configs.value.configs.map((c) => c.id) : [], [
            "alpha",
          ]);
        }),
      );
    }),
  ),
);

test(
  "serializes concurrent decisions so none is lost",
  withEnvironment(({ advertise, start, stateDirectory }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const a = yield* runningService("alpha", "Alpha");
      const b = yield* runningService("beta", "Beta");
      const c = yield* runningService("gamma", "Gamma");
      yield* advertise("a.json", "alpha", "Alpha", a.baseUrl);
      yield* advertise("b.json", "beta", "Beta", b.baseUrl);
      yield* advertise("c.json", "gamma", "Gamma", c.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          yield* until(
            discovery,
            (snapshot) => snapshot.plugins.filter((p) => p.state === "offered").length === 3,
          );
          yield* Effect.all(
            [
              discovery.act({ action: "enable", id: "alpha", baseUrl: a.baseUrl }),
              discovery.act({ action: "dismiss", id: "beta" }),
              discovery.act({ action: "enable", id: "gamma", baseUrl: c.baseUrl }),
            ],
            { concurrency: "unbounded" },
          );
        }),
      );
      const saved = JSON.parse(
        yield* fs.readFileString(path.join(stateDirectory, "plugin-discovery.json")),
      ) as { plugins: Array<{ id: string; status: string }> };
      assert.deepEqual(saved.plugins.map((p) => `${p.id}:${p.status}`).toSorted(), [
        "alpha:enabled",
        "beta:dismissed",
        "gamma:enabled",
      ]);
    }),
  ),
);

test(
  "starts empty when the saved decisions are unreadable",
  withEnvironment(({ start, stateDirectory }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(stateDirectory, "plugin-discovery.json"), "{nope");
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(configs._tag === "Some" ? configs.value.configs : undefined, []);
          assert.deepEqual((yield* until(discovery, () => true))?.plugins, []);
        }),
      );
    }),
  ),
);

test(
  "drops saved enabled decisions that point outside loopback",
  withEnvironment(({ start, stateDirectory }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(stateDirectory, "plugin-discovery.json"),
        JSON.stringify({
          version: 1,
          plugins: [
            { id: "evil", name: "Evil", status: "enabled", baseUrl: "http://example.com:80/x" },
          ],
        }),
      );
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(configs._tag === "Some" ? configs.value.configs : undefined, []);
        }),
      );
    }),
  ),
);
