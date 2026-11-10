import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PluginActionValue,
  PluginLeafAction,
  PluginPanelTarget,
  PluginSurface,
} from "@t3tools/contracts";
import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { requestConfirmDialog } from "../../confirmDialog";
import { useAtomCommand } from "../../state/use-atom-command";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Popover, PopoverPopup } from "../ui/popover";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  clampPluginSurfaceSize,
  parsePluginBridgeMessage,
  pluginAnchorInWindow,
  pluginPlacementParts,
  resolvePluginWebPath,
  PLUGIN_BRIDGE_VERSION,
  type PluginBridgeContent,
  type PluginBridgeOutbound,
  type PluginBridgePresentation,
  type PluginBridgeRect,
} from "./pluginBridge";
import { pluginPanelCommands } from "./pluginState";
import { PluginSurfaceTree, type PluginSurfaceTreeNode } from "./pluginSurfaceTree";
import { PluginSurfaceView, type PluginSurfaceAction } from "./PluginSurfaceView";

const HOVER_CLOSE_MS = 200;
const DEFAULT_POPOVER_WIDTH = 320;
const DEFAULT_WEB_SIZE = { width: 360, height: 240 };
/** DialogPopup's own max width; wider plugin surfaces lift it. */
const DIALOG_DEFAULT_MAX_WIDTH = 512;

/** The row a surface or action belongs to, as the plugin RPCs address it. */
export interface PluginRowTarget {
  readonly environmentId: EnvironmentId;
  readonly target: PluginPanelTarget;
  readonly pluginId: string;
  readonly panelId: string;
  readonly rowId: string;
}

export type PluginSide = "left" | "right" | "top" | "bottom";

/** Thread panels provide this; environment panels have no thread to talk to. */
export interface PluginAgentApi {
  /** Sources (rows or panels) whose run is still active. */
  readonly runningSources: ReadonlySet<string>;
  /** Resolve to an error message, or null on success. */
  readonly submit: (source: string, prompt: string) => Promise<string | null>;
  readonly stop: (source: string) => Promise<string | null>;
}
export const PluginAgentContext = createContext<PluginAgentApi | null>(null);

export const pluginRowAgentSource = (row: PluginRowTarget, actionId: string) =>
  JSON.stringify(["row", row.pluginId, row.panelId, row.rowId, actionId]);
export const pluginFrameAgentSource = (pluginId: string, panelId: string) =>
  JSON.stringify(["frame", pluginId, panelId]);

type VirtualAnchor = { getBoundingClientRect: () => DOMRect };
type SurfaceAnchor = Element | VirtualAnchor | null;

/** One frame's end of the bridge. Mutable: it follows the frame across loads. */
export interface PluginFrameEndpoint {
  /** The surface showing this frame; null for a panel frame. */
  readonly nodeId: string | null;
  /** The id this frame's opener gave its surface. */
  readonly ownSurfaceId: string | undefined;
  readonly gatewayUrl: string;
  readonly panelTitle: string;
  readonly agentSource: string;
  /** Surfaces this frame opened, by the ids it chose. */
  readonly surfaces: Map<string, string>;
  port: MessagePort | null;
  iframe: HTMLIFrameElement | null;
}

type SurfaceContent =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "structured"; readonly surface: PluginSurface }
  | {
      readonly kind: "web";
      readonly url: string;
      readonly bridgeSurfaceId: string;
      readonly gatewayUrl: string;
    };

/** Where a surface's actions go: the plugin server, or the frame that opened it. */
type SurfaceRoute =
  | { readonly kind: "plugin"; readonly row: PluginRowTarget; readonly surfaceId?: string }
  | {
      readonly kind: "frame";
      readonly frame: PluginFrameEndpoint;
      readonly bridgeSurfaceId: string;
    };

export interface PluginSurfaceNode extends PluginSurfaceTreeNode {
  readonly presentation: PluginBridgePresentation;
  readonly title: string;
  readonly anchor: SurfaceAnchor;
  readonly side: PluginSide;
  readonly align: "start" | "center" | "end";
  readonly size: { readonly width: number; readonly height: number } | undefined;
  readonly content: SurfaceContent;
  readonly route: SurfaceRoute;
  readonly panelTitle: string;
  readonly agentSource: string;
}

