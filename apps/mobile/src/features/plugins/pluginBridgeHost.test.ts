import type { PluginBridgeOutbound } from "@t3tools/client-runtime/state/pluginBridge";
import { describe, expect, it } from "vite-plus/test";

import {
  createPluginBridgeFrame,
  createPluginBridgeTree,
  decodePluginBridgeRelay,
  handlePluginBridgeRelay,
  pluginBridgeHostHtml,
  type PluginBridgeAgent,
  type PluginBridgeTree,
} from "./pluginBridgeHost";

const GATEWAY = "https://host.test/plugins/demo/app/";

function setup(agent: PluginBridgeAgent = async () => null) {
  const tree = createPluginBridgeTree();
  const sent: Array<[string, PluginBridgeOutbound]> = [];
  const frame = (name: string, nodeId: string | null = null, ownSurfaceId?: string) => {
    const endpoint = createPluginBridgeFrame({
      nodeId,
      ownSurfaceId,
      gatewayUrl: GATEWAY,
      panelTitle: "Demo",
      agentKey: "demo#frame",
    });
    endpoint.send = (message) => void sent.push([name, message]);
    return endpoint;
  };
  const receive = (
    target: ReturnType<typeof frame>,
    data: unknown,
    relayTree: PluginBridgeTree = tree,
  ) => handlePluginBridgeRelay(relayTree, target, { kind: "message", data }, agent);
  return { tree, sent, frame, receive };
}

const structured = { kind: "structured", surface: { title: "Card", blocks: [] } };

describe("handlePluginBridgeRelay", () => {
  it("returns a child web surface's result to the frame that opened it", () => {
    const { tree, sent, frame, receive } = setup();
    const panel = frame("panel");
    receive(panel, {
      type: "surface.open",
      requestId: "1",
      surfaceId: "picker",
      presentation: "dialog",
      content: { kind: "web", path: "dialog.html" },
    });
    const node = tree.nodes[0];
    expect(node?.content).toEqual({ kind: "web", url: `${GATEWAY}dialog.html` });
    const child = frame("child", node?.id ?? null, "picker");
    receive(child, { type: "surface.close", surfaceId: "picker", result: { colour: "red" } });
    expect(tree.nodes).toEqual([]);
    expect(sent).toEqual([
      ["panel", { type: "surface.opened", requestId: "1", surfaceId: "picker" }],
      [
        "panel",
        {
          type: "surface.closed",
          surfaceId: "picker",
          reason: "closed",
          result: { colour: "red" },
        },
      ],
    ]);
  });

  it("rejects paths outside the panel, unknown parents and reused ids", () => {
    const { tree, sent, frame, receive } = setup();
    const panel = frame("panel");
    const open = (requestId: string, extra: object) =>
      receive(panel, {
        type: "surface.open",
        requestId,
        surfaceId: "s",
        presentation: "popover",
        content: structured,
        ...extra,
      });
    open("1", { content: { kind: "web", path: "../other/index.html" } });
    open("2", { parentSurfaceId: "missing" });
    open("3", {});
    open("4", {});
    receive(panel, { type: "surface.open", requestId: "5" });
    expect(tree.nodes).toHaveLength(1);
    expect(sent.map(([, message]) => message)).toEqual([
      { type: "error", requestId: "1", message: "That path is outside this plugin." },
      { type: "error", requestId: "2", message: "The parent surface is not open." },
      { type: "surface.opened", requestId: "3", surfaceId: "s" },
      { type: "error", requestId: "4", message: "A surface with that id is already open." },
      { type: "error", requestId: "5", message: "Bridge message is invalid." },
    ]);
  });

  it("closes children with their parent and reports nothing to a frame that reloaded", () => {
    const { tree, sent, frame, receive } = setup();
    const panel = frame("panel");
    const open = (surfaceId: string, parentSurfaceId?: string) =>
      receive(panel, {
        type: "surface.open",
        requestId: surfaceId,
        surfaceId,
        presentation: "dialog",
        content: structured,
        ...(parentSurfaceId === undefined ? {} : { parentSurfaceId }),
      });
    open("a");
    open("b", "a");
    sent.length = 0;
    receive(panel, { type: "surface.close", surfaceId: "a" });
    expect(sent.map(([, message]) => message)).toEqual([
      { type: "surface.closed", surfaceId: "b", reason: "parent" },
      { type: "surface.closed", surfaceId: "a", reason: "closed" },
    ]);

    open("c");
    sent.length = 0;
    handlePluginBridgeRelay(tree, panel, { kind: "reset" }, async () => null);
    expect(tree.nodes).toEqual([]);
    expect(sent).toEqual([]);
    // The reloaded document may reuse its ids.
    open("c");
    expect(sent.map(([, message]) => message.type)).toEqual(["surface.opened"]);
  });

  it("answers agent requests with the agent's outcome", async () => {
    const requests: unknown[] = [];
    const { sent, frame, receive } = setup(async (_frame, request) => {
      requests.push(request);
      return request.kind === "stop" ? "Declined by the user." : null;
    });
    const panel = frame("panel");
    const replied = new Promise<void>((resolve) => {
      panel.send = (message) => {
        sent.push(["panel", message]);
        if (sent.length === 2) resolve();
      };
    });
    receive(panel, { type: "agent.prompt", requestId: "p", prompt: "Hello" });
    receive(panel, { type: "agent.stop", requestId: "s" });
    await replied;
    expect(requests).toEqual([{ kind: "prompt", prompt: "Hello" }, { kind: "stop" }]);
    expect(sent.map(([, message]) => message)).toEqual([
      { type: "agent.result", requestId: "p", ok: true },
      { type: "agent.result", requestId: "s", ok: false, error: "Declined by the user." },
    ]);
  });
});

describe("decodePluginBridgeRelay", () => {
  it("accepts only the host page's relay shapes", () => {
    expect(decodePluginBridgeRelay('{"reset":true}')).toEqual({ kind: "reset" });
    expect(decodePluginBridgeRelay('{"bridge":{"type":"x"},"frameRect":{}}')).toEqual({
      kind: "message",
      data: { type: "x" },
    });
    expect(decodePluginBridgeRelay('{"rejected":"size","requestId":"r"}')).toEqual({
      kind: "rejected",
      requestId: "r",
      message: "Bridge message is too large.",
    });
    for (const text of ["not json", "null", '{"type":"surface.open"}', '{"rejected":"x"}']) {
      expect(decodePluginBridgeRelay(text)).toBeNull();
    }
  });
});

it("keeps a plugin-chosen surface id inside the host page's script", () => {
  const html = pluginBridgeHostHtml(`${GATEWAY}a.html?x="1"&y=<b>`, "</script><script>x()");
  expect(html.match(/<\/script>/g)).toHaveLength(1);
  expect(html).toContain(
    'src="https://host.test/plugins/demo/app/a.html?x=&quot;1&quot;&amp;y=&lt;b>"',
  );
});
