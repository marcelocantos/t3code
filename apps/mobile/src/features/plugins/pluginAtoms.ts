import {
  createEnvironmentPanelPluginAtoms,
  createPanelPluginAtoms,
  createPanelPluginCommands,
} from "@t3tools/client-runtime/state/panelPlugins";
import {
  createPluginDiscoveryAtoms,
  pluginNeedsDecision,
} from "@t3tools/client-runtime/state/pluginDiscovery";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";

export const threadPluginPanels = createPanelPluginAtoms(connectionAtomRuntime);
export const environmentPluginPanels = createEnvironmentPanelPluginAtoms(connectionAtomRuntime);
export const pluginPanelCommands = createPanelPluginCommands(connectionAtomRuntime);
export const pluginDiscovery = createPluginDiscoveryAtoms(connectionAtomRuntime);

/** Plugins waiting on a decision across environments, keyed by space-separated environment ids. */
export const pluginDecisionCountAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    environmentIds
      .split(" ")
      .filter((id) => id.length > 0)
      .reduce((count, id) => {
        const result = get(
          pluginDiscovery.state({ environmentId: EnvironmentId.make(id), input: {} }),
        );
        return (
          count +
          (AsyncResult.isSuccess(result)
            ? result.value.plugins.filter(pluginNeedsDecision).length
            : 0)
        );
      }, 0),
  ).pipe(Atom.withLabel("mobile:plugin-discovery:decision-count")),
);

export function pluginFailureMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The plugin request failed.";
}
