import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PluginAction,
  PluginPanel,
  PluginPanelRow,
  PluginPanelSnapshot,
  PluginPanelTarget,
  SubscribePluginPanelsInput,
} from "@t3tools/contracts";
import { EllipsisIcon, PlayIcon, SquareIcon } from "lucide-react";
import {
  use,
  useRef,
  useState,
  type ComponentType,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  PluginActionMenuItems,
  PluginBadges,
  PluginCustomDateDialog,
  PluginDateMenuItems,
} from "./PluginActionControls";
import { pluginPanelCommands, usePluginPanelHeight } from "./pluginState";
import {
  PluginAgentContext,
  pluginFrameAgentSource,
  pluginRowAgentSource,
  usePluginSurfaceHost,
  type PluginRowOrigin,
  type PluginSide,
} from "./PluginSurfaceHost";
import { PluginWebPanel } from "./PluginWebPanel";

const HOVER_OPEN_MS = 350;
type Filters = SubscribePluginPanelsInput["filters"];
type DateAction = Extract<PluginAction, { kind: "date" }>;
type LeafAction = Exclude<PluginAction, { kind: "menu" }>;

export interface PluginSectionProps {
  headingId: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Every connected plugin's panels for one subscription, thread or environment. The caller picks the
 * section chrome and which way hover cards open, away from the sidebar the panels sit in.
 */
export function PluginPanels(props: {
  environmentId: EnvironmentId;
  target: PluginPanelTarget;
  snapshots: ReadonlyArray<PluginPanelSnapshot> | null;
  error: string | null;
  onFilter: (next: (current: Filters) => Filters) => void;
  Section: ComponentType<PluginSectionProps>;
  hoverSide: PluginSide;
  defaultHeight: number;
  onNavigate?: (row: PluginPanelRow, anchor: Element) => void;
}) {
  const { Section } = props;
  return (
    <>
      {props.error ? (
        <p role="alert" className="px-4 text-xs text-muted-foreground">
          Plugin panels unavailable: {props.error}
        </p>
      ) : null}
      {props.snapshots?.map((plugin) =>
        plugin.status !== "connected" ? (
          <Section
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
          </Section>
        ) : (
          plugin.panels.map((panel) => (
            <Section
              key={`${plugin.pluginId}:${panel.id}`}
              headingId={`plugin-${plugin.pluginId}-${panel.id}`}
              title={panel.title}
              actions={
                panel.kind !== "web" && panel.filters.length > 0 ? (
                  <select
                    aria-label={`${panel.title} filter`}
                    className="max-w-32 rounded border border-border bg-background text-xs"
                    value={panel.filter}
                    onChange={(event) => {
                      const filter = event.target.value;
                      props.onFilter((current) => [
                        ...current.filter(
                          (item) => item.pluginId !== plugin.pluginId || item.panelId !== panel.id,
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
              <SizedPanel
                pluginId={plugin.pluginId}
                panelId={panel.id}
                title={panel.title}
                defaultHeight={props.defaultHeight}
              >
                {panel.kind === "web" ? (
                  <PluginWebPanel
                    environmentId={props.environmentId}
                    pluginId={plugin.pluginId}
                    panel={panel}
                  />
                ) : (
                  <PluginNativeList
                    environmentId={props.environmentId}
                    target={props.target}
                    pluginId={plugin.pluginId}
                    panel={panel}
                    hoverSide={props.hoverSide}
                    {...(props.onNavigate === undefined ? {} : { onNavigate: props.onNavigate })}
                  />
                )}
              </SizedPanel>
            </Section>
          ))
        ),
      )}
    </>
  );
}

function SizedPanel(props: {
  pluginId: string;
  panelId: string;
  title: string;
  defaultHeight: number;
  children: ReactNode;
}) {
  const [height, setHeight] = usePluginPanelHeight(
    props.pluginId,
    props.panelId,
    props.defaultHeight,
  );
  return (
    <div>
      <div
        role="region"
        aria-label={`${props.title} content`}
        tabIndex={0}
        className="overflow-auto overscroll-contain"
        style={{ height, maxHeight: "60vh", minHeight: 120, overflow: "auto" }}
      >
        {props.children}
      </div>
      <label className="flex items-center gap-2 px-2.5 pt-2 text-xs text-muted-foreground">
        Height
        <input
          type="range"
          aria-label={`${props.title} panel height`}
          min={120}
          max={800}
          step={20}
          value={height}
          onChange={(event) => setHeight(Number(event.target.value))}
          className="min-w-0 flex-1"
        />
      </label>
    </div>
  );
}

type NativePanel = Exclude<PluginPanel, { kind: "web" }>;

function PluginNativeList(props: {
  environmentId: EnvironmentId;
  target: PluginPanelTarget;
  pluginId: string;
  panel: NativePanel;
  hoverSide: PluginSide;
  onNavigate?: (row: PluginPanelRow, anchor: Element) => void;
}) {
  const canOperate = useAtomValue(pluginPanelCommands.act.permissionAtom(props.environmentId));
  const agent = use(PluginAgentContext);
  const { panel } = props;
  // Read-only clients keep surfaces, which change nothing; agent actions need a thread.
  const allowed = (action: PluginAction): boolean =>
    action.kind === "surface" || (canOperate && (action.kind !== "agent" || agent !== null));
  if (panel.rows.length === 0) {
    return <p className="px-2.5 text-xs text-muted-foreground">No items.</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5 px-1 text-xs">
      {panel.rows.map((row) => (
        <PluginRow
          key={row.id}
          row={row}
          origin={{
            row: {
              environmentId: props.environmentId,
              target: props.target,
              pluginId: props.pluginId,
              panelId: panel.id,
              rowId: row.id,
            },
            panelTitle: panel.title,
            agentSource: pluginFrameAgentSource(props.pluginId, panel.id),
            side: props.hoverSide,
          }}
          panelKey={`${props.pluginId}/${panel.id}`}
          allowed={allowed}
          {...(props.onNavigate === undefined || row.navigate === undefined
            ? {}
            : { onNavigate: props.onNavigate })}
        />
      ))}
    </ul>
  );
}

function filterActions(
  actions: ReadonlyArray<PluginAction>,
  allowed: (action: PluginAction) => boolean,
): ReadonlyArray<PluginAction> {
  return actions.flatMap((action): ReadonlyArray<PluginAction> => {
    if (action.kind !== "menu") return allowed(action) ? [action] : [];
    const items = action.items.filter(allowed);
    return items.length === 0 ? [] : [{ ...action, items }];
  });
}

type AgentAction = Extract<PluginAction, { kind: "agent" }>;
function agentActionsOf(actions: ReadonlyArray<PluginAction>): ReadonlyArray<AgentAction> {
  return actions.flatMap((action): ReadonlyArray<AgentAction> => {
    if (action.kind === "agent") return [action];
    if (action.kind !== "menu") return [];
    return action.items.flatMap((item) => (item.kind === "agent" ? [item] : []));
  });
}

function PluginRow(props: {
  row: PluginPanelRow;
  origin: PluginRowOrigin;
  panelKey: string;
  allowed: (action: PluginAction) => boolean;
  onNavigate?: (row: PluginPanelRow, anchor: Element) => void;
}) {
  const { row, origin } = props;
  const host = usePluginSurfaceHost();
  const agent = use(PluginAgentContext);
  const [menuOpen, setMenuOpen] = useState(false);
  const [customDate, setCustomDate] = useState<DateAction | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actions = filterActions(row.actions ?? [], props.allowed);
  const primary = actions.find((action) => action.id === row.primaryActionId);
  const others = actions.filter((action) => action !== primary);
  const running = agentActionsOf(actions).find((action) =>
    agent?.runningSources.has(pluginRowAgentSource(origin.row, action.id)),
  );
  const run = (action: LeafAction, value?: string | null, anchor: Element | null = null) =>
    void host.runAction(origin, action, value, anchor);
  const { hoverSurfaceId } = row;

  const cancelHoverOpen = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const showHover = (anchor: Element) => {
    cancelHoverOpen();
    if (hoverSurfaceId === undefined || !anchor.isConnected) return;
    host.showHover({ ...origin, surfaceId: hoverSurfaceId, anchor, panelKey: props.panelKey });
  };
  const hoverHandlers =
    hoverSurfaceId === undefined
      ? {}
      : {
          onPointerEnter: (event: PointerEvent<HTMLLIElement>) => {
            const anchor = event.currentTarget;
            host.cancelHoverClose(props.panelKey);
            cancelHoverOpen();
            hoverTimer.current = setTimeout(() => showHover(anchor), HOVER_OPEN_MS);
          },
          onPointerLeave: () => {
            cancelHoverOpen();
            host.scheduleHoverClose(props.panelKey);
          },
        };

  const body = (
    <>
      <span className="block break-words text-foreground">{row.label}</span>
      {row.detail ? (
        <span className="mt-0.5 block whitespace-pre-wrap break-words text-muted-foreground">
          {row.detail}
        </span>
      ) : null}
      {row.badges && row.badges.length > 0 ? (
        <span className="mt-1 block">
          <PluginBadges badges={row.badges} />
        </span>
      ) : null}
    </>
  );
  const focusHandlers =
    hoverSurfaceId === undefined
      ? {}
      : {
          onFocus: (event: FocusEvent<HTMLElement>) => {
            const anchor = event.currentTarget.closest("li");
            if (anchor !== null) showHover(anchor);
          },
          onBlur: () => host.scheduleHoverClose(props.panelKey),
        };
  const { onNavigate } = props;

  return (
    <li
      className="flex min-w-0 items-start gap-1 rounded-md px-1.5 py-1 hover:bg-accent/40"
      data-plugin-row={row.id}
      onContextMenu={
        others.length === 0
          ? undefined
          : (event) => {
              event.preventDefault();
              setMenuOpen(true);
            }
      }
      {...hoverHandlers}
    >
      {onNavigate === undefined ? (
        <div
          className="min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          tabIndex={hoverSurfaceId === undefined ? undefined : 0}
          {...focusHandlers}
        >
          {body}
        </div>
      ) : (
        <button
          type="button"
          className="min-w-0 flex-1 cursor-pointer rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={(event) => onNavigate(row, event.currentTarget)}
          {...focusHandlers}
        >
          {body}
        </button>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        {running === undefined ? null : (
          <Button
            size="xs"
            variant="outline"
            aria-label={`Stop ${running.label}`}
            onClick={() => {
              void agent?.stop(pluginRowAgentSource(origin.row, running.id));
            }}
          >
            <SquareIcon />
            Stop
          </Button>
        )}
        {primary === undefined || primary === running ? null : (
          <PrimaryAction action={primary} run={run} onCustomDate={setCustomDate} />
        )}
        {others.length === 0 ? null : (
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`More actions for ${row.label}`}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <PluginActionMenuItems actions={others} run={run} onCustomDate={setCustomDate} />
            </MenuPopup>
          </Menu>
        )}
      </div>
      <PluginCustomDateDialog
        action={customDate}
        onClose={() => setCustomDate(null)}
        onChoose={(value) => {
          if (customDate !== null) run(customDate, value);
        }}
      />
    </li>
  );
}

function PrimaryAction({
  action,
  run,
  onCustomDate,
}: {
  action: PluginAction;
  run: (action: LeafAction, value?: string | null, anchor?: Element | null) => void;
  onCustomDate: (action: DateAction) => void;
}) {
  if (action.kind === "date" || action.kind === "menu") {
    return (
      <Menu>
        <MenuTrigger render={<Button size="xs" variant="outline" />}>{action.label}</MenuTrigger>
        <MenuPopup align="end">
          {action.kind === "date" ? (
            <PluginDateMenuItems
              action={action}
              onChoose={(value) => run(action, value)}
              onCustom={() => onCustomDate(action)}
            />
          ) : (
            <PluginActionMenuItems actions={action.items} run={run} onCustomDate={onCustomDate} />
          )}
        </MenuPopup>
      </Menu>
    );
  }
  return (
    <Button
      size="xs"
      variant={
        action.kind === "plugin" && action.tone === "danger" ? "destructive-outline" : "outline"
      }
      onClick={(event) => run(action, undefined, event.currentTarget)}
    >
      {action.kind === "agent" ? <PlayIcon /> : null}
      {action.label}
    </Button>
  );
}
