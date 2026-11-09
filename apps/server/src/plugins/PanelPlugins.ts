import * as Path from "effect/Path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
import { ServerConfig } from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { PanelPluginConnection } from "./PanelPluginConnection.ts";

const encodeConfig = Schema.encodeEffect(Schema.fromJsonString(PanelPluginConfig));
const decodeConfigs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PanelPluginConfig).check(Schema.isMaxLength(20))),
);

export class PanelPlugins extends Context.Service<
  PanelPlugins,
  {
    readonly subscribe: (
      input: SubscribePluginPanelsInput,
    ) => Stream.Stream<ReadonlyArray<PluginPanelSnapshot>>;
  }
>()("t3/plugins/PanelPlugins") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const config = yield* ServerConfig;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const connections = new Map<string, { connection: PanelPluginConnection; refs: number }>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const { connection } of connections.values()) connection.stop();
      connections.clear();
    }),
  );

  const subscribe: PanelPlugins["Service"]["subscribe"] = (input) =>
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
          const path = pathService.join(config.stateDir, "panel-plugins.json");
          if (!(yield* fs.exists(path))) {
            yield* Queue.offer(queue, []);
            return;
          }
          const configs = yield* fs.readFileString(path).pipe(Effect.flatMap(decodeConfigs));
          if (new Set(configs.map((plugin) => plugin.id)).size !== configs.length) {
            yield* Queue.offer(queue, [{ pluginId: "configuration", panels: [], status: "error" }]);
            return;
          }
          const configuredKeys = new Set(
            yield* Effect.forEach(configs, (plugin) => encodeConfig(plugin)),
          );
          for (const [key, entry] of connections) {
            if (entry.refs === 0 && !configuredKeys.has(key)) {
              entry.connection.stop();
              connections.delete(key);
            }
          }
          const snapshots = new Map<string, PluginPanelSnapshot>();
          yield* Queue.offer(queue, []);
          for (const plugin of configs) {
            const key = yield* encodeConfig(plugin);
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                let entry = connections.get(key);
                if (!entry) {
                  entry = { connection: new PanelPluginConnection(plugin), refs: 0 };
                  connections.set(key, entry);
                }
                entry.refs++;
                const unsubscribe = entry.connection.subscribe({
                  input,
                  cwd,
                  emit: (snapshot) => {
                    snapshots.set(plugin.id, snapshot);
                    Queue.offerUnsafe(queue, [...snapshots.values()]);
                  },
                });
                return () => {
                  unsubscribe();
                  entry.refs--;
                };
              }),
              (dispose) => Effect.sync(dispose),
            );
          }
        }).pipe(
          Effect.catch(() =>
            Queue.offer(queue, [{ pluginId: "configuration", panels: [], status: "error" }]),
          ),
        ),
      { bufferSize: 1, strategy: "sliding" },
    );
  return PanelPlugins.of({ subscribe });
});

export const layer = Layer.effect(PanelPlugins, make);
