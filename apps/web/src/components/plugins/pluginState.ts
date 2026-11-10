import {
  createEnvironmentPanelPluginAtoms,
  createPanelPluginAtoms,
  createPanelPluginCommands,
} from "@t3tools/client-runtime/state/panelPlugins";
import { createPluginDiscoveryAtoms } from "@t3tools/client-runtime/state/pluginDiscovery";
import { useSyncExternalStore } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";

export const threadPluginPanels = createPanelPluginAtoms(connectionAtomRuntime);
export const environmentPluginPanels = createEnvironmentPanelPluginAtoms(connectionAtomRuntime);
export const pluginPanelCommands = createPanelPluginCommands(connectionAtomRuntime);
export const pluginDiscovery = createPluginDiscoveryAtoms(connectionAtomRuntime);

/**
 * A small JSON value in local storage. Storage can be missing or refuse writes (private windows,
 * quotas), so every access falls back to memory instead of throwing.
 */
function localValue<T>(key: string, decode: (raw: unknown) => T) {
  const listeners = new Set<() => void>();
  let value: T | undefined;
  const read = (): T => {
    if (value !== undefined) return value;
    let raw: unknown = null;
    try {
      const stored = window.localStorage.getItem(key);
      raw = stored === null ? null : JSON.parse(stored);
    } catch {
      raw = null;
    }
    value = decode(raw);
    return value;
  };
  return {
    read,
    write(next: T) {
      value = next;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Kept in memory for this session.
      }
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

const PANEL_HEIGHT_LIMIT = 400;
const panelHeights = localValue("t3code:plugin-panel-heights:v1", (raw) => {
  const heights: Record<string, number> = {};
  if (typeof raw !== "object" || raw === null) return heights;
  for (const [key, height] of Object.entries(raw).slice(-PANEL_HEIGHT_LIMIT)) {
    if (typeof height === "number" && Number.isFinite(height)) heights[key] = height;
  }
  return heights;
});

/** Rewrites the entry last, so the oldest panels are the ones the size limit drops. */
function writePanelHeight(key: string, height: number) {
  const next: Record<string, number> = {};
  for (const [other, value] of Object.entries(panelHeights.read())) {
    if (other !== key) next[other] = value;
  }
  next[key] = height;
  panelHeights.write(next);
}

/** A panel's content height, kept per plugin and panel across threads and reloads. */
export function usePluginPanelHeight(
  pluginId: string,
  panelId: string,
  fallback: number,
): readonly [number, (height: number) => void] {
  const key = JSON.stringify([pluginId, panelId]);
  const heights = useSyncExternalStore(panelHeights.subscribe, panelHeights.read);
  return [heights[key] ?? fallback, (height: number) => writePanelHeight(key, height)];
}

const SURFACED_LIMIT = 500;
/** Decisions this client already surfaced; see `pluginSurfacingKey`. */
export const surfacedPluginDecisions = localValue(
  "t3code:plugin-decisions-surfaced:v1",
  (raw): ReadonlyArray<string> =>
    Array.isArray(raw)
      ? raw.filter((key): key is string => typeof key === "string").slice(-SURFACED_LIMIT)
      : [],
);

export function recordSurfacedPluginDecisions(keys: ReadonlyArray<string>) {
  if (keys.length === 0) return;
  const next = new Set(surfacedPluginDecisions.read());
  for (const key of keys) next.add(key);
  surfacedPluginDecisions.write([...next].slice(-SURFACED_LIMIT));
}
