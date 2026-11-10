import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  PanelPluginConfig,
  PluginPanelRequestError,
  type PluginActionResult,
  type PluginLink,
  type PluginLinkCard,
  type PluginLinkCardInput,
  type PluginPanelActionInput,
  type PluginPanelScope,
  type PluginPanelSnapshot,
  type PluginPanelSurfaceInput,
  type PluginPanelTarget,
  type PluginSurface,
  type SubscribeEnvironmentPluginPanelsInput,
  type SubscribePluginPanelsInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PluginGateway from "./PluginGateway.ts";
import * as PluginDiscovery from "./PluginDiscovery.ts";
import {
  PanelPluginConnection,
  type PluginFrameTarget,
  type PluginProject,
  type PluginRequestFrame,
  type PluginRequestResult,
} from "./PanelPluginConnection.ts";
import { PLUGIN_GATEWAY_PREFIX, pluginRelativePath } from "./PluginGatewaySessions.ts";

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(PanelPluginConfig));
const CONFIGURATION_ERROR: PluginPanelSnapshot = {
  pluginId: "configuration",
  panels: [],
  status: "error",
};
const REQUEST_TIMEOUT = Duration.seconds(10);

const servesScope = (plugin: PanelPluginConfig, scope: PluginPanelScope) =>
  (plugin.scopes ?? ["thread"]).includes(scope);

const notConnected = () => new PluginPanelRequestError({ reason: "not-connected" });
const rejected = (detail: string) => new PluginPanelRequestError({ reason: "rejected", detail });

/** Link prefixes count only for plugins the user let serve link cards. */
const pluginLinksOf = (plugin: PanelPluginConfig): ReadonlyArray<PluginLink> =>
  servesScope(plugin, "links")
    ? (plugin.links ?? []).map((link) => ({
        pluginId: plugin.id,
        linkId: link.id,
        prefix: link.prefix,
      }))
    : [];
const isRequestError = Schema.is(PluginPanelRequestError);

const sameProjects = (a: ReadonlyArray<PluginProject>, b: ReadonlyArray<PluginProject>) =>
  a.length === b.length &&
  a.every(
    (project, index) =>
      project.projectId === b[index]?.projectId &&
      project.title === b[index]?.title &&
      project.cwd === b[index]?.cwd,
  );

export class PanelPlugins extends Context.Service<
  PanelPlugins,
  {
    readonly subscribe: (
      input: SubscribePluginPanelsInput,
      options: { readonly allowWeb: boolean },
    ) => Stream.Stream<ReadonlyArray<PluginPanelSnapshot>>;
    /** Panels of plugins serving the environment scope, kept current as projects come and go. */
    readonly subscribeEnvironment: (
      input: SubscribeEnvironmentPluginPanelsInput,
      options: { readonly allowWeb: boolean },
    ) => Stream.Stream<ReadonlyArray<PluginPanelSnapshot>>;
    /** Asks the plugin's live connection; never opens one just to send the request. */
    readonly act: (
      input: PluginPanelActionInput,
    ) => Effect.Effect<PluginActionResult, PluginPanelRequestError>;
    readonly surface: (
      input: PluginPanelSurfaceInput,
    ) => Effect.Effect<PluginSurface, PluginPanelRequestError>;
    /** Link prefixes of plugins serving link cards; keeps those plugins connected while open. */
    readonly subscribeLinks: () => Stream.Stream<ReadonlyArray<PluginLink>>;
    /** Asks the plugin that declared `linkId` for a card, if `url` matches its prefix. */
    readonly linkCard: (
      input: PluginLinkCardInput,
      options: { readonly allowWeb: boolean },
    ) => Effect.Effect<PluginLinkCard, PluginPanelRequestError>;
  }
>()("t3/plugins/PanelPlugins") {}

