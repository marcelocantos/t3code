import * as NodeOS from "node:os";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  DiscoveredPluginId,
  PanelPluginConfig,
  PluginDiscoveryActionError,
  type PluginDiscoveryActionInput,
  type PluginDiscoveryItem,
  type PluginDiscoverySnapshot,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { ServerConfig } from "../config.ts";
import {
  normalizeLoopbackBaseUrl,
  type PluginCandidate,
  pluginManifestDirectory,
  scanLivePlugins,
} from "./PluginManifests.ts";

/** How often advertised services are re-checked while a client watches, beyond directory events. */
const RESCAN_INTERVAL = Duration.seconds(10);
const WATCH_DEBOUNCE = Duration.millis(100);
const MAX_DECISIONS = 64;

const Name = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const BaseUrl = Schema.String.check(Schema.isMaxLength(2048));
const Decision = Schema.Struct({
  id: DiscoveredPluginId,
  name: Name,
  status: Schema.Literals(["enabled", "disabled", "dismissed"]),
  baseUrl: Schema.optional(BaseUrl),
  /** Endpoint of an enabled plugin whose change of address the user declined. */
  dismissedBaseUrl: Schema.optional(BaseUrl),
});
type Decision = typeof Decision.Type;
const DecisionFile = Schema.Struct({
  version: Schema.Literal(1),
  plugins: Schema.Array(Decision).check(Schema.isMaxLength(MAX_DECISIONS)),
});
const decodeDecisions = Schema.decodeUnknownEffect(Schema.fromJsonString(DecisionFile));
const encodeDecisions = Schema.encodeEffect(Schema.fromJsonString(DecisionFile));
const decodeManualConfigs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PanelPluginConfig).check(Schema.isMaxLength(20))),
);
const isDiscoveredPluginId = Schema.is(DiscoveredPluginId);

export interface EffectivePluginConfigs {
  readonly configs: ReadonlyArray<PanelPluginConfig>;
  /** The hand-written configuration file could not be used. */
  readonly error: boolean;
}

interface ManualConfigs {
  readonly configs: ReadonlyArray<PanelPluginConfig>;
  readonly error: boolean;
}

interface State {
  readonly decisions: ReadonlyArray<Decision>;
  readonly candidates: ReadonlyArray<PluginCandidate>;
  readonly manual: ManualConfigs;
}

/** A different live endpoint an enabled plugin has moved to, unless its user already declined it. */
function pendingEndpoint(
  decision: Decision,
  candidates: ReadonlyArray<PluginCandidate>,
): PluginCandidate | undefined {
  if (decision.status !== "enabled") return undefined;
  const mine = candidates.filter((candidate) => candidate.id === decision.id);
  if (mine.some((candidate) => candidate.baseUrl === decision.baseUrl)) return undefined;
  return mine.find((candidate) => candidate.baseUrl !== decision.dismissedBaseUrl);
}

function discoverySnapshot(state: State): PluginDiscoverySnapshot {
  const manualIds = new Set(state.manual.configs.map((config) => config.id));
  const items: Array<PluginDiscoveryItem> = [];
  for (const config of state.manual.configs) {
    if (!isDiscoveredPluginId(config.id)) continue;
    const baseUrl = config.connection.kind === "server" ? config.connection.baseUrl : undefined;
    items.push({ id: config.id, name: config.id, state: "manual", baseUrl, live: false });
  }
  for (const decision of state.decisions) {
    if (manualIds.has(decision.id)) continue;
    const live = state.candidates.filter((candidate) => candidate.id === decision.id);
    if (decision.status === "dismissed") {
      items.push({
        id: decision.id,
        name: live[0]?.name ?? decision.name,
        state: "dismissed",
        baseUrl: live[0]?.baseUrl,
        live: live.length > 0,
      });
      continue;
    }
    items.push({
      id: decision.id,
      name: decision.name,
      state: decision.status,
      baseUrl: decision.baseUrl,
      discoveredBaseUrl: pendingEndpoint(decision, state.candidates)?.baseUrl,
      live: live.some((candidate) => candidate.baseUrl === decision.baseUrl),
    });
  }
  const known = new Set([...manualIds, ...state.decisions.map((decision) => decision.id)]);
  for (const candidate of state.candidates) {
    if (known.has(candidate.id)) continue;
    known.add(candidate.id);
    items.push({
      id: candidate.id,
      name: candidate.name,
      state: "offered",
      baseUrl: candidate.baseUrl,
      live: true,
    });
  }
  return { plugins: items.toSorted((a, b) => a.id.localeCompare(b.id)) };
}

