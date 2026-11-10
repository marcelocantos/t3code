import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  MessageId,
  type PluginComposerIcon,
  type ScopedThreadRef,
  type SubscribePluginPanelsInput,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { AppText as Text } from "../../components/ui/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";
import { pluginErrorMessage, threadPluginPanels } from "../plugins/pluginAtoms";
import { PluginBridgeHost, useOpenPluginPage } from "../plugins/PluginBridge";
import {
  PluginPanels,
  pluginFrameAgentKey,
  type PluginAgentControls,
} from "../plugins/PluginPanels";
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

/** The header offers the plugins pane only while a plugin answers for this thread. */
export function useThreadHasPluginPanels(threadRef: ScopedThreadRef | null): boolean {
  const query = useEnvironmentQuery(
    threadRef
      ? threadPluginPanels({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, filters: [] },
        })
      : null,
  );
  return (query.data?.length ?? 0) > 0 || query.error !== null;
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

/** SF Symbol names; Android maps the same names to Tabler icons. */
const COMPOSER_SYMBOLS = {
  pencil: "pencil",
  paintbrush: "paintbrush",
  diagram: "flowchart",
  chart: "chart.bar.xaxis",
  image: "photo",
  document: "doc.text",
  sparkles: "sparkles",
  target: "target",
} as const satisfies Record<PluginComposerIcon, string>;

/** The fragment a plugin page reads to know it was opened from the composer. */
const COMPOSER_FRAGMENT = "#t3-composer";

/** Composer buttons for web panels that declare `composer`; each opens its page in a sheet. */
export function ThreadComposerPluginActions(props: {
  readonly threadRef: ScopedThreadRef;
  readonly size: "regular" | "large";
}) {
  const { threadRef } = props;
  const agent = useThreadAgentControls(threadRef);
  const query = useEnvironmentQuery(
    threadPluginPanels({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, filters: [] },
    }),
  );
  const actions = (query.data ?? []).flatMap((snapshot) =>
    snapshot.panels.flatMap((panel) =>
      panel.kind === "web" && panel.composer !== undefined
        ? [
            {
              pluginId: snapshot.pluginId,
              panel,
              label: panel.composer.label,
              icon: panel.composer.icon,
            },
          ]
        : [],
    ),
  );
  if (actions.length === 0) return null;
  return (
    <PluginBridgeHost environmentId={threadRef.environmentId} agent={agent}>
      {actions.map((action) => (
        <ComposerPluginButton
          key={`${action.pluginId}:${action.panel.id}`}
          threadRef={threadRef}
          path={action.panel.path}
          label={action.label}
          icon={action.icon}
          agentKey={pluginFrameAgentKey(action.pluginId, action.panel.id)}
          size={props.size}
        />
      ))}
    </PluginBridgeHost>
  );
}

function ComposerPluginButton(props: {
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly label: string;
  readonly agentKey: string;
  readonly size: "regular" | "large";
  readonly icon: PluginComposerIcon | undefined;
}) {
  const openPage = useOpenPluginPage();
  const { scale } = useAndroidControlSizing();
  const connection = usePreparedConnection(props.threadRef.environmentId);
  if (connection._tag === "None") return null;
  const gatewayUrl = new URL(props.path, connection.value.httpBaseUrl).href;
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70"
      onPress={() =>
        openPage({
          url: `${gatewayUrl}${COMPOSER_FRAGMENT}`,
          gatewayUrl,
          title: props.label,
          agentKey: props.agentKey,
        })
      }
    >
      <SymbolView
        name={props.icon === undefined ? "pencil" : COMPOSER_SYMBOLS[props.icon]}
        size={Math.round((props.size === "large" ? 26 : 20) * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );
}
