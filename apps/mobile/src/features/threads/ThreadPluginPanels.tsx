import { PluginWebPanel } from "../plugins/PluginWebPanel";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { createPanelPluginAtoms } from "@t3tools/client-runtime/state/panelPlugins";
import type { ScopedThreadRef, SubscribePluginPanelsInput } from "@t3tools/contracts";
import { AppText as Text } from "../../components/ui/AppText";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";

const pluginPanels = createPanelPluginAtoms(connectionAtomRuntime);

export function ThreadPluginPanels({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [filters, setFilters] = useState<SubscribePluginPanelsInput["filters"]>([]);
  const query = useEnvironmentQuery(
    pluginPanels({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, filters },
    }),
  );
  return (
    <View className="gap-3 px-4 py-2">
      {query.error ? (
        <Text className="text-sm text-foreground-muted">
          Plugin panels unavailable: {query.error}
        </Text>
      ) : null}
      {query.data?.map((plugin) =>
        plugin.status !== "connected" ? (
          <Text key={plugin.pluginId} className="text-sm text-foreground-muted">
            {plugin.pluginId}:{" "}
            {plugin.status === "connecting"
              ? "Connecting…"
              : plugin.status === "error"
                ? "Check the plugin configuration."
                : "Disconnected. Reconnecting…"}
          </Text>
        ) : (
          plugin.panels.map((panel) =>
            panel.kind === "web" ? (
              <View key={`${plugin.pluginId}:${panel.id}`} className="gap-2">
                <Text accessibilityRole="header" className="font-t3-medium text-foreground">
                  {panel.title}
                </Text>
                <PluginWebPanel environmentId={threadRef.environmentId} panel={panel} />
              </View>
            ) : (
              <View
                key={`${plugin.pluginId}:${panel.id}`}
                className="gap-2 rounded-xl bg-grouped-card p-3"
              >
                <Text accessibilityRole="header" className="font-t3-medium text-foreground">
                  {panel.title}
                </Text>
                <View className="flex-row flex-wrap gap-2">
                  {panel.filters.map((filter) => (
                    <Pressable
                      key={filter.id}
                      accessibilityRole="radio"
                      accessibilityLabel={`${panel.title}: ${filter.label}`}
                      accessibilityState={{ checked: panel.filter === filter.id }}
                      className="min-h-11 justify-center rounded-lg bg-subtle px-3"
                      onPress={() =>
                        setFilters((current) => [
                          ...current.filter(
                            (item) =>
                              item.pluginId !== plugin.pluginId || item.panelId !== panel.id,
                          ),
                          { pluginId: plugin.pluginId, panelId: panel.id, filter: filter.id },
                        ])
                      }
                    >
                      <Text className="text-sm text-foreground">
                        {panel.filter === filter.id ? "✓ " : ""}
                        {filter.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {panel.rows.map((row) => (
                  <View key={row.id} className="gap-1">
                    <Text selectable className="text-sm text-foreground">
                      {row.label}
                    </Text>
                    {row.detail ? (
                      <Text selectable className="text-xs text-foreground-muted">
                        {row.detail}
                      </Text>
                    ) : null}
                  </View>
                ))}
                {panel.rows.length === 0 ? (
                  <Text className="text-sm text-foreground-muted">No items.</Text>
                ) : null}
              </View>
            ),
          )
        ),
      )}
    </View>
  );
}
