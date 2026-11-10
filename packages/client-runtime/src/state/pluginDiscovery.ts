import {
  WS_METHODS,
  type EnvironmentId,
  type PluginDiscoveryActionInput,
  type PluginDiscoveryItem,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPluginDiscoveryAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // Scanning for advertised plugins runs only while a client watches.
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugin-discovery",
      tag: WS_METHODS.subscribePluginDiscovery,
      idleTtlMs: 0,
    }),
    act: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugin-discovery:act",
      tag: WS_METHODS.pluginDiscoveryAct,
    }),
  };
}

export interface PluginDiscoveryChoice {
  readonly label: string;
  readonly input: PluginDiscoveryActionInput;
}

const host = (baseUrl: string) => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

/** Whether the plugin waits on a decision rather than merely being listed. */
export const pluginNeedsDecision = (item: PluginDiscoveryItem) =>
  item.state === "offered" ||
  (item.state === "enabled" &&
    (item.discoveredBaseUrl !== undefined || item.pendingScopes !== undefined));

export function describePluginDiscoveryItem(item: PluginDiscoveryItem): string {
  switch (item.state) {
    case "offered":
      return `Running at ${host(item.baseUrl ?? "")}`;
    case "enabled":
      if (item.discoveredBaseUrl === undefined && item.pendingScopes?.includes("environment"))
        return `${item.name} now also asks to show a sidebar panel that sees all your projects. Allow it?`;
      return item.discoveredBaseUrl === undefined
        ? item.live
          ? "Enabled"
          : "Enabled · not running"
        : `${item.name} is now running at ${host(item.discoveredBaseUrl)}, not ${host(item.baseUrl ?? "")}. Switch to it?`;
    case "disabled":
      return "Disabled";
    case "dismissed":
      return "Dismissed";
    case "manual":
      return "Configured in panel-plugins.json";
  }
}

/** The buttons a plugin offers, primary choice first. */
export function pluginDiscoveryChoices(
  item: PluginDiscoveryItem,
): ReadonlyArray<PluginDiscoveryChoice> {
  const enable = (label: string, baseUrl: string | undefined): Array<PluginDiscoveryChoice> =>
    baseUrl === undefined ? [] : [{ label, input: { action: "enable", id: item.id, baseUrl } }];
  switch (item.state) {
    case "offered":
      return [
        ...enable("Enable", item.baseUrl),
        { label: "Dismiss", input: { action: "dismiss", id: item.id } },
      ];
    case "enabled":
      return [
        ...(item.discoveredBaseUrl === undefined
          ? item.pendingScopes === undefined
            ? []
            : enable("Allow", item.baseUrl)
          : [
              ...enable("Switch", item.discoveredBaseUrl),
              {
                label: "Keep current",
                input: { action: "dismiss", id: item.id },
              } satisfies PluginDiscoveryChoice,
            ]),
        { label: "Disable", input: { action: "disable", id: item.id } },
      ];
    case "disabled":
      return [
        ...enable("Enable", item.baseUrl),
        { label: "Forget", input: { action: "reset", id: item.id } },
      ];
    case "dismissed":
      return [
        ...(item.live ? enable("Enable", item.baseUrl) : []),
        { label: "Ask again", input: { action: "reset", id: item.id } },
      ];
    case "manual":
      return [];
  }
}

/**
 * A decision a client has surfaced, keyed by the endpoint too, so a plugin that moves to a new
 * endpoint is surfaced again.
 */
export const pluginSurfacingKey = (environmentId: EnvironmentId, item: PluginDiscoveryItem) =>
  JSON.stringify([
    environmentId,
    item.id,
    item.discoveredBaseUrl ?? item.baseUrl ?? "",
    ...(item.pendingScopes ?? []),
  ]);

export interface PluginSurfacingPlan {
  /** Open Settings → Plugins for this environment. */
  readonly navigate: boolean;
  /** Plugins to announce with a toast instead. */
  readonly announce: ReadonlyArray<PluginDiscoveryItem>;
  /** Keys to record as surfaced. */
  readonly record: ReadonlyArray<string>;
}

/**
 * What to do with an environment's discovery snapshot. The first snapshot an app session sees
 * opens settings once, if anything waits on a decision this client has not shown; later
 * discoveries get a toast. Clients that cannot decide surface nothing and record nothing, so a
 * client granted access later still shows them.
 */
export function planPluginSurfacing(input: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<PluginDiscoveryItem>;
  readonly surfaced: ReadonlySet<string>;
  readonly canDecide: boolean;
  /** The app session already looked at this environment's plugins. */
  readonly startupDone: boolean;
  /** The app session already opened settings for some environment. */
  readonly navigated: boolean;
}): PluginSurfacingPlan {
  if (!input.canDecide) return { navigate: false, announce: [], record: [] };
  const fresh = input.items.filter(
    (item) =>
      pluginNeedsDecision(item) &&
      !input.surfaced.has(pluginSurfacingKey(input.environmentId, item)),
  );
  const record = fresh.map((item) => pluginSurfacingKey(input.environmentId, item));
  if (fresh.length === 0) return { navigate: false, announce: [], record };
  if (!input.startupDone && !input.navigated) return { navigate: true, announce: [], record };
  return { navigate: false, announce: fresh, record };
}
