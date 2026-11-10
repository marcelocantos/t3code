import { useAtomValue } from "@effect/atom-react";
import {
  createPluginDiscoveryAtoms,
  describePluginDiscoveryItem,
  pluginDiscoveryChoices,
  pluginNeedsDecision,
} from "@t3tools/client-runtime/state/pluginDiscovery";
import type { EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const pluginDiscovery = createPluginDiscoveryAtoms(connectionAtomRuntime);

/** Plugins the environment found running, with the user's Enable, Dismiss, Disable and reset choices. */
export function PluginDiscoveryCard({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(pluginDiscovery.state({ environmentId, input: {} }));
  const act = useAtomCommand(pluginDiscovery.act);
  const canDecide = useAtomValue(pluginDiscovery.act.permissionAtom(environmentId));
  const plugins = query.data?.plugins ?? [];
  if (plugins.length === 0) return null;
  return (
    <View className="gap-2 rounded-xl bg-grouped-card p-3">
      <Text accessibilityRole="header" className="font-t3-medium text-foreground">
        Plugins
      </Text>
      {plugins.map((item) => (
        <View key={item.id} className="gap-1">
          <Text className="text-sm text-foreground">{item.name}</Text>
          <Text className="text-xs text-foreground-muted">{describePluginDiscoveryItem(item)}</Text>
          <View className="flex-row flex-wrap gap-2">
            {pluginDiscoveryChoices(item).map((choice, index) => (
              <Pressable
                key={choice.label}
                accessibilityRole="button"
                accessibilityLabel={`${item.name}: ${choice.label}`}
                accessibilityState={{ disabled: !canDecide }}
                disabled={!canDecide}
                className={
                  index === 0 && pluginNeedsDecision(item)
                    ? "min-h-11 justify-center rounded-lg bg-primary px-3"
                    : "min-h-11 justify-center rounded-lg bg-subtle px-3"
                }
                onPress={() => void act({ environmentId, input: choice.input })}
              >
                <Text
                  className={
                    index === 0 && pluginNeedsDecision(item)
                      ? "text-sm text-primary-foreground"
                      : "text-sm text-foreground"
                  }
                >
                  {choice.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}
