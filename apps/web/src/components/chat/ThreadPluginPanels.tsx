import { PluginWebPanel } from "../plugins/PluginWebPanel";
import { useState } from "react";
import { createPanelPluginAtoms } from "@t3tools/client-runtime/state/panelPlugins";
import type { EnvironmentId, ThreadId, SubscribePluginPanelsInput } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const pluginPanels = createPanelPluginAtoms(connectionAtomRuntime);

export function ThreadPluginPanels(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  return <Panels key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function Panels({ environmentId, threadId }: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const [filters, setFilters] = useState<SubscribePluginPanelsInput["filters"]>([]);
  const query = useEnvironmentQuery(pluginPanels({ environmentId, input: { threadId, filters } }));
  return (
    <>
      {query.error ? (
        <p role="alert" className="px-4 text-xs text-muted-foreground">
          Plugin panels unavailable: {query.error}
        </p>
      ) : null}
      {query.data?.map((plugin) =>
        plugin.status !== "connected" ? (
          <ThreadDetailsSection
            key={plugin.pluginId}
            headingId={`plugin-${plugin.pluginId}`}
            title={plugin.pluginId}
          >
            <p className="px-2.5 text-xs text-muted-foreground" role="status">
              {plugin.status === "connecting"
                ? "Connecting…"
                : plugin.status === "error"
                  ? "Plugin configuration or response is invalid. Check panel-plugins.json and the plugin."
                  : "Plugin disconnected. Reconnecting…"}
            </p>
          </ThreadDetailsSection>
        ) : (
          plugin.panels.map((panel) =>
            panel.kind === "web" ? (
              <ThreadDetailsSection
                key={`${plugin.pluginId}:${panel.id}`}
                headingId={`plugin-${plugin.pluginId}-${panel.id}`}
                title={panel.title}
              >
                <PluginWebPanel environmentId={environmentId} panel={panel} />
              </ThreadDetailsSection>
            ) : (
              <ThreadDetailsSection
                key={`${plugin.pluginId}:${panel.id}`}
                headingId={`plugin-${plugin.pluginId}-${panel.id}`}
                title={panel.title}
                actions={
                  panel.filters.length > 0 ? (
                    <select
                      aria-label={`${panel.title} filter`}
                      className="max-w-32 rounded border border-border bg-background text-xs"
                      value={panel.filter}
                      onChange={(event) => {
                        const filter = event.target.value;
                        setFilters((current) => [
                          ...current.filter(
                            (item) =>
                              item.pluginId !== plugin.pluginId || item.panelId !== panel.id,
                          ),
                          { pluginId: plugin.pluginId, panelId: panel.id, filter },
                        ]);
                      }}
                    >
                      {panel.filters.map((filter) => (
                        <option key={filter.id} value={filter.id}>
                          {filter.label}
                        </option>
                      ))}
                    </select>
                  ) : undefined
                }
              >
                <ul className="space-y-2 px-2.5 text-xs">
                  {panel.rows.map((row) => (
                    <li key={row.id} className="break-words">
                      <div>{row.label}</div>
                      {row.detail ? (
                        <div className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                          {row.detail}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {panel.rows.length === 0 ? (
                  <p className="px-2.5 text-xs text-muted-foreground">No items.</p>
                ) : null}
              </ThreadDetailsSection>
            ),
          )
        ),
      )}
    </>
  );
}
