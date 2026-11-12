// @effect-diagnostics globalDate:off - Plugin dates are local calendar days chosen in the UI, not instants.
import {
  WS_METHODS,
  pluginLinkMatches,
  pluginLinkStem,
  type PluginLink,
  type PluginLinkResolution,
} from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { parseMarkdownFileLink } from "@t3tools/shared/markdownLinks";
import { isAbsolutePath } from "@t3tools/shared/path";
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

/** Declared link patterns of an environment's connected plugins, and their on-demand cards. */
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
    resolve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plugin-links:resolve",
      tag: WS_METHODS.pluginLinksResolve,
    }),
  };
}

/**
 * Where a claimed link leads: the plugin's resolved href, else its template filled in, else the
 * link itself. `{url}` is encoded as one component; `{rest}` keeps its slashes, so a path can
 * follow the pattern's literal start. A result that is not an http(s) URL is ignored.
 */
export function pluginLinkHref(
  link: PluginLink,
  url: string,
  resolution?: PluginLinkResolution,
): string {
  const candidates = [
    resolution?.href,
    link.href
      ?.replaceAll("{url}", encodeURIComponent(url))
      .replaceAll(
        "{rest}",
        encodeURIComponent(url.slice(pluginLinkStem(link).length)).replace(/%2F/gi, "/"),
      ),
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
    } catch {}
  }
  return url;
}

/** The declared pattern claiming `target`; the longest literal start wins when patterns overlap. */
export function matchPluginLink(
  links: ReadonlyArray<PluginLink>,
  target: string,
): PluginLink | undefined {
  let best: PluginLink | undefined;
  for (const link of links) {
    if (
      pluginLinkMatches(link, target) &&
      pluginLinkStem(link).length > (best === undefined ? -1 : pluginLinkStem(best).length)
    )
      best = link;
  }
  return best;
}

/**
 * What plugin link patterns see for a chat href: an http(s) URL as written, or a file link's
 * absolute path, resolved against the workspace when relative. Anything else is never claimed.
 */
export function pluginLinkTarget(
  href: string,
  workspaceRoot: string | null | undefined,
): string | undefined {
  if (/^https?:\/\//i.test(href)) return href;
  const file = parseMarkdownFileLink(href);
  if (file === null) return undefined;
  const path = isAbsolutePath(file.path)
    ? file.path
    : workspaceRoot
      ? resolvePathLinkTarget(file.path, workspaceRoot)
      : undefined;
  if (path === undefined) return undefined;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "..") segments.length > 1 && segments.pop();
    else if (segment !== ".") segments.push(segment);
  }
  return segments.join("/");
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

const RESOLUTION_CACHE_LIMIT = 500;

/**
 * Plugin answers for links declared with `resolve`, kept for the app session so a link is resolved
 * once however often it renders. A failed lookup is remembered as no change, never retried.
 */
export function createPluginLinkResolutions() {
  const values = new Map<string, PluginLinkResolution>();
  const requested = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    /** Changes whenever an answer arrives, for renderers that read many links at once. */
    version: () => version,
    key: (environmentId: string, link: PluginLink, url: string) =>
      JSON.stringify([environmentId, link.pluginId, link.linkId, url]),
    read: (key: string) => values.get(key),
    requested: (key: string) => requested.has(key),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Starts one lookup per key; later calls for the same key do nothing. */
    request(key: string, lookup: () => Promise<PluginLinkResolution | undefined>) {
      if (requested.has(key)) return;
      if (requested.size >= RESOLUTION_CACHE_LIMIT) {
        const oldest = requested.values().next().value;
        if (oldest !== undefined) {
          requested.delete(oldest);
          values.delete(oldest);
        }
      }
      requested.add(key);
      void lookup().then(
        (resolution) => {
          if (!requested.has(key)) return;
          values.set(key, resolution ?? {});
          version += 1;
          for (const listener of listeners) listener();
        },
        () => undefined,
      );
    },
  };
}
export type PluginLinkResolutions = ReturnType<typeof createPluginLinkResolutions>;
