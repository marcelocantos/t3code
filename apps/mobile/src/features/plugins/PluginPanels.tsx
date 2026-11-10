import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PluginAction,
  PluginLeafAction,
  PluginPanel,
  PluginPanelRow,
  PluginPanelSnapshot,
  PluginPanelTarget,
  RunId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ControlPill } from "../../components/ui/ControlPill";
import { IconButton } from "../../components/ui/IconButton";
import { Menu } from "../../components/ui/Menu";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { PluginBridgeHost } from "./PluginBridge";
import { PluginWebPanel } from "./PluginWebPanel";
import {
  DateActionMenu,
  PluginBadges,
  PluginSurfaceSheet,
  type PluginSurfaceEntry,
} from "./PluginSurfaceSheet";
import {
  PLUGIN_PANEL_HEIGHT,
  PLUGIN_ROW_WINDOW,
  growPluginRowWindow,
  pluginPanelHeight,
  pluginRowMenu,
  type pluginAgentRunState,
} from "./pluginRowMenu";
import { usePluginRequests, type PluginRowScope } from "./usePluginRequests";

type ListPanel = Exclude<PluginPanel, { kind: "web" }>;
type AgentRunState = ReturnType<typeof pluginAgentRunState>;

/** Thread panels submit agent prompts into their thread; environment panels have none. */
export interface PluginAgentControls {
  readonly stateOf: (rowKey: string) => AgentRunState;
  /** Resolve to an error message, or null on success. */
  readonly start: (rowKey: string, prompt: string) => Promise<string | null>;
  readonly stop: (runId: RunId) => Promise<string | null>;
}

export const pluginRowKey = (pluginId: string, panelId: string, rowId: string) =>
  `${pluginId}/${panelId}/${rowId}`;
/** The agent key of a web panel's own requests, apart from any row's. */
export const pluginFrameAgentKey = (pluginId: string, panelId: string) =>
  `${pluginId}/${panelId}#frame`;

const WEB_PANEL_DEFAULT_HEIGHT = 420;

function usePluginPanelHeight(key: string, fallback: number) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const stored = AsyncResult.isSuccess(preferences)
    ? preferences.value.pluginPanelHeights?.[key]
    : undefined;
  const height = pluginPanelHeight(stored, fallback);
  const resize = (delta: number) =>
    save({
      transform: (current) => ({
        pluginPanelHeights: {
          ...current.pluginPanelHeights,
          [key]: pluginPanelHeight(
            pluginPanelHeight(current.pluginPanelHeights?.[key], fallback) + delta,
            fallback,
          ),
        },
      }),
    });
  return { height, resize };
}