function effectiveConfigs(state: State): EffectivePluginConfigs {
  const manualIds = new Set(state.manual.configs.map((config) => config.id));
  const discovered: Array<PanelPluginConfig> = [];
  for (const decision of state.decisions) {
    if (decision.status !== "enabled" || decision.baseUrl === undefined) continue;
    if (manualIds.has(decision.id)) continue;
    discovered.push({
      id: decision.id,
      connection: { kind: "server", baseUrl: decision.baseUrl },
    });
  }
  return { configs: [...state.manual.configs, ...discovered], error: state.manual.error };
}

const sameJson = <A>(a: A, b: A) => JSON.stringify(a) === JSON.stringify(b);

export class PluginDiscovery extends Context.Service<
  PluginDiscovery,
  {
    /** Advertised plugins and the user's decisions. Scanning runs only while someone watches. */
    readonly snapshots: Stream.Stream<PluginDiscoverySnapshot>;
    readonly act: (
      input: PluginDiscoveryActionInput,
    ) => Effect.Effect<void, PluginDiscoveryActionError>;
    /** Hand-written plus user-enabled plugin configurations, now and whenever they change. */
    readonly configs: Stream.Stream<EffectivePluginConfigs>;
  }
>()("t3/plugins/PluginDiscovery") {}

const makeWith = Effect.fn("PluginDiscovery.make")(function* (manifestDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const decisionsPath = path.join(config.stateDir, "plugin-discovery.json");
  const manualPath = path.join(config.stateDir, "panel-plugins.json");
  const serviceScope = yield* Effect.scope;

  const readManual = Effect.gen(function* () {
    if (!(yield* fs.exists(manualPath))) return { configs: [], error: false } as ManualConfigs;
    const configs = yield* fs.readFileString(manualPath).pipe(Effect.flatMap(decodeManualConfigs));
    const unique = new Set(configs.map((plugin) => plugin.id)).size === configs.length;
    return { configs: unique ? configs : [], error: !unique } as ManualConfigs;
  }).pipe(Effect.orElseSucceed((): ManualConfigs => ({ configs: [], error: true })));

  const readDecisions = Effect.gen(function* () {
    if (!(yield* fs.exists(decisionsPath))) return [] as ReadonlyArray<Decision>;
    const file = yield* fs.readFileString(decisionsPath).pipe(Effect.flatMap(decodeDecisions));
    const seen = new Set<string>();
    return file.plugins.flatMap((decision): Array<Decision> => {
      if (seen.has(decision.id)) return [];
      seen.add(decision.id);
      const baseUrl =
        decision.baseUrl === undefined ? undefined : normalizeLoopbackBaseUrl(decision.baseUrl);
      if (decision.status === "enabled" && baseUrl === undefined) return [];
      return [{ ...decision, baseUrl }];
    });
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("ignoring unreadable plugin discovery decisions", { cause }).pipe(
        Effect.as([] as ReadonlyArray<Decision>),
      ),
    ),
  );

  const state = yield* SubscriptionRef.make<State>({
    decisions: yield* readDecisions,
    candidates: [],
    manual: yield* readManual,
  });
  // One writer at a time: decisions are read, changed and saved under this lock.
  const lock = yield* Semaphore.make(1);

  const refresh = lock.withPermits(1)(
    Effect.gen(function* () {
      const [candidates, manual] = yield* Effect.all([
        scanLivePlugins(manifestDirectory),
        readManual,
      ]);
      yield* SubscriptionRef.update(state, (current) => ({ ...current, candidates, manual }));
    }),
  );

  const scanForever = Effect.gen(function* () {
    // Creating the directory lets the watcher attach before any plugin has ever run.
    yield* fs
      .makeDirectory(manifestDirectory, { recursive: true, mode: 0o700 })
      .pipe(Effect.ignore);
    const events = fs.watch(manifestDirectory).pipe(
      Stream.catch(() => Stream.empty),
      Stream.debounce(WATCH_DEBOUNCE),
    );
    // The watcher attaches alongside the first scan, so a manifest written during it is not missed.
    yield* Stream.merge(
      Stream.make(undefined),
      Stream.merge(events, Stream.tick(RESCAN_INTERVAL)),
    ).pipe(Stream.runForEach(() => refresh.pipe(Effect.ignoreCause({ log: true }))));
  });

  let watchers = 0;
  let scanner: Fiber.Fiber<void> | undefined;
  const watchersLock = yield* Semaphore.make(1);
  const retainScanner = Effect.acquireRelease(
    watchersLock.withPermits(1)(
      Effect.gen(function* () {
        watchers += 1;
        if (watchers === 1) scanner = yield* Effect.forkIn(scanForever, serviceScope);
      }),
    ),
    () =>
      watchersLock.withPermits(1)(
        Effect.gen(function* () {
          watchers -= 1;
          if (watchers > 0 || !scanner) return;
          const stopping = scanner;
          scanner = undefined;
          yield* Fiber.interrupt(stopping);
        }),
      ),
  );

  const save = (decisions: ReadonlyArray<Decision>, id: string) =>
    encodeDecisions({ version: 1, plugins: decisions }).pipe(
      Effect.flatMap((contents) =>
        writeFileStringAtomically({ filePath: decisionsPath, contents }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.tapError((cause) => Effect.logWarning("saving plugin decision failed", { cause })),
      Effect.mapError(
        () => new PluginDiscoveryActionError({ id: id as DiscoveredPluginId, reason: "storage" }),
      ),
    );

  const act: PluginDiscovery["Service"]["act"] = Effect.fn("PluginDiscovery.act")(
    function* (input) {
      const fail = (reason: PluginDiscoveryActionError["reason"]) =>
        new PluginDiscoveryActionError({ id: input.id, reason });
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(state);
          const existing = current.decisions.find((decision) => decision.id === input.id);
          const replace = (next: Decision | undefined) =>
            current.decisions
              .filter((decision) => decision.id !== input.id)
              .concat(next ? [next] : []);
          let next: ReadonlyArray<Decision>;
          switch (input.action) {
            case "enable": {
              const baseUrl = normalizeLoopbackBaseUrl(input.baseUrl);
              if (baseUrl === undefined) return yield* fail("not-available");
              if (current.manual.configs.some((plugin) => plugin.id === input.id)) {
                return yield* fail("invalid-state");
              }
              // Consent applies to the endpoint the user saw, so confirm it answers right now.
              const live = (yield* scanLivePlugins(manifestDirectory)).find(
                (candidate) => candidate.id === input.id && candidate.baseUrl === baseUrl,
              );
              const remembered = existing?.status === "disabled" && existing.baseUrl === baseUrl;
              if (!live && !remembered) return yield* fail("not-available");
              next = replace({
                id: input.id,
                name: live?.name ?? existing?.name ?? input.id,
                status: "enabled",
                baseUrl,
              });
              break;
            }
            case "dismiss": {
              if (!existing) {
                const live = current.candidates.find((candidate) => candidate.id === input.id);
                if (!live) return yield* fail("not-available");
                next = replace({ id: input.id, name: live.name, status: "dismissed" });
              } else {
                const moved = pendingEndpoint(existing, current.candidates);
                if (!moved) return yield* fail("invalid-state");
                next = replace({ ...existing, dismissedBaseUrl: moved.baseUrl });
              }
              break;
            }
            case "disable": {
              if (existing?.status !== "enabled") return yield* fail("invalid-state");
              const { dismissedBaseUrl: _declined, ...kept } = existing;
              next = replace({ ...kept, status: "disabled" });
              break;
            }
            case "reset": {
              if (!existing || existing.status === "enabled") return yield* fail("invalid-state");
              next = replace(undefined);
              break;
            }
          }
          if (next.length > MAX_DECISIONS) return yield* fail("limit");
          yield* save(next, input.id);
          yield* SubscriptionRef.update(state, (latest) => ({ ...latest, decisions: next }));
        }),
      );
    },
  );

  const snapshots = Stream.callback<PluginDiscoverySnapshot>(
    (queue) =>
      Effect.gen(function* () {
        yield* retainScanner;
        yield* SubscriptionRef.changes(state).pipe(
          Stream.map(discoverySnapshot),
          Stream.changesWith(sameJson),
          Stream.runForEach((snapshot) => Queue.offer(queue, snapshot)),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  const configs = Stream.unwrap(
    readManual.pipe(
      Effect.flatMap((manual) =>
        SubscriptionRef.update(state, (current) => ({ ...current, manual })),
      ),
      Effect.as(
        SubscriptionRef.changes(state).pipe(
          Stream.map(effectiveConfigs),
          Stream.changesWith(sameJson),
        ),
      ),
    ),
  );

  return PluginDiscovery.of({ snapshots, act, configs });
});

export const layerFromDirectory = (manifestDirectory: string) =>
  Layer.effect(PluginDiscovery, makeWith(manifestDirectory));

export const layer = Layer.unwrap(
  Effect.sync(() => layerFromDirectory(pluginManifestDirectory(process.env, NodeOS.homedir()))),
);
