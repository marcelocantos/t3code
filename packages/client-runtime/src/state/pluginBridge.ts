import { PluginSurface } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * The host side of the web-panel bridge. A panel frame gets a `MessagePort` in
 * `t3.bridge.init`; everything it sends arrives on that port and is decoded here, never from
 * `window` messages, which any frame could forge.
 */
export const PLUGIN_BRIDGE_VERSION = 1;
/** Serialized size limit for one frame message, results included. */
export const PLUGIN_BRIDGE_MAX_MESSAGE_BYTES = 256 * 1024;
const PLUGIN_SURFACE_LIMITS = {
  minWidth: 160,
  maxWidth: 800,
  minHeight: 80,
  maxHeight: 900,
  /** Kept between a surface and the window edge. */
  margin: 16,
} as const;

const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const Coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 }));
const Extent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }));
export const PluginBridgeRect = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  width: Extent,
  height: Extent,
});
export type PluginBridgeRect = typeof PluginBridgeRect.Type;
export const PluginBridgePlacement = Schema.Literals([
  "left",
  "right",
  "top",
  "bottom",
  "left-start",
  "left-end",
  "right-start",
  "right-end",
  "top-start",
  "top-end",
  "bottom-start",
  "bottom-end",
]);
export type PluginBridgePlacement = typeof PluginBridgePlacement.Type;
export const PluginBridgePresentation = Schema.Literals(["popover", "dialog", "modal"]);
export type PluginBridgePresentation = typeof PluginBridgePresentation.Type;
export const PluginBridgeContent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("structured"), surface: PluginSurface }),
  Schema.Struct({
    kind: Schema.Literal("web"),
    path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  }),
]);
export type PluginBridgeContent = typeof PluginBridgeContent.Type;

export const PluginBridgeInbound = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("surface.open"),
    requestId: Id,
    surfaceId: Id,
    parentSurfaceId: Schema.optional(Id),
    presentation: PluginBridgePresentation,
    anchor: Schema.optional(PluginBridgeRect),
    placement: Schema.optional(PluginBridgePlacement),
    size: Schema.optional(Schema.Struct({ width: Extent, height: Extent })),
    content: PluginBridgeContent,
  }),
  Schema.Struct({
    type: Schema.Literal("surface.update"),
    surfaceId: Id,
    anchor: Schema.optional(PluginBridgeRect),
    content: Schema.optional(PluginBridgeContent),
  }),
  Schema.Struct({
    type: Schema.Literal("surface.close"),
    surfaceId: Id,
    result: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("agent.prompt"),
    requestId: Id,
    prompt: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16_384)),
  }),
  Schema.Struct({ type: Schema.Literal("agent.stop"), requestId: Id }),
]);
export type PluginBridgeInbound = typeof PluginBridgeInbound.Type;

export type PluginSurfaceCloseReason = "closed" | "dismissed" | "parent";
export type PluginBridgeOutbound =
  | {
      readonly type: "t3.bridge.init";
      readonly version: typeof PLUGIN_BRIDGE_VERSION;
      /** Set for a web surface: the id its opener gave it, which `surface.close` takes. */
      readonly surfaceId?: string;
    }
  | { readonly type: "surface.opened"; readonly requestId: string; readonly surfaceId: string }
  | {
      readonly type: "surface.closed";
      readonly surfaceId: string;
      readonly result?: unknown;
      readonly reason: PluginSurfaceCloseReason;
    }
  | {
      readonly type: "surface.action";
      readonly surfaceId: string;
      readonly actionId: string;
      readonly value?: unknown;
    }
  | {
      readonly type: "agent.result";
      readonly requestId: string;
      readonly ok: boolean;
      readonly error?: string;
    }
  | { readonly type: "error"; readonly requestId?: string; readonly message: string };

const decodeInbound = Schema.decodeUnknownExit(PluginBridgeInbound);

export type PluginBridgeParse =
  | { readonly ok: true; readonly message: PluginBridgeInbound }
  | { readonly ok: false; readonly requestId?: string; readonly message: string };

