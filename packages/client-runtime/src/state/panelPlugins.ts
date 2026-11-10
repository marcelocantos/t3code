// @effect-diagnostics globalDate:off - Plugin dates are local calendar days chosen in the UI, not instants.
import { WS_METHODS, type PluginLink } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createPanelPluginAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:plugin-panels",
    tag: WS_METHODS.subscribePluginPanels,
    idleTtlMs: 0,
  });
}

export function createEnvironmentPanelPluginAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:environment-plugin-panels",
    tag: WS_METHODS.subscribeEnvironmentPluginPanels,
    idleTtlMs: 0,
  });
}

/** Row and surface actions, and on-demand surfaces (hovercards, dialogs). */
export function createPanelPluginCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    act: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugin-panels:act",
      tag: WS_METHODS.pluginPanelsAct,
    }),
    surface: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugin-panels:surface",
      tag: WS_METHODS.pluginPanelsSurface,
    }),
  };
}

/** Declared link prefixes of an environment's connected plugins, and their on-demand cards. */
export function createPluginLinkAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    links: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plugin-links",
      tag: WS_METHODS.subscribePluginLinks,
      idleTtlMs: 0,
    }),
    card: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugin-links:card",
      tag: WS_METHODS.pluginLinksCard,
    }),
  };
}

/** The declared prefix `href` starts with; the longest wins when prefixes nest. */
export function matchPluginLink(
  links: ReadonlyArray<PluginLink>,
  href: string,
): PluginLink | undefined {
  let best: PluginLink | undefined;
  for (const link of links) {
    if (href.startsWith(link.prefix) && link.prefix.length > (best?.prefix.length ?? -1))
      best = link;
  }
  return best;
}

export interface PluginDateChoice {
  readonly id: "tomorrow" | "day-after" | "next-week";
  /** "Tomorrow", the weekday name of the day after tomorrow, or "Next week". */
  readonly label: string;
  /** The resolved date, shown beside the label, e.g. "Mon 16 Nov". */
  readonly hint: string;
  readonly value: string;
}

const pad = (value: number) => String(value).padStart(2, "0");
/** A local calendar date as `YYYY-MM-DD`; never routed through UTC, so it cannot shift a day. */
export const toCalendarDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const fromCalendarDate = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
};
const addDays = (date: Date, days: number) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

export function formatCalendarDate(value: string, locale?: string): string {
  return fromCalendarDate(value).toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * Date shortcuts for a plugin date action, resolved in the user's local calendar. "Next week" is
 * the coming Monday; on a Sunday that is tomorrow's date, which is still what people mean by it.
 */
export function pluginDateChoices(now: Date, locale?: string): ReadonlyArray<PluginDateChoice> {
  const tomorrow = addDays(now, 1);
  const dayAfter = addDays(now, 2);
  const daysToMonday = (8 - now.getDay()) % 7 || 7;
  const nextWeek = addDays(now, daysToMonday);
  const choice = (id: PluginDateChoice["id"], label: string, date: Date): PluginDateChoice => {
    const value = toCalendarDate(date);
    return { id, label, value, hint: formatCalendarDate(value, locale) };
  };
  return [
    choice("tomorrow", "Tomorrow", tomorrow),
    choice("day-after", dayAfter.toLocaleDateString(locale, { weekday: "long" }), dayAfter),
    choice("next-week", "Next week", nextWeek),
  ];
}
