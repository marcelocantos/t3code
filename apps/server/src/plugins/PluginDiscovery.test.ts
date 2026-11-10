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
  /** Change the scopes the probe declares from now on. */
  readonly declare: (scopes: ReadonlyArray<string>) => void;
}

/** Identity of the fictional project `acme/<name>` that runs a test plugin. */
const identity = (name: string) => `github.com/acme/${name}`;

/** A loopback service that answers the context-free probe as the named plugin. */
const startService = (
  id: string,
  name: string,
  path = "/plugins/t3",
  scopes?: ReadonlyArray<string>,
) =>
  Effect.promise(async (): Promise<Service> => {
    let declared = scopes;
    const server = NodeHttp.createServer((_request, response) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ protocol: 1, id: identity(id), name, scopes: declared })),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No service address");
    return {
      baseUrl: `http://127.0.0.1:${address.port}${path}`,
      stop: Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      declare: (next) => {
        declared = next;
      },
    };
  });

const runningService = (id: string, name: string, path?: string, scopes?: ReadonlyArray<string>) =>
  Effect.acquireRelease(startService(id, name, path, scopes), (service) => service.stop);

const withEnvironment = <A, E>(
  body: (environment: {
    readonly manifestDirectory: string;
    readonly stateDirectory: string;
    readonly advertise: (
      instance: string,
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
      advertise: (instance, id, name, baseUrl) =>
        Effect.orDie(
          fs.writeFileString(
            path.join(manifestDirectory, `${id.replaceAll("/", "+")}+${instance}.json`),
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
      yield* advertise("1", "github.com/acme/alpha", "Alpha", first.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const offers = yield* Queue.unbounded<PluginDiscoverySnapshot>();
          yield* discovery.snapshots.pipe(
            Stream.runForEach((snapshot) => Queue.offer(offers, snapshot)),
            Effect.forkScoped,
          );
          // The first snapshot already reflects a scan, so clients can tell startup offers apart.
          const initial = yield* Stream.fromQueue(offers).pipe(Stream.runHead);
          assert.deepEqual(
            item(initial._tag === "Some" ? initial.value : undefined, identity("alpha")),
            {
              id: "github.com/acme/alpha",
              name: "Alpha",
              state: "offered",
              baseUrl: first.baseUrl,
              live: true,
            },
          );
          // Nothing is connected or enabled by being offered.
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(configs._tag === "Some" ? configs.value.configs : undefined, []);

          yield* advertise("1", "github.com/acme/beta", "Beta", second.baseUrl);
          const later = yield* Stream.fromQueue(offers).pipe(
            Stream.filter((snapshot) => item(snapshot, identity("beta"))?.state === "offered"),
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
      // Scopes from the probe ride along; ones this T3 doesn't know are dropped, not fatal.
      const service = yield* runningService("alpha", "Alpha", undefined, [
        "environment",
        "sidebar",
        "thread",
      ]);
      yield* advertise("1", "github.com/acme/alpha", "Alpha", service.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const configs = yield* Queue.unbounded<PluginDiscovery.EffectivePluginConfigs>();
          yield* discovery.configs.pipe(
            Stream.runForEach((value) => Queue.offer(configs, value)),
            Effect.forkScoped,
          );
          assert.deepEqual((yield* Queue.take(configs)).configs, []);
          yield* until(
            discovery,
            (snapshot) => item(snapshot, identity("alpha"))?.state === "offered",
          );

          yield* discovery.act({
            action: "enable",
            id: "github.com/acme/alpha",
            baseUrl: service.baseUrl,
          });
          // The already-open consumer learns of the new plugin without reopening anything.
          assert.deepEqual((yield* Queue.take(configs)).configs, [
            {
              id: "github.com/acme/alpha",
              connection: { kind: "server", baseUrl: service.baseUrl },
              scopes: ["environment", "thread"],
            },
          ]);
        }),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const saved = yield* fs.readFileString(path.join(stateDirectory, "plugin-discovery.json"));
      assert.deepEqual(JSON.parse(saved), {
        version: 1,
        plugins: [
          {
            id: "github.com/acme/alpha",
            name: "Alpha",
            status: "enabled",
            baseUrl: service.baseUrl,
            scopes: ["environment", "thread"],
            approvedScopes: ["environment", "thread"],
          },
        ],
      });
      // After a restart the choice stands, with no manifest and no live service needed.
      yield* service.stop;
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(
            configs._tag === "Some"
              ? configs.value.configs.map((c) => [c.id, c.scopes] as const)
              : [],
            [[identity("alpha"), ["environment", "thread"]]],
          );
        }),
      );
    }),
  ),
);