const requestIdOf = (data: unknown) => {
  if (typeof data !== "object" || data === null) return undefined;
  const requestId = (data as { readonly requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length <= 128 ? requestId : undefined;
};

/** Decodes one port message. Data that cannot round-trip through JSON, or is too large, fails. */
export function parsePluginBridgeMessage(data: unknown): PluginBridgeParse {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch {
    serialized = undefined;
  }
  const requestId = requestIdOf(data);
  const failure = (message: string): PluginBridgeParse =>
    requestId === undefined ? { ok: false, message } : { ok: false, requestId, message };
  if (serialized === undefined) return failure("Bridge messages must be JSON data.");
  if (new TextEncoder().encode(serialized).byteLength > PLUGIN_BRIDGE_MAX_MESSAGE_BYTES) {
    return failure("Bridge message is too large.");
  }
  const decoded = decodeInbound(JSON.parse(serialized));
  return decoded._tag === "Success"
    ? { ok: true, message: decoded.value }
    : failure("Bridge message is invalid.");
}

/**
 * Resolves a web surface's `path` against the panel's gateway URL. Only relative paths that stay
 * inside the gateway directory resolve; the gateway checks again, but a path the host would load
 * outside it never reaches the frame.
 */
export function resolvePluginWebPath(gatewayUrl: string, path: string): string | null {
  if (
    path.startsWith("/") ||
    /[\\#\u0000- \u007f]/.test(path) ||
    /^[a-z][a-z0-9+.-]*:/i.test(path)
  ) {
    return null;
  }
  const [pathPart = ""] = path.split("?", 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  if (/[\\%]/.test(decoded) || decoded.split("/").some((part) => part === "." || part === "..")) {
    return null;
  }
  let root: URL;
  let resolved: URL;
  try {
    root = new URL("./", gatewayUrl);
    resolved = new URL(path, root);
  } catch {
    return null;
  }
  return resolved.origin === root.origin && resolved.pathname.startsWith(root.pathname)
    ? resolved.href
    : null;
}

export interface PluginViewportRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Turns an anchor in the requesting frame's viewport into window coordinates, clamped to the part
 * of the frame that is on screen, so a frame cannot anchor a surface over unrelated UI.
 */
export function pluginAnchorInWindow(
  frame: PluginViewportRect,
  anchor: PluginBridgeRect,
  viewport: { readonly width: number; readonly height: number },
): PluginViewportRect {
  const minX = Math.max(frame.left, 0);
  const minY = Math.max(frame.top, 0);
  const maxX = Math.max(minX, Math.min(frame.left + frame.width, viewport.width));
  const maxY = Math.max(minY, Math.min(frame.top + frame.height, viewport.height));
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const left = clamp(frame.left + anchor.x, minX, maxX);
  const top = clamp(frame.top + anchor.y, minY, maxY);
  const right = clamp(frame.left + anchor.x + anchor.width, left, maxX);
  const bottom = clamp(frame.top + anchor.y + anchor.height, top, maxY);
  return { left, top, width: right - left, height: bottom - top };
}

export function clampPluginSurfaceSize(
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly width: number; readonly height: number } {
  const { minWidth, maxWidth, minHeight, maxHeight, margin } = PLUGIN_SURFACE_LIMITS;
  const clamp = (value: number, min: number, max: number) =>
    Math.round(Math.min(Math.max(value, min), Math.max(min, max)));
  return {
    width: clamp(size.width, minWidth, Math.min(maxWidth, viewport.width - 2 * margin)),
    height: clamp(size.height, minHeight, Math.min(maxHeight, viewport.height - 2 * margin)),
  };
}

export function pluginPlacementParts(placement: PluginBridgePlacement | undefined): {
  readonly side: "left" | "right" | "top" | "bottom";
  readonly align: "start" | "center" | "end";
} {
  if (placement === undefined) return { side: "bottom", align: "start" };
  const [side, align] = placement.split("-") as [
    "left" | "right" | "top" | "bottom",
    "start" | "end" | undefined,
  ];
  return { side, align: align ?? "center" };
}
