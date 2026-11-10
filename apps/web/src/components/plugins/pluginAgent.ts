import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { newMessageId } from "~/lib/utils";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { pluginPanelCommands } from "./pluginState";
import type { PluginAgentApi } from "./PluginSurfaceHost";

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * The message each row or panel last submitted, per thread, kept for the app session so Stop
 * survives switching threads. Only the run of that message counts as the source's run.
 */
const startedMessages = (() => {
  const listeners = new Set<() => void>();
  let value: ReadonlyMap<string, MessageId> = new Map();
  return {
    read: () => value,
    set(key: string, messageId: MessageId) {
      value = new Map(value).set(key, messageId);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
})();

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

/** Agent actions for a thread's panels; null when this client may not operate the thread. */
export function usePluginThreadAgent(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): PluginAgentApi | null {
  const canOperate = useAtomValue(pluginPanelCommands.act.permissionAtom(environmentId));
  const ref = scopeThreadRef(environmentId, threadId);
  const shell = useQuietThreadShell(ref);
  const runs = useQuietThreadProjection(ref)?.projection.runs ?? [];
  const started = useSyncExternalStore(startedMessages.subscribe, startedMessages.read);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const cancelQueuedRun = useOrchestrationCommand(threadEnvironment.cancelQueuedRun, {
    reportFailure: false,
  });
  if (!canOperate) return null;

  const keyOf = (source: string) => JSON.stringify([environmentId, threadId, source]);
  const activeRun = (source: string) => {
    const messageId = started.get(keyOf(source));
    if (messageId === undefined) return undefined;
    return runs.find(
      (run) => run.userMessageId === messageId && ACTIVE_RUN_STATUSES.has(run.status),
    );
  };
  const runningSources = new Set<string>();
  const prefix = JSON.stringify([environmentId, threadId]).slice(0, -1);
  for (const key of started.keys()) {
    if (!key.startsWith(prefix)) continue;
    const source = (JSON.parse(key) as [string, string, string])[2];
    if (activeRun(source) !== undefined) runningSources.add(source);
  }

  return {
    runningSources,
    async submit(source, prompt) {
      if (shell === null) return "This thread is not available.";
      const messageId = newMessageId();
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: { messageId, role: "user", text: prompt, attachments: [] },
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          // Behind a running turn, the prompt waits its turn like a queued composer message.
          dispatchMode: "queue",
        },
      });
      if (result._tag === "Failure") {
        return errorText(squashAtomCommandFailure(result), "Could not send the message.");
      }
      startedMessages.set(keyOf(source), messageId);
      return null;
    },
    async stop(source) {
      const run = activeRun(source);
      if (run === undefined) return "No run this plugin started is active.";
      const input = { environmentId, input: { threadId, runId: run.id } };
      const result =
        run.status === "queued" ? await cancelQueuedRun(input) : await interruptTurn(input);
      return result._tag === "Failure"
        ? errorText(squashAtomCommandFailure(result), "Could not stop the run.")
        : null;
    },
  };
}
