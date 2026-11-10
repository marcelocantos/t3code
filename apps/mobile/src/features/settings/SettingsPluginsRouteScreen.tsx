import { useAtomValue } from "@effect/atom-react";
import {
  describePluginDiscoveryItem,
  pluginDiscoveryChoices,
  pluginNeedsDecision,
  type PluginDiscoveryChoice,
} from "@t3tools/client-runtime/state/pluginDiscovery";
import type { EnvironmentId, PluginDiscoveryItem } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { pluginDiscovery, pluginFailureMessage } from "../plugins/pluginAtoms";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const EXPLANATION =
  "T3 Code found these plugins running on this machine. Enabled plugins can add panels to your threads and sidebar. Select the ones you want.";

export function SettingsPluginsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <SettingsScreen title="Plugins">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.map((target) => (
          <EnvironmentPlugins
            key={target.environmentId}
            environmentId={target.environmentId}
            label={selectedTargets.length > 1 ? target.label : undefined}
          />
        ))}
        {selectedTargets.length === 0 ? (
          <Text className="px-2 text-sm text-foreground-muted">
            Connect an environment to manage its plugins.
          </Text>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentPlugins(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | undefined;
}) {
  const query = useEnvironmentQuery(
    pluginDiscovery.state({ environmentId: props.environmentId, input: {} }),
  );
  const canDecide = useAtomValue(pluginDiscovery.act.permissionAtom(props.environmentId));
  const act = useAtomCommand(pluginDiscovery.act, { reportFailure: false });
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [deferred, setDeferred] = useState(false);
  const [busy, setBusy] = useState(false);
  const plugins = query.data?.plugins ?? [];
  const offered = plugins.filter((item) => item.state === "offered");
  const moved = plugins.filter((item) => item.state === "enabled" && pluginNeedsDecision(item));
  const settled = plugins.filter((item) => !offered.includes(item) && !moved.includes(item));

  const apply = async (choices: ReadonlyArray<PluginDiscoveryChoice>) => {
    setBusy(true);
    for (const choice of choices) {
      const result = await act({ environmentId: props.environmentId, input: choice.input });
      if (result._tag === "Failure") {
        setBusy(false);
        Dialog.alert(`Could not ${choice.label.toLowerCase()}`, pluginFailureMessage(result.cause));
        return;
      }
    }
    setBusy(false);
  };
  const choice = (item: PluginDiscoveryItem, action: PluginDiscoveryChoice["input"]["action"]) =>
    pluginDiscoveryChoices(item).find((candidate) => candidate.input.action === action);

  if (query.error) {
    return (
      <Text className="px-2 text-sm text-foreground-muted">
        {props.label ? `${props.label}: ` : ""}Plugins unavailable: {query.error}
      </Text>
    );
  }
  if (plugins.length === 0) {
    return (
      <SettingsSection title={props.label}>
        <ListRowLayout
          label={query.isPending ? "Looking for plugins…" : "No plugins found"}
          description={query.isPending ? undefined : "Plugins running on this machine appear here."}
        />
      </SettingsSection>
    );
  }
  return (
    <View className="gap-4">
      {props.label ? (
        <Text accessibilityRole="header" className="px-2 font-t3-medium text-foreground">
          {props.label}
        </Text>
      ) : null}
      {(offered.length > 0 && !deferred) || moved.length > 0 ? (
        <Text className="px-2 text-sm text-foreground-muted">{EXPLANATION}</Text>
      ) : null}
      {offered.length > 0 && !deferred ? (
        <SettingsSection title="New plugins">
          {offered.map((item, index) => (
            <SelectionRow
              key={item.id}
              role="checkbox"
              title={item.name}
              subtitle={describePluginDiscoveryItem(item)}
              selected={checked.has(item.id)}
              disabled={!canDecide || busy}
              isFirst={index === 0}
              isLast={index === offered.length - 1}
              onPress={() =>
                setChecked((current) => {
                  const next = new Set(current);
                  if (!next.delete(item.id)) next.add(item.id);
                  return next;
                })
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      {offered.length > 0 && !deferred && canDecide ? (
        <View className="flex-row flex-wrap gap-2 px-2">
          <Button
            label="Enable selected"
            tone="primary"
            size="compact"
            loading={busy}
            onPress={() =>
              void apply(
                offered.flatMap((item) => {
                  const next = choice(item, checked.has(item.id) ? "enable" : "dismiss");
                  return next ? [next] : [];
                }),
              ).then(() => setChecked(new Set()))
            }
          />
          <Button
            label="Not now"
            size="compact"
            disabled={busy}
            onPress={() => setDeferred(true)}
          />
        </View>
      ) : null}
      {moved.length > 0 ? (
        <SettingsSection title="Changed plugins">
          {moved.map((item) => (
            <View key={item.id} className="gap-2 px-4 py-3">
              <Text className="text-foreground">{item.name}</Text>
              <Text className="text-sm text-foreground-muted">
                {describePluginDiscoveryItem(item)}
              </Text>
              {canDecide ? (
                <View className="flex-row flex-wrap gap-2">
                  {(["enable", "dismiss"] as const).flatMap((action) => {
                    const next = choice(item, action);
                    return next
                      ? [
                          <Button
                            key={action}
                            label={next.label}
                            tone={action === "enable" ? "primary" : "secondary"}
                            size="compact"
                            disabled={busy}
                            onPress={() => void apply([next])}
                          />,
                        ]
                      : [];
                  })}
                </View>
              ) : null}
            </View>
          ))}
        </SettingsSection>
      ) : null}
      {settled.length > 0 ? (
        <SettingsSection title="Plugins">
          {settled.map((item, index) => (
            <SettledPlugin
              key={item.id}
              item={item}
              separated={index > 0}
              canDecide={canDecide}
              busy={busy}
              onChoose={(next) => void apply([next])}
            />
          ))}
        </SettingsSection>
      ) : null}
    </View>
  );
}

function SettledPlugin(props: {
  readonly item: PluginDiscoveryItem;
  readonly separated: boolean;
  readonly canDecide: boolean;
  readonly busy: boolean;
  readonly onChoose: (choice: PluginDiscoveryChoice) => void;
}) {
  const { item } = props;
  const choices = pluginDiscoveryChoices(item);
  const toggle = choices.find((choice) =>
    item.state === "enabled" ? choice.input.action === "disable" : choice.input.action === "enable",
  );
  const secondary = choices.filter(
    (choice) => choice.input.action !== "enable" && choice.input.action !== "disable",
  );
  const description = describePluginDiscoveryItem(item);
  return (
    <View className={props.separated ? "border-t border-border-subtle" : undefined}>
      {props.canDecide && item.state !== "manual" ? (
        <ListToggleRow
          label={item.name}
          description={description}
          value={item.state === "enabled"}
          disabled={props.busy || toggle === undefined}
          onValueChange={() => {
            if (toggle) props.onChoose(toggle);
          }}
        />
      ) : (
        <ListRowLayout label={item.name} description={description} />
      )}
      {props.canDecide && secondary.length > 0 ? (
        <View className="flex-row flex-wrap gap-2 px-4 pb-3">
          {secondary.map((choice) => (
            <Button
              key={choice.label}
              label={choice.label}
              tone="text"
              size="compact"
              disabled={props.busy}
              onPress={() => props.onChoose(choice)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}
