import {
  parsePluginBridgeMessage,
  resolvePluginWebPath,
  PLUGIN_BRIDGE_MAX_MESSAGE_BYTES,
  PLUGIN_BRIDGE_FEATURES,
  PLUGIN_BRIDGE_VERSION,
  type PluginBridgeContent,
  type PluginBridgeOutbound,
  type PluginBridgePresentation,
} from "@t3tools/client-runtime/state/pluginBridge";
import {
  PluginSurfaceTree,
  type PluginSurfaceTreeNode,
} from "@t3tools/client-runtime/state/pluginSurfaceTree";
import type { PluginSurface } from "@t3tools/contracts";

/** One WebView's end of the bridge. Mutable: it follows the frame across loads. */
export interface PluginBridgeFrame {
  /** The surface showing this frame; null for a panel frame. */
  readonly nodeId: string | null;
  /** The id this frame's opener gave its surface. */
  readonly ownSurfaceId: string | undefined;
  readonly gatewayUrl: string;
  readonly panelTitle: string;
  readonly agentKey: string;
  /** Surfaces this frame opened, by the ids it chose. */
  readonly surfaces: Map<string, string>;
  /** Delivers a message to the frame's current port. */
  send: (message: PluginBridgeOutbound) => void;
  /** Set while the frame's old surfaces close with it, so their closing is not reported. */
  muted: boolean;
}

export type PluginBridgeSurfaceContent =
  | { readonly kind: "structured"; readonly surface: PluginSurface }
  | { readonly kind: "web"; readonly url: string };

export interface PluginBridgeSurfaceNode extends PluginSurfaceTreeNode {
  readonly presentation: PluginBridgePresentation;
  readonly title: string;
  readonly size: { readonly width: number; readonly height: number } | undefined;
  /** Web content only: a full-height sheet, ignoring `size`. */
  readonly maximized?: boolean;
  readonly content: PluginBridgeSurfaceContent;
  /** The frame that opened this surface; its actions and close go back there. */
  readonly opener: PluginBridgeFrame;
  readonly bridgeSurfaceId: string;
}

export type PluginBridgeTree = PluginSurfaceTree<PluginBridgeSurfaceNode>;
export const createPluginBridgeTree = (): PluginBridgeTree =>
  new PluginSurfaceTree<PluginBridgeSurfaceNode>();

export type PluginBridgeAgentRequest =
  | { readonly kind: "prompt"; readonly prompt: string }
  | { readonly kind: "stop" };
/** Resolves to an error message, or null when the request went through. */
export type PluginBridgeAgent = (
  frame: PluginBridgeFrame,
  request: PluginBridgeAgentRequest,
) => Promise<string | null>;

export function createPluginBridgeFrame(input: {
  readonly nodeId: string | null;
  readonly ownSurfaceId: string | undefined;
  readonly gatewayUrl: string;
  readonly panelTitle: string;
  readonly agentKey: string;
}): PluginBridgeFrame {
  return { ...input, surfaces: new Map(), send: () => {}, muted: false };
}

/** Points the frame's replies at its WebView, or nowhere once the WebView is gone. */
export function attachPluginBridgeFrame(
  frame: PluginBridgeFrame,
  send: ((message: PluginBridgeOutbound) => void) | null,
) {
  frame.send = send ?? (() => {});
}

/** Closes what the frame opened without telling it; its document or port is gone. */
export function closePluginBridgeFrame(tree: PluginBridgeTree, frame: PluginBridgeFrame) {
  frame.muted = true;
  for (const id of frame.surfaces.values()) tree.close(id, "parent");
  frame.surfaces.clear();
  frame.muted = false;
}

const contentFor = (
  frame: PluginBridgeFrame,
  content: PluginBridgeContent,
): PluginBridgeSurfaceContent | null => {
  if (content.kind === "structured") return content;
  const url = resolvePluginWebPath(frame.gatewayUrl, content.path);
  return url === null ? null : { kind: "web", url };
};

/** What the host page relays from a frame; anything else is dropped. */
export type PluginBridgeRelay =
  | { readonly kind: "reset" }
  | { readonly kind: "message"; readonly data: unknown }
  | { readonly kind: "rejected"; readonly requestId?: string; readonly message: string };

export function decodePluginBridgeRelay(text: string): PluginBridgeRelay | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const relay = value as {
    reset?: unknown;
    bridge?: unknown;
    rejected?: unknown;
    requestId?: unknown;
  };
  if (relay.reset === true) return { kind: "reset" };
  if ("bridge" in relay) return { kind: "message", data: relay.bridge };
  if (relay.rejected === "json" || relay.rejected === "size") {
    return {
      kind: "rejected",
      ...(typeof relay.requestId === "string" ? { requestId: relay.requestId } : {}),
      message:
        relay.rejected === "json"
          ? "Bridge messages must be JSON data."
          : "Bridge message is too large.",
    };
  }
  return null;
}

