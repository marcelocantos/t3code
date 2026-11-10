import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  PanelPluginConfig,
  type PluginPanelSnapshot,
  type SubscribePluginPanelsInput,
} from "@t3tools/contracts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PluginGateway from "./PluginGateway.ts";
import * as PluginDiscovery from "./PluginDiscovery.ts";
import { PanelPluginConnection } from "./PanelPluginConnection.ts";

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(PanelPluginConfig));
const CONFIGURATION_ERROR: PluginPanelSnapshot = {
  pluginId: "configuration",
  panels: [],
  status: "error",
};

export class PanelPlugins extends Context.Service<
  PanelPlugins,
  {
    readonly subscribe: (
      input: SubscribePluginPanelsInput,
      options: { readonly allowWeb: boolean },
    ) => Stream.Stream<ReadonlyArray<PluginPanelSnapshot>>;
  }
>()("t3/plugins/PanelPlugins") {}

const make = Effect.gen(function* () {
  const gateway = yield* PluginGateway.PluginGateway;
  const discovery = yield* PluginDiscovery.PluginDiscovery;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const connections = new Map<string, { connection: PanelPluginConnection; refs: number }>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const { connection } of connections.values()) connection.stop();
      connections.clear();
    }),
  );

  const subscribe: PanelPlugins["Service"]["subscribe"] = (input, options) =>
    Stream.callback(
      (queue) =>
        Effect.gen(function* () {
          const thread = yield* threads.getThreadShell(input.threadId);
          if (!thread) {
            yield* Queue.offer(queue, []);
            return;
          }
          const project = yield* projects.getById(thread.projectId);
          const cwd = thread.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot;
          if (!cwd) {
            yield* Queue.offer(queue, []);
            return;
          }
          const snapshots = new Map<string, PluginPanelSnapshot>();
          const attached = new Map<string, () => void>();
          let desiredKeys = new Set<string>();
          const publish = () => Queue.offerUnsafe(queue, [...snapshots.values()]);

          // A connection nobody uses and nobody configures has nothing to wait for.
          const releaseIfRetired = (key: string) => {
            const entry = connections.get(key);
            if (entry && entry.refs === 0 && !desiredKeys.has(key)) {
              entry.connection.stop();
              connections.delete(key);
            }
          };
          const attach = (plugin: PanelPluginConfig, key: string) => {
            let entry = connections.get(key);
            if (!entry) {
              entry = { connection: new PanelPluginConnection(plugin), refs: 0 };
              connections.set(key, entry);
            }
            const shared = entry;
            shared.refs++;
            const webSession = gateway.session(input.threadId, cwd, options.allowWeb);
            const unsubscribe = shared.connection.subscribe({
              input,
              cwd,
              emit: (snapshot, endpoint) => {
                snapshots.set(plugin.id, webSession.rewrite(snapshot, endpoint));
                publish();
              },
            });
            return () => {
              webSession.close();
              unsubscribe();
              shared.refs--;
              snapshots.delete(plugin.id);
              releaseIfRetired(key);
            };
          };

          // Enabling, disabling or changing a plugin reaches already-open threads here, so the
          // panel appears or disappears without reopening the sidebar.
          const reconcile = ({ configs, error }: PluginDiscovery.EffectivePluginConfigs) =>
            Effect.sync(() => {
              const desired = new Map(
                configs.map((plugin) => [encodeConfig(plugin), plugin] as const),
              );
              desiredKeys = new Set(desired.keys());
              for (const [key, release] of attached) {
                if (desired.has(key)) continue;
                attached.delete(key);
                release();
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
              for (const release of attached.values()) release();
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
        }).pipe(Effect.catch(() => Queue.offer(queue, [CONFIGURATION_ERROR]))),
      { bufferSize: 1, strategy: "sliding" },
    );
  return PanelPlugins.of({ subscribe });
});

export const layer = Layer.effect(PanelPlugins, make);
