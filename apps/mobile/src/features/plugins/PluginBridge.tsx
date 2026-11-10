import { clampPluginSurfaceSize } from "@t3tools/client-runtime/state/pluginBridge";
import type { EnvironmentId, PluginSurface } from "@t3tools/contracts";
import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Sheet } from "../../components/ui/Sheet";
import { useNowMinuteMs } from "../../lib/clock";
import { usePreparedConnection } from "../../state/session";
import {
  attachPluginBridgeFrame,
  closePluginBridgeFrame,
  createPluginBridgeFrame,
  createPluginBridgeTree,
  decodePluginBridgeRelay,
  handlePluginBridgeRelay,
  pluginBridgeHostHtml,
  pluginBridgeInjection,
  type PluginBridgeAgent,
  type PluginBridgeFrame,
  type PluginBridgeSurfaceNode,
  type PluginBridgeTree,
} from "./pluginBridgeHost";
import type { PluginAgentControls } from "./PluginPanels";
import { SurfaceBlock, type SurfaceAction } from "./PluginSurfaceSheet";
import { confirmAsync, usePluginRequests } from "./usePluginRequests";

const DEFAULT_WEB_SIZE = { width: 360, height: 320 };
const PAGE_SIZE = { width: 800, height: 720 };
/** The sheet header, safe areas and padding a maximized page leaves room for. */
const MAXIMIZED_CHROME_HEIGHT = 160;

interface PluginBridgeHostValue {
  readonly environmentId: EnvironmentId;
  readonly tree: PluginBridgeTree;
  readonly receive: (frame: PluginBridgeFrame, text: string) => void;
}
const PluginBridgeHostContext = createContext<PluginBridgeHostValue | null>(null);

function usePluginBridgeHost() {
  const host = use(PluginBridgeHostContext);
  if (host === null) throw new Error("Plugin web panels need a PluginBridgeHost.");
  return host;
}

/**
 * Owns what a group of web panels opens through the bridge. On mobile every popover, dialog and
 * modal is a sheet. Unmounting the host, as a thread change does, closes all of them.
 */
