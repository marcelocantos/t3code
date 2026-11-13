import { useAtomValue } from "@effect/atom-react";
import {
  describePluginDiscoveryItem,
  pluginDiscoveryChoices,
  pluginNeedsDecision,
} from "@t3tools/client-runtime/state/pluginDiscovery";
import type {
  EnvironmentId,
  PluginDiscoveryActionInput,
  PluginDiscoveryItem,
} from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DefaultAppLinksSetting } from "./DefaultAppFileLink";
import { pluginDiscovery } from "./pluginState";

export const PLUGINS_FOUND_EXPLANATION =
  "T3 Code found these plugins running on this machine. Enabled plugins can add panels to your threads and sidebar. Select the ones you want.";

export function PluginsSettingsPanel() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  // Selections and the "not now" choice belong to one environment.
  return environmentId === null ? (
    <SettingsPageContainer>
      <p className="text-sm text-muted-foreground">Choose an environment to manage its plugins.</p>
    </SettingsPageContainer>
  ) : (
    <PluginsSettingsBody key={environmentId} environmentId={environmentId} />
  );
}

function PluginsSettingsBody({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(pluginDiscovery.state({ environmentId, input: {} }));
  const act = useAtomCommand(pluginDiscovery.act);
  const canDecide = useAtomValue(pluginDiscovery.act.permissionAtom(environmentId));
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deferred, setDeferred] = useState(false);
  const [busy, setBusy] = useState(false);
  const plugins = query.data?.plugins ?? [];
  const offered = deferred ? [] : plugins.filter((item) => item.state === "offered");
  const moved = plugins.filter((item) => item.state === "enabled" && pluginNeedsDecision(item));
  const settled = plugins.filter((item) => !offered.includes(item) && !moved.includes(item));
  const run = async (inputs: ReadonlyArray<PluginDiscoveryActionInput>) => {
    setBusy(true);
    for (const input of inputs) await act({ environmentId, input });
    setBusy(false);
  };
  const disabled = !canDecide || busy;

  return (
    <SettingsPageContainer>
      {offered.length > 0 || moved.length > 0 ? (
        <SettingsSection title="Plugins found" id="plugins-found">
          <p className="px-4 pt-3 text-sm text-muted-foreground">{PLUGINS_FOUND_EXPLANATION}</p>
          {offered.length > 0 ? (
            <>
              <ul className="flex flex-col">
                {offered.map((item) => (
                  <li key={item.id}>
                    <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
                      <Checkbox
                        aria-label={`Enable ${item.name}`}
                        checked={selected.has(item.id)}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          })
                        }
                      />
                      <PluginSummary item={item} />
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap justify-end gap-2 border-t px-4 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setDeferred(true)}
                >
                  Not now
                </Button>
                <Button
                  size="sm"
                  disabled={disabled}
                  onClick={() =>
                    void run(
                      offered.map((item): PluginDiscoveryActionInput =>
                        selected.has(item.id) && item.baseUrl !== undefined
                          ? { action: "enable", id: item.id, baseUrl: item.baseUrl }
                          : { action: "dismiss", id: item.id },
                      ),
                    )
                  }
                >
                  Enable selected
                </Button>
              </div>
            </>
          ) : null}
          {moved.length > 0 ? (
            <ul className="flex flex-col border-t">
              {moved.map((item) => (
                <li key={item.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <PluginSummary item={item} />
                  <div className="flex gap-2">
                    {pluginDiscoveryChoices(item)
                      .filter((choice) => choice.input.action !== "disable")
                      .map((choice, index) => (
                        <Button
                          key={choice.label}
                          size="sm"
                          variant={index === 0 ? "default" : "outline"}
                          disabled={disabled}
                          onClick={() => void run([choice.input])}
                        >
                          {choice.label}
                        </Button>
                      ))}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </SettingsSection>
      ) : null}
      <SettingsSection title="Plugins" id="plugins">
        {settled.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {query.data === undefined
              ? "Looking for plugins…"
              : plugins.length > 0
                ? "No plugins enabled yet."
                : "No plugins found on this environment."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {settled.map((item) => {
              const choices = pluginDiscoveryChoices(item);
              const toggle = choices.find(
                (choice) =>
                  choice.input.action === (item.state === "enabled" ? "disable" : "enable"),
              );
              const secondary = choices.filter((choice) => choice.input.action === "reset");
              return (
                <li key={item.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                    <Checkbox
                      aria-label={`${item.name} enabled`}
                      checked={item.state === "enabled" || item.state === "manual"}
                      disabled={disabled || toggle === undefined}
                      onCheckedChange={() => {
                        if (toggle !== undefined) void run([toggle.input]);
                      }}
                    />
                    <PluginSummary item={item} />
                  </label>
                  {secondary.map((choice) => (
                    <Button
                      key={choice.label}
                      size="xs"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => void run([choice.input])}
                    >
                      {choice.label}
                    </Button>
                  ))}
                </li>
              );
            })}
          </ul>
        )}
        {canDecide ? null : (
          <p className="border-t px-4 py-3 text-xs text-muted-foreground">
            You can see this environment's plugins but not change them.
          </p>
        )}
      </SettingsSection>
      <SettingsSection title="File links" id="plugin-file-links">
        <DefaultAppLinksSetting />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function PluginSummary({ item }: { item: PluginDiscoveryItem }) {
  return (
    <div className="min-w-0 flex-1 text-sm">
      <div className="font-medium text-foreground">{item.name}</div>
      <div className="break-words text-xs text-muted-foreground">
        {describePluginDiscoveryItem(item)}
      </div>
    </div>
  );
}
