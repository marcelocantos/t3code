import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  MessageId,
  type ScopedThreadRef,
  type SubscribePluginPanelsInput,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { pluginErrorMessage, threadPluginPanels } from "../plugins/pluginAtoms";
import { PluginPanels, type PluginAgentControls } from "../plugins/PluginPanels";
import { pluginAgentRunState } from "../plugins/pluginRowMenu";

/** The message each row's agent action last sent, by thread key and row key, for this session. */
const sentAgentPromptsAtom = Atom.make<
  Readonly<Record<string, Readonly<Record<string, MessageId>>>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:plugin-panels:sent-agent-prompts"));

function useThreadAgentControls(threadRef: ScopedThreadRef): PluginAgentControls {
  const threadKey = scopedThreadKey(threadRef.environmentId, threadRef.threadId);
  const sent = useAtomValue(sentAgentPromptsAtom)[threadKey];
  const setSent = useAtomSet(sentAgentPromptsAtom);
  const runs = useQuietThreadStructure(threadRef)?.projection.runs ?? [];
  const queued = useThreadOutboxMessages()[threadKey] ?? [];
  const queuedMessageIds = new Set(queued.map((message) => message.messageId));
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, "plugin agent stop");
  return {
    stateOf: (rowKey) => pluginAgentRunState({ messageId: sent?.[rowKey], queuedMessageIds, runs }),
    start: (rowKey, prompt) => {
      const messageId = MessageId.make(uuidv4());
      setSent((current) => ({
        ...current,
        [threadKey]: { ...current[threadKey], [rowKey]: messageId },
      }));
      // The composer's path: queued behind a running turn, delivered by the outbox.
      return enqueueThreadOutboxMessage({
        environmentId: threadRef.environmentId,
        threadId: threadRef.threadId,
        messageId,
        commandId: CommandId.make(uuidv4()),
        text: prompt,
        attachments: [],
        dispatchMode: "queue",
        createdAt: new Date().toISOString(),
      }).then(
        () => null,
        () => {
          Dialog.alert("Could not send the plugin's prompt");
          return "Could not send the message.";
        },
      );
    },
    stop: (runId) =>
      interruptTurn({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, runId },
      }).then((result) => {
        if (result._tag !== "Failure") return null;
        Dialog.alert("Could not stop the agent");
        return "Could not stop the run.";
      }),
  };
}

export function ThreadPluginPanels({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [filters, setFilters] = useState<SubscribePluginPanelsInput["filters"]>([]);
  const agent = useThreadAgentControls(threadRef);
  const query = useEnvironmentQuery(
    threadPluginPanels({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, filters },
    }),
  );
  return (
    <View className="gap-3 px-4 py-2">
      {query.error ? (
        <Text className="text-sm text-foreground-muted">
          Plugin panels unavailable: {pluginErrorMessage(query.failure)}
        </Text>
      ) : null}
      <PluginPanels
        environmentId={threadRef.environmentId}
        target={{ scope: "thread", threadId: threadRef.threadId }}
        snapshots={query.data ?? []}
        agent={agent}
        onFilter={(pluginId, panelId, filter) =>
          setFilters((current) => [
            ...current.filter((item) => item.pluginId !== pluginId || item.panelId !== panelId),
            { pluginId, panelId, filter },
          ])
        }
      />
    </View>
  );
}
