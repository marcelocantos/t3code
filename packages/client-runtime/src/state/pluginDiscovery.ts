import {
  WS_METHODS,
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
  item.state === "offered" || (item.state === "enabled" && item.discoveredBaseUrl !== undefined);

export function describePluginDiscoveryItem(item: PluginDiscoveryItem): string {
  switch (item.state) {
    case "offered":
      return `${item.name} is running at ${host(item.baseUrl ?? "")}. Show it in thread details?`;
    case "enabled":
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
          ? []
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