/** Applies one relayed frame message to the surface tree and answers the frame. */
export function handlePluginBridgeRelay(
  tree: PluginBridgeTree,
  frame: PluginBridgeFrame,
  relay: PluginBridgeRelay,
  agent: PluginBridgeAgent,
) {
  if (relay.kind === "reset") {
    closePluginBridgeFrame(tree, frame);
    return;
  }
  if (relay.kind === "rejected") {
    frame.send({
      type: "error",
      ...(relay.requestId === undefined ? {} : { requestId: relay.requestId }),
      message: relay.message,
    });
    return;
  }
  const parsed = parsePluginBridgeMessage(relay.data);
  if (!parsed.ok) {
    frame.send({
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
        frame.send({ type: "error", requestId: message.requestId, message: text });
      if (frame.surfaces.has(message.surfaceId)) {
        return reject("A surface with that id is already open.");
      }
      const parentId =
        message.parentSurfaceId === undefined
          ? frame.nodeId
          : (frame.surfaces.get(message.parentSurfaceId) ?? undefined);
      if (parentId === undefined) return reject("The parent surface is not open.");
      const content = contentFor(frame, message.content);
      if (content === null) return reject("That path is outside this plugin.");
      const id = tree.newId();
      const { surfaceId } = message;
      const opened = tree.open({
        id,
        parentId,
        presentation: message.presentation,
        title: content.kind === "structured" ? content.surface.title : frame.panelTitle,
        size: message.size,
        maximized: message.maximized === true && content.kind === "web",
        content,
        opener: frame,
        bridgeSurfaceId: surfaceId,
        onClosed: (reason, result) => {
          frame.surfaces.delete(surfaceId);
          if (frame.muted) return;
          frame.send({
            type: "surface.closed",
            surfaceId,
            reason,
            ...(result === undefined ? {} : { result }),
          });
        },
      });
      if (!opened) return reject("The parent surface is not open.");
      frame.surfaces.set(surfaceId, id);
      frame.send({ type: "surface.opened", requestId: message.requestId, surfaceId });
      return;
    }
    case "surface.update": {
      const opened = frame.surfaces.get(message.surfaceId);
      // A frame may change only its own surface's size, never replace itself.
      const own =
        opened === undefined && frame.nodeId !== null && frame.ownSurfaceId === message.surfaceId
          ? frame.nodeId
          : undefined;
      const id = opened ?? own;
      const content =
        message.content === undefined || own !== undefined
          ? undefined
          : contentFor(frame, message.content);
      if (id === undefined || content === null) {
        frame.send({
          type: "error",
          message:
            id === undefined ? "That surface is not open." : "That path is outside this plugin.",
        });
        return;
      }
      if (message.maximized !== undefined && tree.get(id)?.content.kind === "web") {
        tree.update(id, { maximized: message.maximized });
      }
      // Sheets have no anchor, so only content changes apply.
      if (content !== undefined) {
        tree.update(id, {
          content,
          ...(content.kind === "structured" ? { title: content.surface.title } : {}),
        });
      }
      return;
    }
    case "surface.close": {
      const id = frame.surfaces.get(message.surfaceId);
      if (id !== undefined) tree.close(id, "closed", message.result);
      else if (frame.nodeId !== null && frame.ownSurfaceId === message.surfaceId) {
        tree.close(frame.nodeId, "closed", message.result);
      } else frame.send({ type: "error", message: "That surface is not open." });
      return;
    }
    case "agent.prompt":
    case "agent.stop": {
      const { requestId } = message;
      void agent(
        frame,
        message.type === "agent.stop"
          ? { kind: "stop" }
          : { kind: "prompt", prompt: message.prompt },
      ).then((error) =>
        frame.send({
          type: "agent.result",
          requestId,
          ok: error === null,
          ...(error === null ? {} : { error }),
        }),
      );
      return;
    }
  }
}

/** JavaScript that hands `message` to the host page's current port. */
export const pluginBridgeInjection = (message: PluginBridgeOutbound) =>
  `window.t3BridgeSend(${JSON.stringify(message)});true;`;

const htmlAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The WebView's page: the plugin in a sandboxed frame, and the frame's bridge. Each load, and each
 * `t3.bridge.hello` from the frame itself, gets a fresh `MessageChannel`; port messages are relayed
 * to React Native as JSON with the frame's rect. No other window message is accepted.
 */
export function pluginBridgeHostHtml(src: string, ownSurfaceId: string | undefined) {
  const init = {
    type: "t3.bridge.init",
    version: PLUGIN_BRIDGE_VERSION,
    features: PLUGIN_BRIDGE_FEATURES,
    ...(ownSurfaceId === undefined ? {} : { surfaceId: ownSurfaceId }),
  } satisfies PluginBridgeOutbound;
  // `<` is escaped so plugin-chosen ids cannot close the script element.
  const initJson = JSON.stringify(init).replace(/</g, "\\u003c");
  const script = `(function () {
  var frame = document.getElementById("plugin");
  var port = null;
  var post = function (text) { window.ReactNativeWebView.postMessage(text); };
  var rect = function () {
    var r = frame.getBoundingClientRect();
    return JSON.stringify({ x: r.left, y: r.top, width: r.width, height: r.height });
  };
  var start = function () {
    if (port) port.close();
    var channel = new MessageChannel();
    port = channel.port1;
    post(JSON.stringify({ reset: true }));
    port.onmessage = function (event) {
      var text;
      try { text = JSON.stringify(event.data); } catch (error) { text = undefined; }
      var data = event.data;
      var requestId = data && typeof data.requestId === "string" && data.requestId.length <= 128 ? data.requestId : undefined;
      if (text === undefined) { post(JSON.stringify({ rejected: "json", requestId: requestId })); return; }
      if (text.length > ${PLUGIN_BRIDGE_MAX_MESSAGE_BYTES}) { post(JSON.stringify({ rejected: "size", requestId: requestId })); return; }
      post('{"bridge":' + text + ',"frameRect":' + rect() + '}');
    };
    frame.contentWindow.postMessage(${initJson}, "*", [channel.port2]);
  };
  frame.addEventListener("load", start);
  window.addEventListener("message", function (event) {
    if (event.source === frame.contentWindow && event.data && event.data.type === "t3.bridge.hello") start();
  });
  window.t3BridgeSend = function (message) { if (port) port.postMessage(message); };
})();`;
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{margin:0;border:0;width:100%;height:100%}</style><iframe id="plugin" title="Plugin" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="${htmlAttribute(src)}"></iframe><script>${script}</script>`;
}
