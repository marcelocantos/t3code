import { useAtomValue } from "@effect/atom-react";
import { planPluginSurfacing } from "@t3tools/client-runtime/state/pluginDiscovery";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { toastManager } from "../ui/toast";
import {
  pluginDiscovery,
  recordSurfacedPluginDecisions,
  surfacedPluginDecisions,
} from "./pluginState";

/** What this app session has done: which environments it has looked at, whether it navigated. */
const appSession = { looked: new Set<EnvironmentId>(), navigated: false };

/**
 * Brings plugins waiting on a decision to the user: once per app start by opening
 * Settings → Plugins, afterwards with a toast. Each decision is surfaced once per client.
 */
export function PluginDiscoveryWatcher() {
  const { environments } = useEnvironments();
  return environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => (
      <EnvironmentDiscoveryWatch
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    ));
}

function EnvironmentDiscoveryWatch({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(pluginDiscovery.state({ environmentId, input: {} }));
  const canDecide = useAtomValue(pluginDiscovery.act.permissionAtom(environmentId));
  const navigate = useNavigate();
  const plugins = query.data?.plugins;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each discovery snapshot from the server may navigate or toast, which happen outside React
  useEffect(() => {
    if (plugins === undefined) return;
    const review = () =>
      void navigate({ to: "/settings/plugins", search: { machine: environmentId } });
    const plan = planPluginSurfacing({
      environmentId,
      items: plugins,
      surfaced: new Set(surfacedPluginDecisions.read()),
      canDecide,
      startupDone: appSession.looked.has(environmentId),
      navigated: appSession.navigated,
    });
    appSession.looked.add(environmentId);
    recordSurfacedPluginDecisions(plan.record);
    if (plan.navigate) {
      appSession.navigated = true;
      review();
    }
    for (const item of plan.announce) {
      toastManager.add({
        type: "info",
        title: `New plugin found: ${item.name}`,
        actionProps: { children: "Review", onClick: review },
      });
    }
  }, [plugins, canDecide, environmentId, navigate]);
  return null;
}