const make = Effect.gen(function* () {
  const gateway = yield* PluginGateway.PluginGateway;
  const discovery = yield* PluginDiscovery.PluginDiscovery;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
  const connections = new Map<
    string,
    { connection: PanelPluginConnection; plugin: PanelPluginConfig; refs: number }
  >();
  /** Gateway grants for link card pages, one per connection, revoked when it retires. */
  const linkGrants = new Map<string, { root: string; token: string; revoke: () => void }>();
  const retire = (key: string) => {
    connections.get(key)?.connection.stop();
    connections.delete(key);
    linkGrants.get(key)?.revoke();
    linkGrants.delete(key);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const key of connections.keys()) retire(key);
    }),
  );
  /** Every watcher of configured plugins agrees on one connection per configuration. */
  const connectionFor = (plugin: PanelPluginConfig, key: string) => {
    let entry = connections.get(key);
    if (!entry) {
      entry = { connection: new PanelPluginConnection(plugin), plugin, refs: 0 };
      connections.set(key, entry);
    }
    return entry;
  };

  const resolveThread = Effect.fn("PanelPlugins.resolveThread")(function* (threadId: ThreadId) {
    const thread = yield* threads.getThreadShell(threadId);
    if (!thread) return undefined;
    const project = yield* projects.getById(thread.projectId);
    const cwd = thread.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
    return cwd ? ({ scope: "thread", threadId, cwd } as const) : undefined;
  });

  const listProjects = Effect.fn("PanelPlugins.listProjects")(function* () {
    const shells = yield* projects.listShells();
    return shells
      .filter((shell) => !shell.archivedAt)
      .map((shell): PluginProject => ({
        projectId: shell.id,
        title: shell.title,
        cwd: shell.workspaceRoot,
      }));
  });

  /**
   * Shared by both scopes: attaches every effective plugin serving `scope` to its connection and
   * forwards later targets (a changed project set) to the plugin under the same subscription.
   */
  const watch = Effect.fn("PanelPlugins.watch")(function* (
    queue: Queue.Queue<ReadonlyArray<PluginPanelSnapshot>, Cause.Done>,
    options: {
      readonly scope: PluginPanelScope;
      readonly target: PluginFrameTarget;
      readonly filters: SubscribePluginPanelsInput["filters"];
      readonly allowWeb: boolean;
    },
  ) {
    const gatewayThread = options.target.scope === "thread" ? options.target.threadId : undefined;
    const gatewayCwd = options.target.scope === "thread" ? options.target.cwd : undefined;
    let target = options.target;
    const snapshots = new Map<string, PluginPanelSnapshot>();
    const attached = new Map<
      string,
      { release: () => void; retarget: (target: PluginFrameTarget) => void }
    >();
    let desiredKeys = new Set<string>();
    const publish = () => Queue.offerUnsafe(queue, [...snapshots.values()]);

    // A connection nobody uses and nobody configures has nothing to wait for.
    const releaseIfRetired = (key: string) => {
      const entry = connections.get(key);
      if (entry && entry.refs === 0 && !desiredKeys.has(key)) retire(key);
    };
    const attach = (plugin: PanelPluginConfig, key: string) => {
      const shared = connectionFor(plugin, key);
      shared.refs++;
      const webSession = gateway.session(gatewayThread, gatewayCwd, options.allowWeb);
      const subscription = shared.connection.subscribe({
        target,
        filters: options.filters,
        emit: (snapshot, endpoint) => {
          snapshots.set(plugin.id, webSession.rewrite(snapshot, endpoint));
          publish();
        },
      });
      return {
        retarget: subscription.retarget,
        release: () => {
          webSession.close();
          subscription.close();
          shared.refs--;
          snapshots.delete(plugin.id);
          releaseIfRetired(key);
        },
      };
    };

    // Enabling, disabling or changing a plugin reaches already-open panels here, so the panel
    // appears or disappears without reopening the sidebar.
    const reconcile = ({ configs, error }: PluginDiscovery.EffectivePluginConfigs) =>
      Effect.sync(() => {
        const desired = new Map(
          configs
            .filter((plugin) => servesScope(plugin, options.scope))
            .map((plugin) => [encodeConfig(plugin), plugin] as const),
        );
        desiredKeys = new Set(desired.keys());
        for (const [key, subscription] of attached) {
          if (desired.has(key)) continue;
          attached.delete(key);
          subscription.release();
        }
        for (const [key, plugin] of desired) {
          if (!attached.has(key)) attached.set(key, attach(plugin, key));
        }
        for (const key of connections.keys()) releaseIfRetired(key);
        if (error) snapshots.set(CONFIGURATION_ERROR.pluginId, CONFIGURATION_ERROR);
        else snapshots.delete(CONFIGURATION_ERROR.pluginId);
        publish();
      });

    yield* Queue.offer(queue, []);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const subscription of attached.values()) subscription.release();
        attached.clear();
      }),
    );
    yield* discovery.configs.pipe(
      Stream.runForEach(reconcile),
      Effect.catchCause(() =>
        Effect.sync(() => {
          snapshots.set(CONFIGURATION_ERROR.pluginId, CONFIGURATION_ERROR);
          publish();
        }),
      ),
      Effect.forkScoped,
    );
    return {
      retarget: (next: PluginFrameTarget) =>
        Effect.sync(() => {
          target = next;
          for (const subscription of attached.values()) subscription.retarget(next);
        }),
    };
  });

  const subscribe: PanelPlugins["Service"]["subscribe"] = (input, options) =>
    Stream.callback(
      (queue) =>
        Effect.gen(function* () {
          const target = yield* resolveThread(input.threadId);
          if (!target) {
            yield* Queue.offer(queue, []);
            return;
          }
          yield* watch(queue, {
            scope: "thread",
            target,
            filters: input.filters,
            allowWeb: options.allowWeb,
          });
        }).pipe(Effect.catch(() => Queue.offer(queue, [CONFIGURATION_ERROR]))),
      { bufferSize: 1, strategy: "sliding" },
    );

  const subscribeEnvironment: PanelPlugins["Service"]["subscribeEnvironment"] = (input, options) =>
    Stream.callback(
      (queue) =>
        Effect.gen(function* () {
          // Read the cursor before the list, so a project change between the two is replayed.
          const afterSequence = yield* applicationEvents.latestApplicationSequence;
          let current = yield* listProjects();
          const watching = yield* watch(queue, {
            scope: "environment",
            target: { scope: "environment", projects: current },
            filters: input.filters,
            allowWeb: options.allowWeb,
          });
          yield* applicationEvents
            .streamProjectedApplicationEvents({
              afterSequence,
              project: (event) => event,
              filter: (event) => "aggregateKind" in event && event.aggregateKind === "project",
            })
            .pipe(
              Stream.runForEach(() =>
                Effect.gen(function* () {
                  const next = yield* listProjects();
                  if (sameProjects(next, current)) return;
                  current = next;
                  yield* watching.retarget({ scope: "environment", projects: next });
                }),
              ),
              Effect.ignoreCause({ log: true }),
              Effect.forkScoped,
            );
        }).pipe(Effect.catch(() => Queue.offer(queue, [CONFIGURATION_ERROR]))),
      { bufferSize: 1, strategy: "sliding" },
    );

  const send = Effect.fn("PanelPlugins.send")(function* (
    connection: PanelPluginConnection,
    target: PluginFrameTarget | undefined,
    frame: PluginRequestFrame,
  ) {
    return yield* Effect.callback<PluginRequestResult, PluginPanelRequestError>((resume) => {
      const abandon = connection.request(target, frame, (outcome) =>
        resume(isRequestError(outcome) ? Effect.fail(outcome) : Effect.succeed(outcome)),
      );
      return Effect.sync(abandon);
    }).pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(new PluginPanelRequestError({ reason: "timeout" })),
      }),
    );
  });

  const request = Effect.fn("PanelPlugins.request")(function* (
    target: PluginPanelTarget,
    pluginId: string,
    frame: PluginRequestFrame,
  ) {
    const resolved: PluginFrameTarget | undefined =
      target.scope === "thread"
        ? yield* resolveThread(target.threadId).pipe(Effect.orElseSucceed(() => undefined))
        : yield* listProjects().pipe(
            Effect.map((projects) => ({ scope: "environment", projects }) as const),
            Effect.orElseSucceed(() => undefined),
          );
    if (!resolved) return yield* notConnected();
    const entry = [...connections.values()].find(
      ({ connection, plugin }) =>
        plugin.id === pluginId && servesScope(plugin, target.scope) && connection.connected,
    );
    if (!entry) return yield* notConnected();
    const { web: _linksOnly, ...result } = yield* send(entry.connection, resolved, frame);
    return result satisfies PluginActionResult;
  });

  const act: PanelPlugins["Service"]["act"] = (input) =>
    request(input.target, input.pluginId, {
      type: "action",
      panelId: input.panelId,
      rowId: input.rowId,
      actionId: input.actionId,
      surfaceId: input.surfaceId,
      value: input.value,
    });

  const surface: PanelPlugins["Service"]["surface"] = Effect.fn("PanelPlugins.surface")(
    function* (input) {
      const result = yield* request(input.target, input.pluginId, {
        type: "surface",
        panelId: input.panelId,
        rowId: input.rowId,
        surfaceId: input.surfaceId,
        itemId: input.itemId,
      });
      if (!result.surface)
        return yield* new PluginPanelRequestError({ reason: "invalid-response" });
      return result.surface;
    },
  );

  const subscribeLinks: PanelPlugins["Service"]["subscribeLinks"] = () =>
    Stream.callback(
      (queue) =>
        Effect.gen(function* () {
          const held = new Map<string, () => void>();
          const release = (key: string) => {
            held.get(key)?.();
            held.delete(key);
            const entry = connections.get(key);
            if (entry) entry.refs--;
            if (entry?.refs === 0) retire(key);
          };
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const key of held.keys()) release(key);
            }),
          );
          // Only connected plugins' links get cards; the rest stay plain links until they are.
          const connected = new Map<string, PanelPluginConfig>();
          const publish = () =>
            Queue.offerUnsafe(queue, [...connected.values()].flatMap(pluginLinksOf));
          yield* discovery.configs.pipe(
            Stream.runForEach(({ configs }) =>
              Effect.sync(() => {
                const desired = new Map(
                  configs
                    .filter((plugin) => pluginLinksOf(plugin).length > 0)
                    .map((plugin) => [encodeConfig(plugin), plugin] as const),
                );
                for (const key of held.keys()) {
                  if (desired.has(key)) continue;
                  connected.delete(key);
                  release(key);
                }
                for (const [key, plugin] of desired) {
                  if (held.has(key)) continue;
                  const entry = connectionFor(plugin, key);
                  entry.refs++;
                  held.set(
                    key,
                    entry.connection.retain((status) => {
                      const was = connected.has(key);
                      if (status === "connected") connected.set(key, plugin);
                      else connected.delete(key);
                      if (was !== connected.has(key)) publish();
                    }),
                  );
                }
                publish();
              }),
            ),
            Effect.catchCause(() => Queue.offer(queue, [])),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  const linkCard: PanelPlugins["Service"]["linkCard"] = Effect.fn("PanelPlugins.linkCard")(
    function* (input, options) {
      const found = [...connections.entries()].flatMap(([key, { plugin, connection }]) => {
        if (plugin.id !== input.pluginId || !connection.connected) return [];
        const declared = pluginLinksOf(plugin).find((link) => link.linkId === input.linkId);
        return declared ? [{ key, connection, declared }] : [];
      })[0];
      if (!found) return yield* notConnected();
      const { key, connection, declared } = found;
      // The plugin only ever sees links it claimed, never arbitrary chat URLs.
      if (!input.url.startsWith(declared.prefix))
        return yield* rejected("The link does not match the plugin's prefix.");
      const result = yield* send(connection, undefined, {
        type: "surface",
        scope: "link",
        linkId: input.linkId,
        url: input.url,
      });
      if (result.surface) return { surface: result.surface };
      const web = result.web;
      const endpoint = connection.endpoint;
      if (!web || !endpoint || !pluginRelativePath(web.path))
        return yield* new PluginPanelRequestError({ reason: "invalid-response" });
      if (!options.allowWeb)
        return yield* rejected(
          "Interactive plugin cards require permission to operate this environment.",
        );
      const base = new URL(endpoint);
      base.protocol = base.protocol === "wss:" ? "https:" : "http:";
      const root = new URL("/", base).href;
      let grant = linkGrants.get(key);
      if (grant?.root !== root) {
        grant?.revoke();
        grant = { root, ...gateway.grant(root) };
        linkGrants.set(key, grant);
      }
      return {
        webUrl: `${PLUGIN_GATEWAY_PREFIX}${grant.token}/${web.path.slice(1)}`,
        ...(web.height === undefined ? {} : { height: web.height }),
      };
    },
  );

  return PanelPlugins.of({
    subscribe,
    subscribeEnvironment,
    act,
    surface,
    subscribeLinks,
    linkCard,
  });
});

export const layer = Layer.effect(PanelPlugins, make);