export function PluginBridgeHost(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: PluginAgentControls | undefined;
  readonly children: ReactNode;
}) {
  const [tree] = useState(createPluginBridgeTree);
  const { canOperate } = usePluginRequests(props.environmentId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the surfaces live exactly as long as this host
  useEffect(() => () => tree.dispose(), [tree]);

  const agent: PluginBridgeAgent = async (frame, request) => {
    const controls = props.agent;
    if (controls === undefined) return "Agent requests work only in thread panels.";
    if (!canOperate) return "This device may not operate this thread.";
    if (request.kind === "stop") {
      const run = controls.stateOf(frame.agentKey);
      if (run.kind !== "active") return "No run this plugin started is active.";
      const approved = await confirmAsync(
        "Stop the agent?",
        `The plugin panel ${frame.panelTitle} asks to stop the run it started.`,
        "Stop",
      );
      return approved ? controls.stop(run.runId) : "Declined by the user.";
    }
    const approved = await confirmAsync(
      `Send from ${frame.panelTitle}?`,
      `The plugin panel ${frame.panelTitle} asks to send this message to the agent:\n\n${request.prompt}`,
      "Send",
    );
    return approved ? controls.start(frame.agentKey, request.prompt) : "Declined by the user.";
  };

  const value: PluginBridgeHostValue = {
    environmentId: props.environmentId,
    tree,
    receive: (frame, text) => {
      const relay = decodePluginBridgeRelay(text);
      if (relay !== null) handlePluginBridgeRelay(tree, frame, relay, agent);
    },
  };
  return (
    <PluginBridgeHostContext value={value}>
      {props.children}
      <PluginBridgeSheet />
    </PluginBridgeHostContext>
  );
}

/** Opens a plugin page in the bridge's sheet, such as a composer canvas; it may close itself. */
export function useOpenPluginPage() {
  const { tree } = usePluginBridgeHost();
  return (input: {
    readonly url: string;
    readonly gatewayUrl: string;
    readonly title: string;
    readonly agentKey: string;
  }) => {
    tree.open({
      id: tree.newId(),
      parentId: null,
      presentation: "modal",
      title: input.title,
      size: PAGE_SIZE,
      content: { kind: "web", url: input.url },
      opener: createPluginBridgeFrame({
        nodeId: null,
        ownSurfaceId: undefined,
        gatewayUrl: input.gatewayUrl,
        panelTitle: input.title,
        agentKey: input.agentKey,
      }),
      bridgeSurfaceId: "composer",
    });
  };
}

/**
 * A sandboxed plugin page with the host bridge. The WebView hosts a small page that frames the
 * plugin and relays its port (see `pluginBridgeHostHtml`); replies go back via `injectJavaScript`.
 */
export function PluginBridgeWebView(props: {
  readonly src: string;
  readonly height: number;
  readonly nodeId: string | null;
  readonly ownSurfaceId: string | undefined;
  readonly gatewayUrl: string;
  readonly panelTitle: string;
  readonly agentKey: string;
}) {
  const host = usePluginBridgeHost();
  const connection = usePreparedConnection(host.environmentId);
  const [frame] = useState(() =>
    createPluginBridgeFrame({
      nodeId: props.nodeId,
      ownSurfaceId: props.ownSurfaceId,
      gatewayUrl: props.gatewayUrl,
      panelTitle: props.panelTitle,
      agentKey: props.agentKey,
    }),
  );
  const { tree } = host;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- what the frame opened ends with the frame
  useEffect(() => () => closePluginBridgeFrame(tree, frame), [tree, frame]);
  if (connection._tag === "None") return null;
  const baseUrl = connection.value.httpBaseUrl;
  return (
    <View style={{ height: props.height }}>
      <WebView
        ref={(view) =>
          attachPluginBridgeFrame(
            frame,
            view === null
              ? null
              : (message) => view.injectJavaScript(pluginBridgeInjection(message)),
          )
        }
        source={{ html: pluginBridgeHostHtml(props.src, props.ownSurfaceId), baseUrl }}
        originWhitelist={["*"]}
        incognito
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        allowFileAccess={false}
        setSupportMultipleWindows={false}
        onMessage={(event) => host.receive(frame, event.nativeEvent.data)}
        onShouldStartLoadWithRequest={(request) =>
          request.url === "about:blank" ||
          request.url === baseUrl ||
          request.url.startsWith(props.src)
        }
        style={{ flex: 1 }}
      />
    </View>
  );
}

/**
 * The bridge's surfaces as one sheet showing the newest. Older ones stay mounted underneath, so a
 * web surface keeps its page while a child is open; Back dismisses the newest, closing the sheet
 * dismisses them all.
 */
function PluginBridgeSheet() {
  const host = usePluginBridgeHost();
  const insets = useSafeAreaInsets();
  const nodes = useSyncExternalStore(host.tree.subscribe, host.tree.read);
  const top = nodes.at(-1);
  if (top === undefined) return null;
  const previous = nodes.at(-2);
  const dismissAll = () => {
    for (const node of host.tree.nodes.filter((candidate) => candidate.parentId === null)) {
      host.tree.close(node.id, "dismissed");
    }
  };
  return (
    <Sheet title={top.title} onClose={dismissAll} expanded={top.maximized === true}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-4 px-5 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(20, insets.bottom) }}
      >
        {previous ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Back to ${previous.title}`}
            className="min-h-11 flex-row items-center gap-1 self-start active:opacity-70"
            onPress={() => host.tree.close(top.id, "dismissed")}
          >
            <SymbolView name="chevron.left" size={16} tintColorClassName="accent-primary-text" />
            <Text className="text-primary-text">{previous.title}</Text>
          </Pressable>
        ) : null}
        {nodes.map((node) => (
          <View
            key={node.id}
            className="gap-4"
            style={node === top ? undefined : { display: "none" }}
          >
            <SurfaceBody node={node} />
          </View>
        ))}
      </ScrollView>
    </Sheet>
  );
}

function SurfaceBody({ node }: { node: PluginBridgeSurfaceNode }) {
  const viewport = useWindowDimensions();
  const { content } = node;
  if (content.kind === "structured")
    return <StructuredSurface node={node} surface={content.surface} />;
  const size = clampPluginSurfaceSize(node.size ?? DEFAULT_WEB_SIZE, viewport);
  return (
    <PluginBridgeWebView
      key={content.url}
      src={content.url}
      height={node.maximized === true ? viewport.height - MAXIMIZED_CHROME_HEIGHT : size.height}
      nodeId={node.id}
      ownSurfaceId={node.bridgeSurfaceId}
      gatewayUrl={node.opener.gatewayUrl}
      panelTitle={node.opener.panelTitle}
      agentKey={node.opener.agentKey}
    />
  );
}

/** A structured surface a frame opened: its actions go back to that frame, not the plugin server. */
function StructuredSurface(props: { node: PluginBridgeSurfaceNode; surface: PluginSurface }) {
  const { node } = props;
  const host = usePluginBridgeHost();
  const requests = usePluginRequests(host.environmentId);
  const nowMs = useNowMinuteMs();
  const send = (actionId: string, value?: unknown) =>
    node.opener.send({
      type: "surface.action",
      surfaceId: node.bridgeSurfaceId,
      actionId,
      ...(value === undefined ? {} : { value }),
    });
  const runAction = async (action: SurfaceAction, value?: string | null) => {
    if (
      action.kind === "plugin" &&
      action.confirm !== undefined &&
      !(await confirmAsync(action.label, action.confirm, action.label))
    ) {
      return;
    }
    send(action.id, action.kind === "date" ? (value ?? null) : undefined);
  };
  return props.surface.blocks.map((block, index) => (
    <SurfaceBlock
      // oxlint-disable-next-line react/no-array-index-key -- Blocks have no ids; the node prefix keeps surfaces apart.
      key={`${node.id}-${index}`}
      block={block}
      nowMs={nowMs}
      busy={false}
      canOperate
      onOpenItem={(surfaceId, itemId) => send(surfaceId, itemId)}
      onAction={(action, value) => void runAction(action, value)}
      onCustomDate={async (action) => {
        const date = await requests.askDate(action);
        if (date !== null) void runAction(action, date);
      }}
      onSubmit={(form, values) => send(form.actionId, values)}
    />
  ));
}