test(
  "a plugin that widens its scopes waits for fresh consent and may narrow silently",
  withEnvironment(({ advertise, start }) =>
    Effect.gen(function* () {
      const service = yield* runningService("alpha", "Alpha", undefined, ["thread"]);
      yield* advertise("1", "github.com/acme/alpha", "Alpha", service.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const scopesOf = (value: PluginDiscovery.EffectivePluginConfigs) =>
            value.configs.find((config) => config.id === identity("alpha"))?.scopes;
          const configs = yield* Queue.unbounded<PluginDiscovery.EffectivePluginConfigs>();
          yield* discovery.configs.pipe(
            Stream.runForEach((value) => Queue.offer(configs, value)),
            Effect.forkScoped,
          );
          // Scanning runs only while someone watches, as a settings page would.
          yield* discovery.snapshots.pipe(Stream.runDrain, Effect.forkScoped);
          yield* until(discovery, (snapshot) => item(snapshot, identity("alpha")) !== undefined);
          const enable = { action: "enable", id: identity("alpha"), baseUrl: service.baseUrl };
          yield* discovery.act({ ...enable, action: "enable" });
          const approved = yield* Stream.fromQueue(configs).pipe(
            Stream.filter((value) => scopesOf(value) !== undefined),
            Stream.runHead,
          );
          assert.deepEqual(approved._tag === "Some" ? scopesOf(approved.value) : [], ["thread"]);

          // The plugin starts asking for every project; nothing widens until the user allows it.
          service.declare(["thread", "environment"]);
          yield* advertise("1", "github.com/acme/alpha", "Alpha", service.baseUrl);
          const pending = yield* until(
            discovery,
            (snapshot) => item(snapshot, identity("alpha"))?.pendingScopes !== undefined,
          );
          assert.deepEqual(item(pending, identity("alpha"))?.pendingScopes, ["environment"]);
          assert.deepEqual(
            (yield* firstConfigs(discovery)).pipe(Option.map(scopesOf), Option.getOrUndefined),
            ["thread"],
          );

          yield* discovery.act({ ...enable, action: "enable" });
          const allowed = yield* until(
            discovery,
            (snapshot) => item(snapshot, identity("alpha"))?.pendingScopes === undefined,
          );
          assert.equal(item(allowed, identity("alpha"))?.state, "enabled");
          assert.deepEqual(
            (yield* firstConfigs(discovery)).pipe(Option.map(scopesOf), Option.getOrUndefined),
            ["thread", "environment"],
          );

          // Dropping a scope needs no consent.
          service.declare(["environment"]);
          yield* advertise("1", "github.com/acme/alpha", "Alpha", service.baseUrl);
          const narrowed = yield* Stream.fromQueue(configs).pipe(
            Stream.filter((value) => scopesOf(value)?.length === 1),
            Stream.runHead,
          );
          assert.deepEqual(narrowed._tag === "Some" ? scopesOf(narrowed.value) : [], [
            "environment",
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
      yield* advertise("1", "github.com/acme/alpha", "Alpha", service.baseUrl);
      // A second manifest claims the id but its service identifies as something else.
      yield* advertise("2", "github.com/acme/alpha", "Alpha", impostor.baseUrl);
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
              (yield* act(discovery, { action: "enable", id: "github.com/acme/alpha", baseUrl }))
                .reason,
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
            (yield* act(discovery, {
              action: "enable",
              id: "github.com/acme/alpha",
              baseUrl: service.baseUrl,
            })).reason,
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
      yield* advertise("1", "github.com/acme/alpha", "Alpha", first.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          yield* until(
            discovery,
            (snapshot) => item(snapshot, identity("alpha"))?.state === "offered",
          );
          yield* discovery.act({ action: "dismiss", id: "github.com/acme/alpha" });
        }),
      );
      // The service restarts on another port and advertises again; the user is not asked again.
      const moved = yield* runningService("alpha", "Alpha");
      yield* advertise("1", "github.com/acme/alpha", "Alpha", moved.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const snapshot = yield* until(
            discovery,
            (value) => item(value, identity("alpha"))?.live === true,
          );
          assert.equal(item(snapshot, identity("alpha"))?.state, "dismissed");
          assert.deepEqual(
            snapshot?.plugins.filter((plugin) => plugin.state === "offered"),
            [],
          );
          assert.equal(
            (yield* act(discovery, { action: "disable", id: "github.com/acme/alpha" })).reason,
            "invalid-state",
          );

          // Resetting forgets the decision, so the live service is offered afresh.
          yield* discovery.act({ action: "reset", id: "github.com/acme/alpha" });
          const offered = yield* until(
            discovery,
            (value) => item(value, identity("alpha"))?.state === "offered",
          );
          assert.equal(item(offered, identity("alpha"))?.baseUrl, moved.baseUrl);
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
      yield* advertise("1", "github.com/acme/alpha", "Alpha", service.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          yield* discovery.act({
            action: "enable",
            id: "github.com/acme/alpha",
            baseUrl: service.baseUrl,
          });
          assert.equal(
            (yield* act(discovery, { action: "reset", id: "github.com/acme/alpha" })).reason,
            "invalid-state",
          );

          yield* discovery.act({ action: "disable", id: "github.com/acme/alpha" });
          const disabled = yield* until(
            discovery,
            (snapshot) => item(snapshot, identity("alpha"))?.state === "disabled",
          );
          assert.equal(item(disabled, identity("alpha"))?.baseUrl, service.baseUrl);
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(configs._tag === "Some" ? configs.value.configs : undefined, []);

          // Disabled plugins are not re-offered, even though the manifest is still there.
          assert.deepEqual(
            (yield* until(discovery, () => true))?.plugins.filter((p) => p.state === "offered"),
            [],
          );

          yield* service.stop;
          yield* discovery.act({
            action: "enable",
            id: "github.com/acme/alpha",
            baseUrl: service.baseUrl,
          });
          const again = yield* firstConfigs(discovery);
          assert.deepEqual(again._tag === "Some" ? again.value.configs.map((c) => c.id) : [], [
            identity("alpha"),
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
      yield* advertise("1", "github.com/acme/alpha", "Alpha", original.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          yield* discovery.act({
            action: "enable",
            id: "github.com/acme/alpha",
            baseUrl: original.baseUrl,
          });
        }),
      );
      yield* original.stop;
      const moved = yield* runningService("alpha", "Alpha");
      yield* advertise("1", "github.com/acme/alpha", "Alpha", moved.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const snapshot = yield* until(
            discovery,
            (value) => item(value, identity("alpha"))?.discoveredBaseUrl !== undefined,
          );
          assert.equal(item(snapshot, identity("alpha"))?.baseUrl, original.baseUrl);
          assert.equal(item(snapshot, identity("alpha"))?.discoveredBaseUrl, moved.baseUrl);
          // Until the user agrees, the connection still points at what they approved.
          const before = yield* firstConfigs(discovery);
          assert.deepEqual(before._tag === "Some" ? before.value.configs : undefined, [
            {
              id: "github.com/acme/alpha",
              connection: { kind: "server", baseUrl: original.baseUrl },
            },
          ]);
          // Declining stops the prompt; so does approving.
          yield* discovery.act({ action: "dismiss", id: "github.com/acme/alpha" });
          const declined = yield* until(discovery, () => true);
          assert.equal(item(declined, identity("alpha"))?.discoveredBaseUrl, undefined);
          assert.equal(item(declined, identity("alpha"))?.state, "enabled");
        }),
      );
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const snapshot = yield* until(
            discovery,
            (value) => item(value, identity("alpha"))?.state === "enabled",
          );
          // The refusal persisted; no prompt returns after a restart.
          assert.equal(item(snapshot, identity("alpha"))?.discoveredBaseUrl, undefined);
          yield* discovery.act({
            action: "enable",
            id: "github.com/acme/alpha",
            baseUrl: moved.baseUrl,
          });
          const after = yield* firstConfigs(discovery);
          assert.deepEqual(after._tag === "Some" ? after.value.configs : undefined, [
            { id: "github.com/acme/alpha", connection: { kind: "server", baseUrl: moved.baseUrl } },
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
      yield* advertise("1", "github.com/acme/alpha", "Alpha", service.baseUrl);
      const manual = {
        id: "github.com/acme/alpha",
        connection: { kind: "server" as const, baseUrl: "http://127.0.0.1:5/x" },
      };
      yield* fs.writeFileString(
        path.join(stateDirectory, "panel-plugins.json"),
        JSON.stringify([manual]),
      );
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const snapshot = yield* until(
            discovery,
            (value) => item(value, identity("alpha")) !== undefined,
          );
          assert.equal(item(snapshot, identity("alpha"))?.state, "manual");
          assert.equal(
            (yield* act(discovery, {
              action: "enable",
              id: "github.com/acme/alpha",
              baseUrl: service.baseUrl,
            })).reason,
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
      yield* advertise("1", "github.com/acme/alpha", "Alpha", service.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          yield* discovery.act({
            action: "enable",
            id: "github.com/acme/alpha",
            baseUrl: service.baseUrl,
          });
        }),
      );
      yield* fs.writeFileString(path.join(stateDirectory, "panel-plugins.json"), "{broken");
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const configs = yield* firstConfigs(discovery);
          assert.equal(configs._tag === "Some" ? configs.value.error : undefined, true);
          assert.deepEqual(configs._tag === "Some" ? configs.value.configs.map((c) => c.id) : [], [
            identity("alpha"),
          ]);
        }),
      );
    }),
  ),
);

