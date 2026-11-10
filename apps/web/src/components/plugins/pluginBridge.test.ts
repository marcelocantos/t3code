import { describe, expect, it } from "vite-plus/test";
import {
  clampPluginSurfaceSize,
  parsePluginBridgeMessage,
  pluginAnchorInWindow,
  PLUGIN_BRIDGE_MAX_MESSAGE_BYTES,
  resolvePluginWebPath,
} from "./pluginBridge";

describe("parsePluginBridgeMessage", () => {
  it("accepts each frame message the bridge defines", () => {
    for (const message of [
      {
        type: "surface.open",
        requestId: "r1",
        surfaceId: "card",
        presentation: "popover",
        anchor: { x: 1, y: 2, width: 30, height: 10 },
        placement: "right-start",
        content: { kind: "structured", surface: { title: "Card", blocks: [] } },
      },
      {
        type: "surface.open",
        requestId: "r2",
        surfaceId: "pick",
        parentSurfaceId: "card",
        presentation: "dialog",
        size: { width: 400, height: 300 },
        content: { kind: "web", path: "dialog.html" },
      },
      { type: "surface.update", surfaceId: "card", anchor: { x: 0, y: 0, width: 1, height: 1 } },
      { type: "surface.close", surfaceId: "pick", result: { chosen: ["a", 1] } },
      { type: "agent.prompt", requestId: "r3", prompt: "Run the tests" },
      { type: "agent.stop", requestId: "r4" },
    ]) {
      expect(parsePluginBridgeMessage(message)).toEqual({ ok: true, message });
    }
  });

  it("rejects malformed, oversized, and non-JSON messages and keeps the request id", () => {
    expect(
      parsePluginBridgeMessage({
        type: "surface.open",
        requestId: "r1",
        surfaceId: "x",
        presentation: "fullscreen",
        content: { kind: "web", path: "a" },
      }),
    ).toEqual({ ok: false, requestId: "r1", message: "Bridge message is invalid." });
    expect(parsePluginBridgeMessage({ type: "window.open", url: "https://example.com" }).ok).toBe(
      false,
    );
    expect(
      parsePluginBridgeMessage({
        type: "surface.close",
        surfaceId: "x",
        result: "a".repeat(PLUGIN_BRIDGE_MAX_MESSAGE_BYTES),
      }),
    ).toEqual({ ok: false, message: "Bridge message is too large." });
    const cyclic: Record<string, unknown> = { type: "surface.close", surfaceId: "x" };
    cyclic.result = cyclic;
    expect(parsePluginBridgeMessage(cyclic).ok).toBe(false);
    expect(parsePluginBridgeMessage({ type: "agent.stop", requestId: "r", extra: 1n }).ok).toBe(
      false,
    );
  });
});

describe("resolvePluginWebPath", () => {
  const gateway = "https://host.example/api/plugin-gateway/token/";

  it("resolves relative paths inside the gateway directory", () => {
    expect(resolvePluginWebPath(gateway, "dialog.html")).toBe(`${gateway}dialog.html`);
    expect(resolvePluginWebPath(gateway, "nested/view.html?mode=pick")).toBe(
      `${gateway}nested/view.html?mode=pick`,
    );
    expect(resolvePluginWebPath(`${gateway}index.html`, "child.html")).toBe(`${gateway}child.html`);
  });

  it.each([
    "../other/",
    "./a/../../b",
    "%2e%2e/escape",
    "%252e%252e/double-encoded",
    "/api/plugin-gateway/other/",
    "//evil.example/",
    "https://evil.example/",
    "javascript:alert(1)",
    "a\\..\\b",
    "a b",
    "page#frag",
  ])("refuses %s", (path) => {
    expect(resolvePluginWebPath(gateway, path)).toBeNull();
  });
});

describe("pluginAnchorInWindow", () => {
  const viewport = { width: 1200, height: 800 };
  const frame = { left: 900, top: 100, width: 280, height: 400 };

  it("translates frame coordinates to the window", () => {
    expect(pluginAnchorInWindow(frame, { x: 10, y: 20, width: 50, height: 30 }, viewport)).toEqual({
      left: 910,
      top: 120,
      width: 50,
      height: 30,
    });
  });

  it("clamps anchors to the visible part of the frame", () => {
    expect(
      pluginAnchorInWindow(frame, { x: -500, y: 390, width: 2000, height: 100 }, viewport),
    ).toEqual({ left: 900, top: 490, width: 280, height: 10 });
    expect(
      pluginAnchorInWindow(
        { left: 1100, top: -50, width: 300, height: 100 },
        { x: 250, y: 0, width: 10, height: 10 },
        viewport,
      ),
    ).toEqual({ left: 1200, top: 0, width: 0, height: 0 });
  });
});

it("keeps requested surface sizes within host limits", () => {
  expect(clampPluginSurfaceSize({ width: 5000, height: 10 }, { width: 1200, height: 800 })).toEqual(
    { width: 800, height: 80 },
  );
  expect(clampPluginSurfaceSize({ width: 700, height: 700 }, { width: 500, height: 400 })).toEqual({
    width: 468,
    height: 368,
  });
});