/** Where a row-level action came from; surface actions carry their node instead. */
export interface PluginRowOrigin {
  readonly row: PluginRowTarget;
  readonly panelTitle: string;
  readonly agentSource: string;
  readonly side: PluginSide;
}
type ActionOrigin = PluginRowOrigin | { readonly node: PluginSurfaceNode };

const post = (frame: PluginFrameEndpoint, message: PluginBridgeOutbound) =>
  frame.port?.postMessage(message);

async function confirm(message: string) {
  return (await requestConfirmDialog(message)) ?? window.confirm(message);
}

function failureMessage(result: AtomCommandResult<unknown, unknown>) {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error ? error.message : "The plugin request failed.";
}

function reportFailure(title: string, description: string) {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

const PluginSurfaceHostContext = createContext<ReturnType<typeof useHostApi> | null>(null);

export function usePluginSurfaceHost() {
  const host = use(PluginSurfaceHostContext);
  if (host === null) throw new Error("Plugin surfaces need a PluginSurfaceHost.");
  return host;
}

/**
 * Owns the surfaces a group of panels opens: hover cards, dialogs, and what web panels open
 * through the bridge. Unmounting it, as a thread switch does, closes all of them.
 */
export function PluginSurfaceHost({ children }: { children: ReactNode }) {
  const [tree] = useState(() => new PluginSurfaceTree<PluginSurfaceNode>());
  const [hoverTimers] = useState(() => new Map<string, ReturnType<typeof setTimeout>>());
  const api = useHostApi(tree, hoverTimers);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- surfaces and hover timers live exactly as long as this host
  useEffect(
    () => () => {
      for (const timer of hoverTimers.values()) clearTimeout(timer);
      hoverTimers.clear();
      tree.dispose();
    },
    [tree, hoverTimers],
  );
  return (
    <PluginSurfaceHostContext value={api}>
      {children}
      <SurfaceLayer parentId={null} />
    </PluginSurfaceHostContext>
  );
}

function useHostApi(
  tree: PluginSurfaceTree<PluginSurfaceNode>,
  hoverTimers: Map<string, ReturnType<typeof setTimeout>>,
) {
  const act = useAtomCommand(pluginPanelCommands.act, { reportFailure: false });
  const fetchSurface = useAtomCommand(pluginPanelCommands.surface, { reportFailure: false });
  const agent = use(PluginAgentContext);

  const openPluginSurface = async (input: {
    readonly row: PluginRowTarget;
    readonly surfaceId: string;
    readonly itemId?: string;
    readonly parentId: string | null;
    readonly presentation: PluginBridgePresentation;
    readonly anchor: SurfaceAnchor;
    readonly side: PluginSide;
    readonly transientKey?: string;
    readonly panelTitle: string;
    readonly agentSource: string;
  }) => {
    const id = tree.newId();
    const opened = tree.open({
      id,
      parentId: input.parentId,
      transientKey: input.transientKey,
      presentation: input.presentation,
      title: input.panelTitle,
      anchor: input.anchor,
      side: input.side,
      align: "start",
      size: undefined,
      content: { kind: "loading" },
      route: { kind: "plugin", row: input.row, surfaceId: input.surfaceId },
      panelTitle: input.panelTitle,
      agentSource: input.agentSource,
    });
    if (!opened) return;
    const { row } = input;
    const result = await fetchSurface({
      environmentId: row.environmentId,
      input: {
        target: row.target,
        pluginId: row.pluginId,
        panelId: row.panelId,
        rowId: row.rowId,
        surfaceId: input.surfaceId,
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      },
    });
    tree.update(
      id,
      result._tag === "Success"
        ? { content: { kind: "structured", surface: result.value }, title: result.value.title }
        : { content: { kind: "error", message: failureMessage(result) } },
    );
  };

  /** Sends an action to wherever its surface routes, then applies the plugin's result. */
  const send = async (
    origin: ActionOrigin,
    action: { readonly id: string; readonly label: string },
    value: PluginActionValue | undefined,
    anchor: Element | null,
  ) => {
    const node = "node" in origin ? origin.node : null;
    const route = node?.route;
    if (route?.kind === "frame") {
      post(route.frame, {
        type: "surface.action",
        surfaceId: route.bridgeSurfaceId,
        actionId: action.id,
        ...(value === undefined ? {} : { value }),
      });
      return;
    }
    const row = route?.row ?? ("row" in origin ? origin.row : null);
    if (row === null) return;
    const result = await act({
      environmentId: row.environmentId,
      input: {
        target: row.target,
        pluginId: row.pluginId,
        panelId: row.panelId,
        rowId: row.rowId,
        actionId: action.id,
        ...(route?.surfaceId === undefined ? {} : { surfaceId: route.surfaceId }),
        ...(value === undefined ? {} : { value }),
      },
    });
    if (result._tag !== "Success") {
      reportFailure(action.label, failureMessage(result));
      return;
    }
    if (result.value.close === true && node !== null) tree.close(node.id, "closed");
    const surface = result.value.surface;
    if (surface === undefined) return;
    const parent =
      node === null
        ? null
        : result.value.close === true
          ? (tree.get(node.parentId ?? "") ?? null)
          : node;
    tree.open({
      id: tree.newId(),
      parentId: parent?.id ?? null,
      presentation: parent?.presentation === "popover" ? "popover" : "dialog",
      title: surface.title,
      anchor,
      side: node?.side ?? ("side" in origin ? origin.side : "left"),
      align: "start",
      size: undefined,
      content: { kind: "structured", surface },
      route: {
        kind: "plugin",
        row,
        ...(route?.surfaceId === undefined ? {} : { surfaceId: route.surfaceId }),
      },
      panelTitle: node?.panelTitle ?? ("panelTitle" in origin ? origin.panelTitle : ""),
      agentSource: node?.agentSource ?? ("agentSource" in origin ? origin.agentSource : ""),
    });
  };

  const runAction = async (
    origin: ActionOrigin,
    action: PluginLeafAction | PluginSurfaceAction,
    value: string | null | undefined,
    anchor: Element | null,
  ) => {
    const node = "node" in origin ? origin.node : null;
    if (action.kind === "agent") {
      if (agent === null || node !== null) return;
      const row = (origin as PluginRowOrigin).row;
      const error = await agent.submit(pluginRowAgentSource(row, action.id), action.prompt);
      if (error !== null) reportFailure(action.label, error);
      return;
    }
    if (
      action.kind === "plugin" &&
      action.confirm !== undefined &&
      !(await confirm(action.confirm))
    ) {
      return;
    }
    if (action.kind === "surface" && node?.route.kind !== "frame") {
      const row = node?.route.kind === "plugin" ? node.route.row : (origin as PluginRowOrigin).row;
      await openPluginSurface({
        row,
        surfaceId: action.surfaceId,
        parentId: node?.id ?? null,
        presentation: action.modal === true ? "modal" : "dialog",
        anchor: null,
        side: node?.side ?? (origin as PluginRowOrigin).side,
        panelTitle: node?.panelTitle ?? (origin as PluginRowOrigin).panelTitle,
        agentSource: node?.agentSource ?? (origin as PluginRowOrigin).agentSource,
      });
      return;
    }
    await send(origin, action, action.kind === "date" ? (value ?? null) : undefined, anchor);
  };

  const frameAnchor = (
    frame: PluginFrameEndpoint,
    rect: PluginBridgeRect | undefined,
  ): SurfaceAnchor => {
    if (rect === undefined) return frame.iframe;
    return {
      getBoundingClientRect: () => {
        const bounds = frame.iframe?.getBoundingClientRect() ?? new DOMRect();
        const placed = pluginAnchorInWindow(bounds, rect, {
          width: window.innerWidth,
          height: window.innerHeight,
        });
        return new DOMRect(placed.left, placed.top, placed.width, placed.height);
      },
    };
  };

  const frameContent = (
    frame: PluginFrameEndpoint,
    surfaceId: string,
    content: PluginBridgeContent,
  ): SurfaceContent | null => {
    if (content.kind === "structured") return { kind: "structured", surface: content.surface };
    const url = resolvePluginWebPath(frame.gatewayUrl, content.path);
    return url === null
      ? null
      : { kind: "web", url, bridgeSurfaceId: surfaceId, gatewayUrl: frame.gatewayUrl };
  };

  const frameAgent = async (
    frame: PluginFrameEndpoint,
    requestId: string,
    request: { readonly prompt: string } | null,
  ) => {
    const reply = (error: string | null) =>
      post(frame, {
        type: "agent.result",
        requestId,
        ok: error === null,
        ...(error === null ? {} : { error }),
      });
    if (agent === null) return reply("Agent requests work only in thread panels.");
    const approved = await confirm(
      request === null
        ? `Stop the agent run ${frame.panelTitle} started?\nThe plugin panel ${frame.panelTitle} asks to stop it.`
        : `Send this message from ${frame.panelTitle}?\n${request.prompt}`,
    );
    if (!approved) return reply("Declined by the user.");
    reply(
      request === null
        ? await agent.stop(frame.agentSource)
        : await agent.submit(frame.agentSource, request.prompt),
    );
  };

  const handleFrameMessage = (frame: PluginFrameEndpoint, data: unknown) => {
    const parsed = parsePluginBridgeMessage(data);
    if (!parsed.ok) {
      post(frame, {
        type: "error",
        ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
        message: parsed.message,
      });
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case "surface.open": {
        const reject = (text: string) =>
          post(frame, { type: "error", requestId: message.requestId, message: text });
        if (frame.surfaces.has(message.surfaceId)) {
          return reject("A surface with that id is already open.");
        }
        const parentId =
          message.parentSurfaceId === undefined
            ? frame.nodeId
            : (frame.surfaces.get(message.parentSurfaceId) ?? undefined);
        if (parentId === undefined) return reject("The parent surface is not open.");
        const content = frameContent(frame, message.surfaceId, message.content);
        if (content === null) return reject("That path is outside this plugin.");
        const { side, align } = pluginPlacementParts(message.placement);
        const id = tree.newId();
        const { surfaceId } = message;
        const opened = tree.open({
          id,
          parentId,
          presentation: message.presentation,
          title: content.kind === "structured" ? content.surface.title : frame.panelTitle,
          anchor: frameAnchor(frame, message.anchor),
          side,
          align,
          size:
            message.size === undefined
              ? undefined
              : clampPluginSurfaceSize(message.size, {
                  width: window.innerWidth,
                  height: window.innerHeight,
                }),
          content,
          route: { kind: "frame", frame, bridgeSurfaceId: surfaceId },
          panelTitle: frame.panelTitle,
          agentSource: frame.agentSource,
          onClosed: (reason, result) => {
            frame.surfaces.delete(surfaceId);
            post(frame, {
              type: "surface.closed",
              surfaceId,
              reason,
              ...(result === undefined ? {} : { result }),
            });
          },
        });
        if (!opened) return reject("The parent surface is not open.");
        frame.surfaces.set(surfaceId, id);
        post(frame, { type: "surface.opened", requestId: message.requestId, surfaceId });
        return;
      }
      case "surface.update": {
        const id = frame.surfaces.get(message.surfaceId);
        const content =
          message.content === undefined
            ? undefined
            : frameContent(frame, message.surfaceId, message.content);
        if (id === undefined || content === null) {
          post(frame, {
            type: "error",
            message:
              id === undefined ? "That surface is not open." : "That path is outside this plugin.",
          });
          return;
        }
        tree.update(id, {
          ...(message.anchor === undefined ? {} : { anchor: frameAnchor(frame, message.anchor) }),
          ...(content === undefined
            ? {}
            : {
                content,
                ...(content.kind === "structured" ? { title: content.surface.title } : {}),
              }),
        });
        return;
      }
      case "surface.close": {
        const id = frame.surfaces.get(message.surfaceId);
        if (id !== undefined) tree.close(id, "closed", message.result);
        else if (frame.nodeId !== null && frame.ownSurfaceId === message.surfaceId) {
          tree.close(frame.nodeId, "closed", message.result);
        } else post(frame, { type: "error", message: "That surface is not open." });
        return;
      }
      case "agent.prompt":
        void frameAgent(frame, message.requestId, { prompt: message.prompt });
        return;
      case "agent.stop":
        void frameAgent(frame, message.requestId, null);
        return;
    }
  };

  const cancelHoverClose = (panelKey: string) => {
    const timer = hoverTimers.get(panelKey);
    if (timer !== undefined) clearTimeout(timer);
    hoverTimers.delete(panelKey);
  };
  const scheduleHoverClose = (panelKey: string) => {
    cancelHoverClose(panelKey);
    hoverTimers.set(
      panelKey,
      setTimeout(() => {
        hoverTimers.delete(panelKey);
        const node = tree.nodes.find((candidate) => candidate.transientKey === panelKey);
        if (node !== undefined) tree.close(node.id, "dismissed");
      }, HOVER_CLOSE_MS),
    );
  };

  return {
    tree,
    runAction,
    handleFrameMessage,
    cancelHoverClose,
    scheduleHoverClose,
    showHover(
      input: PluginRowOrigin & {
        readonly surfaceId: string;
        readonly anchor: Element;
        readonly panelKey: string;
      },
    ) {
      cancelHoverClose(input.panelKey);
      const current = tree.nodes.find((node) => node.transientKey === input.panelKey);
      if (current?.anchor === input.anchor) return;
      void openPluginSurface({
        row: input.row,
        surfaceId: input.surfaceId,
        parentId: null,
        presentation: "popover",
        anchor: input.anchor,
        side: input.side,
        transientKey: input.panelKey,
        panelTitle: input.panelTitle,
        agentSource: input.agentSource,
      });
    },
    /** A click in a hover card keeps it open after the pointer leaves. */
    pin(id: string) {
      const node = tree.get(id);
      if (node?.transientKey === undefined) return;
      cancelHoverClose(node.transientKey);
      tree.update(id, { transientKey: undefined });
    },
    submitForm(
      node: PluginSurfaceNode,
      form: { readonly actionId: string; readonly submitLabel: string },
      values: Record<string, string>,
      anchor: Element,
    ) {
      void send({ node }, { id: form.actionId, label: form.submitLabel }, values, anchor);
    },
    openItem(
      node: PluginSurfaceNode,
      item: { readonly id: string; readonly surfaceId: string },
      anchor: Element,
    ) {
      if (node.route.kind === "frame") {
        post(node.route.frame, {
          type: "surface.action",
          surfaceId: node.route.bridgeSurfaceId,
          actionId: item.surfaceId,
          value: item.id,
        });
        return;
      }
      void openPluginSurface({
        row: node.route.row,
        surfaceId: item.surfaceId,
        itemId: item.id,
        parentId: node.id,
        presentation: "popover",
        anchor,
        side: node.side,
        panelTitle: node.panelTitle,
        agentSource: node.agentSource,
      });
    },
  };
}

function SurfaceLayer({ parentId }: { parentId: string | null }) {
  const host = usePluginSurfaceHost();
  const nodes = useSyncExternalStore(host.tree.subscribe, host.tree.read);
  return nodes
    .filter((node) => node.parentId === parentId)
    .map((node) => (
      <SurfaceNodeView
        key={node.id}
        node={node}
        // A dialog over a surface blocks that surface tree only, never the rest of the app.
        blocked={nodes.some(
          (child) => child.parentId === node.id && child.presentation !== "popover",
        )}
      />
    ));
}

function surfaceWidth(node: PluginSurfaceNode) {
  if (node.size !== undefined) return node.size.width;
  if (node.content.kind === "structured")
    return node.content.surface.width ?? DEFAULT_POPOVER_WIDTH;
  return node.content.kind === "web" ? DEFAULT_WEB_SIZE.width : DEFAULT_POPOVER_WIDTH;
}

function SurfaceNodeView({ node, blocked }: { node: PluginSurfaceNode; blocked: boolean }) {
  const host = usePluginSurfaceHost();
  const width = surfaceWidth(node);
  const body = (
    <div inert={blocked} className="min-w-0" data-plugin-surface-body="">
      <SurfaceContentView node={node} />
    </div>
  );
  const close = (open: boolean) => {
    if (!open) host.tree.close(node.id, "dismissed");
  };
  if (node.presentation === "popover") {
    const { transientKey } = node;
    return (
      <Popover open onOpenChange={close}>
        <PopoverPopup
          anchor={node.anchor ?? undefined}
          side={node.side}
          align={node.align}
          sideOffset={6}
          padding="compact"
          initialFocus={transientKey === undefined}
          finalFocus={false}
          aria-label={node.title}
          data-plugin-surface={node.id}
          style={{ width }}
          onPointerEnter={() => {
            if (transientKey !== undefined) host.cancelHoverClose(transientKey);
          }}
          onPointerLeave={() => {
            if (transientKey !== undefined) host.scheduleHoverClose(transientKey);
          }}
          onPointerDownCapture={() => host.pin(node.id)}
        >
          {body}
          <SurfaceLayer parentId={node.id} />
        </PopoverPopup>
      </Popover>
    );
  }
  const style: CSSProperties | undefined =
    width > DIALOG_DEFAULT_MAX_WIDTH ? { width, maxWidth: "calc(100vw - 2rem)" } : undefined;
  return (
    <Dialog
      open
      modal={node.presentation === "modal"}
      disablePointerDismissal={node.presentation === "dialog"}
      onOpenChange={close}
    >
      <DialogPopup
        variant={node.presentation === "dialog" ? "modeless" : "default"}
        data-plugin-surface={node.id}
        style={style}
      >
        <DialogHeader>
          <DialogTitle>{node.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>{body}</DialogPanel>
        <SurfaceLayer parentId={node.id} />
      </DialogPopup>
    </Dialog>
  );
}

function SurfaceContentView({ node }: { node: PluginSurfaceNode }) {
  const host = usePluginSurfaceHost();
  const { content } = node;
  switch (content.kind) {
    case "loading":
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Spinner className="size-3.5" />
          Loading…
        </div>
      );
    case "error":
      return (
        <p role="alert" className="text-xs text-destructive-foreground">
          {content.message}
        </p>
      );
    case "structured":
      return (
        <PluginSurfaceView
          surface={content.surface}
          handlers={{
            onAction: (action, value, anchor) =>
              void host.runAction({ node }, action, value, anchor),
            onSubmit: (form, values, anchor) => host.submitForm(node, form, values, anchor),
            onOpenItem: (item, anchor) => host.openItem(node, item, anchor),
          }}
        />
      );
    case "web": {
      const size = node.size ?? DEFAULT_WEB_SIZE;
      return (
        <PluginFrame
          src={content.url}
          title={node.title}
          height={size.height}
          nodeId={node.id}
          ownSurfaceId={content.bridgeSurfaceId}
          gatewayUrl={content.gatewayUrl}
          panelTitle={node.panelTitle}
          agentSource={node.agentSource}
        />
      );
    }
  }
}

function closeFrame(endpoint: PluginFrameEndpoint, tree: PluginSurfaceTree<PluginSurfaceNode>) {
  endpoint.port?.close();
  endpoint.port = null;
  for (const id of endpoint.surfaces.values()) tree.close(id, "parent");
  endpoint.surfaces.clear();
}

/** Starts the bridge for a freshly loaded document; the previous one's surfaces go with it. */
function openBridge(
  endpoint: PluginFrameEndpoint,
  tree: PluginSurfaceTree<PluginSurfaceNode>,
  iframe: HTMLIFrameElement,
  receive: (data: unknown) => void,
) {
  closeFrame(endpoint, tree);
  const channel = new MessageChannel();
  endpoint.iframe = iframe;
  endpoint.port = channel.port1;
  channel.port1.onmessage = (message) => receive(message.data);
  iframe.contentWindow?.postMessage(
    {
      type: "t3.bridge.init",
      version: PLUGIN_BRIDGE_VERSION,
      ...(endpoint.ownSurfaceId === undefined ? {} : { surfaceId: endpoint.ownSurfaceId }),
    } satisfies PluginBridgeOutbound,
    "*",
    [channel.port2],
  );
}

/**
 * A sandboxed plugin frame with the host bridge. Each load gets a fresh `MessageChannel`; the
 * frame is opaque-origin, so the init message targets `*` and only the transferred port is trusted.
 */
export function PluginFrame(props: {
  src: string;
  title: string;
  height: number | string;
  nodeId: string | null;
  ownSurfaceId: string | undefined;
  gatewayUrl: string;
  panelTitle: string;
  agentSource: string;
}) {
  const host = usePluginSurfaceHost();
  const [endpoint] = useState<PluginFrameEndpoint>(() => ({
    nodeId: props.nodeId,
    ownSurfaceId: props.ownSurfaceId,
    gatewayUrl: props.gatewayUrl,
    panelTitle: props.panelTitle,
    agentSource: props.agentSource,
    surfaces: new Map(),
    port: null,
    iframe: null,
  }));
  const { tree } = host;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the bridge port and what the frame opened end with the frame
  useEffect(() => () => closeFrame(endpoint, tree), [endpoint, tree]);
  return (
    <iframe
      title={props.title}
      src={props.src}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      className="block w-full border-0"
      style={{ height: props.height }}
      onLoad={(event) =>
        openBridge(endpoint, tree, event.currentTarget, (data) =>
          host.handleFrameMessage(endpoint, data),
        )
      }
    />
  );
}
