import type { MenuAction } from "@react-native-menu/menu";
import {
  formatCalendarDate,
  fromCalendarDate,
  pluginDateChoices,
  toCalendarDate,
} from "@t3tools/client-runtime/state/panelPlugins";
import type {
  MessageId,
  OrchestrationV2RunStatus,
  PluginAction,
  PluginLeafAction,
  RunId,
} from "@t3tools/contracts";

type DateAction = Extract<PluginLeafAction, { kind: "date" }>;

/** What choosing a `…` menu entry does: run an action (with a date value), or ask for a date. */
export type PluginRowSelection =
  | { readonly kind: "run"; readonly action: PluginLeafAction; readonly value?: string | null }
  | { readonly kind: "custom-date"; readonly action: DateAction };

export interface PluginRowMenu {
  readonly actions: ReadonlyArray<MenuAction>;
  readonly resolve: (id: string) => PluginRowSelection | undefined;
}

/**
 * The row's `…` menu: every action but the primary one, `menu` actions as submenus and `date`
 * actions as their shortcuts, a custom date and, when set, a clear choice. Agent actions are left
 * out where the client cannot submit them (environment panels, read-only clients).
 */
export function pluginRowMenu(
  actions: ReadonlyArray<PluginAction>,
  options: {
    readonly primaryActionId?: string | undefined;
    readonly agentActions: boolean;
    readonly now: Date;
    readonly locale?: string;
  },
): PluginRowMenu {
  const selections = new Map<string, PluginRowSelection>();
  const add = (selection: PluginRowSelection) => {
    const id = `entry-${selections.size}`;
    selections.set(id, selection);
    return id;
  };
  const choices = pluginDateChoices(options.now, options.locale);
  const leaf = (action: PluginLeafAction): MenuAction | null => {
    switch (action.kind) {
      case "agent":
        return options.agentActions
          ? { id: add({ kind: "run", action }), title: action.label }
          : null;
      case "plugin":
        return {
          id: add({ kind: "run", action }),
          title: action.label,
          ...(action.tone === "danger" ? { attributes: { destructive: true } } : {}),
        };
      case "surface":
        return { id: add({ kind: "run", action }), title: action.label };
      case "date":
        return {
          id: `date-${action.id}`,
          title: action.label,
          ...(action.value === undefined
            ? {}
            : { subtitle: formatCalendarDate(action.value, options.locale) }),
          subactions: [
            ...choices.map((choice) => ({
              id: add({ kind: "run", action, value: choice.value }),
              title: choice.label,
              subtitle: choice.hint,
              ...(choice.value === action.value ? { state: "on" as const } : {}),
            })),
            { id: add({ kind: "custom-date", action }), title: "Custom…" },
            ...(action.value === undefined
              ? []
              : [
                  {
                    id: add({ kind: "run", action, value: null }),
                    title: action.clearLabel ?? "Clear",
                    attributes: { destructive: true },
                  },
                ]),
          ],
        };
    }
  };
  const menu = actions.flatMap((action): MenuAction[] => {
    if (action.id === options.primaryActionId) return [];
    if (action.kind !== "menu") {
      const entry = leaf(action);
      return entry ? [entry] : [];
    }
    const subactions = action.items.flatMap((item) => {
      const entry = leaf(item);
      return entry ? [entry] : [];
    });
    return subactions.length ? [{ id: `menu-${action.id}`, title: action.label, subactions }] : [];
  });
  return { actions: menu, resolve: (id) => selections.get(id) };
}

/** A typed `YYYY-MM-DD` that names a real calendar date, or null. */
export function parsePluginCalendarDate(text: string): string | null {
  const value = text.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return toCalendarDate(fromCalendarDate(value)) === value ? value : null;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Where a row's agent prompt is: still in this device's outbox, running (Stop interrupts it), or
 * done. A run belongs to the prompt when the run's user message is the one the row sent.
 */
export function pluginAgentRunState(input: {
  readonly messageId: MessageId | undefined;
  readonly queuedMessageIds: ReadonlySet<MessageId>;
  readonly runs: ReadonlyArray<{
    readonly id: RunId;
    readonly userMessageId: MessageId;
    readonly status: OrchestrationV2RunStatus;
  }>;
}):
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "active"; readonly runId: RunId } {
  if (input.messageId === undefined) return { kind: "idle" };
  const run = input.runs.find((candidate) => candidate.userMessageId === input.messageId);
  if (run !== undefined) {
    return ACTIVE_RUN_STATUSES.has(run.status)
      ? { kind: "active", runId: run.id }
      : { kind: "idle" };
  }
  return input.queuedMessageIds.has(input.messageId) ? { kind: "sending" } : { kind: "idle" };
}

export const PLUGIN_PANEL_HEIGHT = { default: 320, min: 160, max: 960, step: 80 } as const;

/** Rows mounted per list panel. Each row hosts native controls, which on Android are Compose views. */
export const PLUGIN_ROW_WINDOW = {
  initial: 20,
  step: 20,
  /** Grow while the end of the mounted rows is within this many viewports. */
  lookaheadViewports: 2,
  scrollThrottleMs: 100,
} as const;

/** The next number of rows to mount once scrolling nears the end of the mounted ones. */
export function growPluginRowWindow(limit: number, total: number): number {
  return Math.min(total, Math.max(PLUGIN_ROW_WINDOW.initial, limit + PLUGIN_ROW_WINDOW.step));
}

/** A stored panel height, snapped into the range the stepper offers. */
export function pluginPanelHeight(stored: number | undefined, fallback: number): number {
  const value = typeof stored === "number" && Number.isFinite(stored) ? stored : fallback;
  return Math.min(PLUGIN_PANEL_HEIGHT.max, Math.max(PLUGIN_PANEL_HEIGHT.min, Math.round(value)));
}
