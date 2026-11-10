import { useAtomValue } from "@effect/atom-react";
import {
  createPluginDiscoveryAtoms,
  describePluginDiscoveryItem,
  pluginDiscoveryChoices,
  pluginNeedsDecision,
} from "@t3tools/client-runtime/state/pluginDiscovery";
import type { EnvironmentId } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const pluginDiscovery = createPluginDiscoveryAtoms(connectionAtomRuntime);

/**
 * Plugins this environment found running, and the user's decisions about them. A plugin waiting on
 * a decision is shown open; everything else sits in a collapsed list so a settled plugin costs a
 * line. Readers without settings access see the state but cannot change it.
 */
export function PluginDiscoveryPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(pluginDiscovery.state({ environmentId, input: {} }));
  const act = useAtomCommand(pluginDiscovery.act);
  const canDecide = useAtomValue(pluginDiscovery.act.permissionAtom(environmentId));
  const plugins = query.data?.plugins ?? [];
  if (plugins.length === 0) return null;

  const rows = (items: typeof plugins) => (
    <ul className="space-y-2 px-2.5 text-xs">
      {items.map((item) => (
        <li key={item.id} className="break-words">
          <div className="font-medium">{item.name}</div>
          <div className="mt-0.5 text-muted-foreground">{describePluginDiscoveryItem(item)}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {pluginDiscoveryChoices(item).map((choice, index) => (
              <Button
                key={choice.label}
                size="compact"
                variant={index === 0 && pluginNeedsDecision(item) ? "default" : "outline"}
                disabled={!canDecide}
                onClick={() => void act({ environmentId, input: choice.input })}
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
  const pending = plugins.filter(pluginNeedsDecision);
  const settled = plugins.filter((item) => !pluginNeedsDecision(item));
  return (
    <>
      {pending.length > 0 ? (
        <ThreadDetailsSection headingId="plugin-discovery-pending" title="Plugins found">
          {rows(pending)}
        </ThreadDetailsSection>
      ) : null}
      {settled.length > 0 ? (
        <ThreadDetailsSection headingId="plugin-discovery-settled" title="Plugins">
          <details className="px-2.5 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {settled.length === 1 ? "1 plugin" : `${settled.length} plugins`}
            </summary>
            <div className="-mx-2.5 mt-2">{rows(settled)}</div>
          </details>
        </ThreadDetailsSection>
      ) : null}
    </>
  );
}