export function PluginPanels(props: {
  readonly environmentId: EnvironmentId;
  readonly target: PluginPanelTarget;
  readonly snapshots: ReadonlyArray<PluginPanelSnapshot>;
  readonly onFilter: (pluginId: string, panelId: string, filter: string) => void;
  readonly agent?: PluginAgentControls;
  /** A row with `navigate` was tapped (environment panels). */
  readonly onNavigate?: (row: PluginPanelRow) => void;
}) {
  const [sheet, setSheet] = useState<{
    readonly scope: PluginRowScope;
    readonly root: PluginSurfaceEntry;
  } | null>(null);
  return (
    // Keyed so a thread change closes every surface the previous panels opened.
    <PluginBridgeHost
      key={`${props.environmentId}:${JSON.stringify(props.target)}`}
      environmentId={props.environmentId}
      agent={props.agent}
    >
      {props.snapshots.map((plugin) =>
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
          plugin.panels.map((panel) => (
            <PanelFrame
              key={`${plugin.pluginId}:${panel.id}`}
              heightKey={`${plugin.pluginId}/${panel.id}`}
              title={panel.title}
              fallbackHeight={
                panel.kind === "web"
                  ? (panel.height ?? WEB_PANEL_DEFAULT_HEIGHT)
                  : PLUGIN_PANEL_HEIGHT.default
              }
              web={panel.kind === "web"}
            >
              {(height) =>
                panel.kind === "web" ? (
                  <PluginWebPanel
                    environmentId={props.environmentId}
                    panel={panel}
                    height={height}
                    agentKey={pluginFrameAgentKey(plugin.pluginId, panel.id)}
                  />
                ) : (
                  <ListPanelBody
                    environmentId={props.environmentId}
                    target={props.target}
                    pluginId={plugin.pluginId}
                    panel={panel}
                    height={height}
                    agent={props.agent}
                    onNavigate={props.onNavigate}
                    onFilter={(filter) => props.onFilter(plugin.pluginId, panel.id, filter)}
                    onOpenSurface={(scope, root) => setSheet({ scope, root })}
                  />
                )
              }
            </PanelFrame>
          ))
        ),
      )}
      {sheet ? (
        <PluginSurfaceSheet
          key={`${sheet.scope.pluginId}:${sheet.scope.panelId}:${sheet.scope.rowId}:${sheet.root.surfaceId ?? ""}`}
          scope={sheet.scope}
          root={sheet.root}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </PluginBridgeHost>
  );
}

function PanelFrame(props: {
  readonly heightKey: string;
  readonly title: string;
  readonly fallbackHeight: number;
  readonly web: boolean;
  readonly children: (height: number) => ReactNode;
}) {
  const { height, resize } = usePluginPanelHeight(props.heightKey, props.fallbackHeight);
  return (
    <View className={cn("gap-2", !props.web && "rounded-xl bg-grouped-card p-3")}>
      <View className="flex-row items-center gap-2">
        <Text accessibilityRole="header" className="min-w-0 flex-1 font-t3-medium text-foreground">
          {props.title}
        </Text>
        <IconButton
          icon="minus"
          accessibilityLabel={`Shorten ${props.title}`}
          disabled={height <= PLUGIN_PANEL_HEIGHT.min}
          onPress={() => resize(-PLUGIN_PANEL_HEIGHT.step)}
        />
        <IconButton
          icon="plus"
          accessibilityLabel={`Lengthen ${props.title}`}
          disabled={height >= PLUGIN_PANEL_HEIGHT.max}
          onPress={() => resize(PLUGIN_PANEL_HEIGHT.step)}
        />
      </View>
      {props.children(height)}
    </View>
  );
}

function ListPanelBody(props: {
  readonly environmentId: EnvironmentId;
  readonly target: PluginPanelTarget;
  readonly pluginId: string;
  readonly panel: ListPanel;
  readonly height: number;
  readonly agent: PluginAgentControls | undefined;
  readonly onNavigate: ((row: PluginPanelRow) => void) | undefined;
  readonly onFilter: (filter: string) => void;
  readonly onOpenSurface: (scope: PluginRowScope, root: PluginSurfaceEntry) => void;
}) {
  const { panel } = props;
  // Date shortcuts in the row menus follow the clock across midnight.
  const nowMs = useNowMinuteMs();
  const [rowLimit, setRowLimit] = useState<number>(PLUGIN_ROW_WINDOW.initial);
  return (
    <>
      {panel.filters.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          {panel.filters.map((filter) => (
            <Pressable
              key={filter.id}
              accessibilityRole="radio"
              accessibilityLabel={`${panel.title}: ${filter.label}`}
              accessibilityState={{ checked: panel.filter === filter.id }}
              className={cn(
                "min-h-9 justify-center rounded-lg px-3",
                panel.filter === filter.id ? "bg-primary" : "bg-subtle",
              )}
              onPress={() => props.onFilter(filter.id)}
            >
              <Text
                className={cn(
                  "text-sm",
                  panel.filter === filter.id ? "text-primary-foreground" : "text-foreground",
                )}
              >
                {filter.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <ScrollView
        nestedScrollEnabled
        style={{ maxHeight: props.height }}
        scrollEventThrottle={PLUGIN_ROW_WINDOW.scrollThrottleMs}
        onScroll={({ nativeEvent }) => {
          const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
          const lookahead = PLUGIN_ROW_WINDOW.lookaheadViewports * layoutMeasurement.height;
          if (contentOffset.y + lookahead >= contentSize.height) {
            setRowLimit((limit) => growPluginRowWindow(limit, panel.rows.length));
          }
        }}
      >
        {panel.rows.slice(0, rowLimit).map((row, index) => (
          <PanelRow
            key={row.id}
            separated={index > 0}
            row={row}
            scope={{
              environmentId: props.environmentId,
              target: props.target,
              pluginId: props.pluginId,
              panelId: panel.id,
              rowId: row.id,
            }}
            agent={props.agent}
            nowMs={nowMs}
            onNavigate={props.onNavigate}
            onOpenSurface={props.onOpenSurface}
          />
        ))}
        {panel.rows.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No items.</Text>
        ) : null}
      </ScrollView>
    </>
  );
}

function PanelRow(props: {
  readonly row: PluginPanelRow;
  readonly scope: PluginRowScope;
  readonly separated: boolean;
  readonly agent: PluginAgentControls | undefined;
  readonly nowMs: number;
  readonly onNavigate: ((row: PluginPanelRow) => void) | undefined;
  readonly onOpenSurface: (scope: PluginRowScope, root: PluginSurfaceEntry) => void;
}) {
  const { row, scope, agent } = props;
  const requests = usePluginRequests(scope.environmentId);
  const [busy, setBusy] = useState(false);
  const rowKey = pluginRowKey(scope.pluginId, scope.panelId, row.id);
  const agentActions = agent !== undefined && requests.canOperate;
  const run = agentActions ? agent.stateOf(rowKey) : ({ kind: "idle" } as const);
  const actions = row.actions ?? [];
  const primary = actions.find((action) => action.id === row.primaryActionId);
  const menu = requests.canOperate
    ? pluginRowMenu(actions, {
        primaryActionId: row.primaryActionId,
        agentActions,
        now: new Date(props.nowMs),
      })
    : null;

  const openSurface = async (surfaceId: string) => {
    setBusy(true);
    const surface = await requests.requestSurface(scope, surfaceId).finally(() => setBusy(false));
    if (surface) props.onOpenSurface(scope, { surfaceId, surface });
  };
  const choose = async (action: PluginLeafAction, value?: string | null) => {
    switch (action.kind) {
      case "agent":
        if (agentActions) void agent.start(rowKey, action.prompt);
        return;
      case "surface":
        await openSurface(action.surfaceId);
        return;
      default: {
        setBusy(true);
        const result = await requests.runAction(scope, action, value).finally(() => setBusy(false));
        // From a row, `close` has nothing to close; a returned surface opens as a sheet.
        if (result?.surface) {
          props.onOpenSurface(scope, { surfaceId: undefined, surface: result.surface });
        }
      }
    }
  };
  const customDate = async (action: Extract<PluginLeafAction, { kind: "date" }>) => {
    const date = await requests.askDate(action);
    if (date !== null) void choose(action, date);
  };
  const hoverSurfaceId = row.hoverSurfaceId;
  const openHover = hoverSurfaceId ? () => void openSurface(hoverSurfaceId) : undefined;
  const navigable = props.onNavigate !== undefined && row.navigate !== undefined;

  const body = (
    <View className="min-w-0 flex-1 gap-1">
      <Text selectable={!navigable} className="text-sm text-foreground">
        {row.label}
      </Text>
      {row.detail ? (
        <Text selectable={!navigable} className="text-xs text-foreground-muted">
          {row.detail}
        </Text>
      ) : null}
      <PluginBadges badges={row.badges} />
    </View>
  );

  return (
    <View
      className={cn(
        "flex-row items-center gap-2 py-2",
        props.separated && "border-t border-border-subtle",
      )}
    >
      {navigable || openHover ? (
        <Pressable
          accessibilityRole={navigable ? "button" : undefined}
          accessibilityLabel={row.label}
          accessibilityHint={openHover ? "Long-press for details" : undefined}
          className="min-w-0 flex-1 active:opacity-70"
          onPress={navigable ? () => props.onNavigate?.(row) : undefined}
          onLongPress={openHover}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
      {run.kind === "active" || run.kind === "sending" ? (
        <IconButton
          icon="stop.fill"
          variant="danger"
          accessibilityLabel={`Stop ${row.label}`}
          disabled={run.kind !== "active"}
          onPress={run.kind === "active" ? () => void agent?.stop(run.runId) : undefined}
        />
      ) : null}
      {primary && requests.canOperate && !(primary.kind === "agent" && run.kind !== "idle") ? (
        <PrimaryAction
          action={primary}
          agentActions={agentActions}
          nowMs={props.nowMs}
          busy={busy}
          onChoose={(action, value) => void choose(action, value)}
          onCustomDate={(action) => void customDate(action)}
        />
      ) : null}
      {openHover ? (
        <IconButton
          icon="info.circle"
          accessibilityLabel={`Details for ${row.label}`}
          disabled={busy}
          onPress={openHover}
        />
      ) : null}
      {menu && menu.actions.length > 0 ? (
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${row.label} actions`}
          title={row.label}
          actions={[...menu.actions]}
          onPressAction={({ nativeEvent }) => {
            const selection = menu.resolve(nativeEvent.event);
            if (selection?.kind === "custom-date") void customDate(selection.action);
            else if (selection) void choose(selection.action, selection.value);
          }}
        >
          <ControlPill icon="ellipsis" accessibilityLabel={`${row.label} actions`} />
        </Menu>
      ) : null}
    </View>
  );
}

function PrimaryAction(props: {
  readonly action: PluginAction;
  readonly agentActions: boolean;
  readonly nowMs: number;
  readonly busy: boolean;
  readonly onChoose: (action: PluginLeafAction, value?: string | null) => void;
  readonly onCustomDate: (action: Extract<PluginLeafAction, { kind: "date" }>) => void;
}) {
  const { action } = props;
  switch (action.kind) {
    case "agent":
      return props.agentActions ? (
        <IconButton
          icon="play"
          variant="tonal"
          accessibilityLabel={action.label}
          onPress={() => props.onChoose(action)}
        />
      ) : null;
    case "date":
      return (
        <DateActionMenu
          action={action}
          now={new Date(props.nowMs)}
          disabled={props.busy}
          onChoose={(value) => props.onChoose(action, value)}
          onCustom={() => props.onCustomDate(action)}
        />
      );
    case "menu": {
      const menu = pluginRowMenu(action.items, {
        agentActions: props.agentActions,
        now: new Date(props.nowMs),
      });
      return menu.actions.length ? (
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={action.label}
          title={action.label}
          actions={[...menu.actions]}
          onPressAction={({ nativeEvent }) => {
            const selection = menu.resolve(nativeEvent.event);
            if (selection?.kind === "custom-date") props.onCustomDate(selection.action);
            else if (selection) props.onChoose(selection.action, selection.value);
          }}
        >
          <ControlPill variant="pill" label={action.label} disabled={props.busy} />
        </Menu>
      ) : null;
    }
    default:
      return (
        <Button
          size="compact"
          label={action.label}
          tone={action.kind === "plugin" && action.tone === "danger" ? "danger" : "secondary"}
          disabled={props.busy}
          onPress={() => props.onChoose(action)}
        />
      );
  }
}