test(
  "keeps a hand-written short id and a decision saved under one working",
  withEnvironment(({ start, stateDirectory }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(stateDirectory, "panel-plugins.json"),
        JSON.stringify([
          { id: "bullseye", connection: { kind: "server", baseUrl: "http://127.0.0.1:5/x" } },
        ]),
      );
      yield* fs.writeFileString(
        path.join(stateDirectory, "plugin-discovery.json"),
        JSON.stringify({
          version: 1,
          plugins: [
            { id: "legacy", name: "Legacy", status: "enabled", baseUrl: "http://127.0.0.1:6/y" },
          ],
        }),
      );
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          const configs = yield* firstConfigs(discovery);
          assert.deepEqual(
            configs._tag === "Some" ? configs.value.configs.map((c) => c.id).toSorted() : [],
            ["bullseye", "legacy"],
          );
          const snapshot = yield* until(
            discovery,
            (value) => item(value, "bullseye") !== undefined,
          );
          assert.equal(item(snapshot, "bullseye")?.state, "manual");
          assert.equal(item(snapshot, "legacy")?.state, "enabled");
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
      yield* advertise("a", "github.com/acme/alpha", "Alpha", a.baseUrl);
      yield* advertise("b", "github.com/acme/beta", "Beta", b.baseUrl);
      yield* advertise("c", "github.com/acme/gamma", "Gamma", c.baseUrl);
      yield* start(
        Effect.gen(function* () {
          const discovery = yield* PluginDiscovery.PluginDiscovery;
          yield* until(
            discovery,
            (snapshot) => snapshot.plugins.filter((p) => p.state === "offered").length === 3,
          );
          yield* Effect.all(
            [
              discovery.act({ action: "enable", id: "github.com/acme/alpha", baseUrl: a.baseUrl }),
              discovery.act({ action: "dismiss", id: "github.com/acme/beta" }),
              discovery.act({ action: "enable", id: "github.com/acme/gamma", baseUrl: c.baseUrl }),
            ],
            { concurrency: "unbounded" },
          );
        }),
      );
      const saved = JSON.parse(
        yield* fs.readFileString(path.join(stateDirectory, "plugin-discovery.json")),
      ) as { plugins: Array<{ id: string; status: string }> };
      assert.deepEqual(saved.plugins.map((p) => `${p.id}:${p.status}`).toSorted(), [
        "github.com/acme/alpha:enabled",
        "github.com/acme/beta:dismissed",
        "github.com/acme/gamma:enabled",
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
