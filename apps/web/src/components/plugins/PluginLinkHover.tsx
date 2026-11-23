import {
  createPluginLinkResolutions,
  matchPluginLink,
  pluginLinkHref,
} from "@t3tools/client-runtime/state/panelPlugins";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginLink } from "@t3tools/contracts";
import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PluginSurfaceHost, usePluginSurfaceHost } from "./PluginSurfaceHost";
import { pluginLinks } from "./pluginState";

const HOVER_OPEN_MS = 350;
const resolutions = createPluginLinkResolutions();

/**
 * How a plugin that claims `url` (an http(s) URL, or a file link's absolute path) rewrites it:
 * where it leads, and the text to show in place of the bare link. Undefined when unclaimed.
 */
export function usePluginLinkTakeover(
  environmentId: EnvironmentId | null,
  url: string | undefined,
) {
  const query = useEnvironmentQuery(
    environmentId === null || !url ? null : pluginLinks.links({ environmentId, input: {} }),
  );
  const resolve = useAtomCommand(pluginLinks.resolve, { reportFailure: false });
  const link = url && query.data ? matchPluginLink(query.data, url) : undefined;
  const key =
    link?.resolve === true && environmentId !== null && url
      ? resolutions.key(environmentId, link, url)
      : null;
  const resolution = useSyncExternalStore(resolutions.subscribe, () =>
    key === null ? undefined : resolutions.read(key),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the plugin once per distinct link; the answer lands in a shared store
  useEffect(() => {
    if (key === null || link === undefined || environmentId === null || !url) return;
    resolutions.request(key, () =>
      resolve({
        environmentId,
        input: { pluginId: link.pluginId, linkId: link.linkId, url },
      }).then((result) => (result._tag === "Success" ? result.value : undefined)),
    );
  }, [key, link, environmentId, url, resolve]);
  if (link === undefined || !url) return undefined;
  return { link, href: pluginLinkHref(link, url, resolution), text: resolution?.text };
}

/**
 * A chat link a plugin's pattern claims gets that plugin's card on hover or focus, and on click
 * when the plugin takes the click over; any other link renders `children` unchanged. Cards are
 * fetched when shown, never on render. `href` is the link as written.
 */
export function PluginLinkHover(props: {
  environmentId: EnvironmentId | null;
  href: string;
  /** The bare link, shown with the card in place of `children`. */
  link: ReactNode;
  /** Whether this client runs on the environment's machine, for plugins that take clicks over. */
  local: boolean;
  children: ReactNode;
}) {
  const query = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : pluginLinks.links({ environmentId: props.environmentId, input: {} }),
  );
  const match = query.data ? matchPluginLink(query.data, props.href) : undefined;
  if (props.environmentId === null || match === undefined) return props.children;
  return (
    <PluginSurfaceHost>
      <LinkCardTrigger
        environmentId={props.environmentId}
        link={match}
        url={props.href}
        local={props.local}
      >
        {match.card === false ? props.children : props.link}
      </LinkCardTrigger>
    </PluginSurfaceHost>
  );
}

/**
 * A file chip whose absolute `path` a plugin's pattern claims: the plugin's card on hover, and a
 * plain click shows the card or, when the plugin rewrote the link, opens where it now leads.
 */
export function PluginFileLink(props: {
  environmentId: EnvironmentId | null;
  path: string;
  local: boolean;
  children: ReactNode;
}) {
  const takeover = usePluginLinkTakeover(props.environmentId, props.path);
  if (props.environmentId === null || takeover === undefined) return props.children;
  return (
    <PluginSurfaceHost>
      <LinkCardTrigger
        environmentId={props.environmentId}
        link={takeover.link}
        url={props.path}
        local={props.local}
        {...(takeover.href !== props.path ? { openHref: takeover.href } : {})}
      >
        {props.children}
      </LinkCardTrigger>
    </PluginSurfaceHost>
  );
}

function LinkCardTrigger(props: {
  environmentId: EnvironmentId;
  link: PluginLink;
  url: string;
  local: boolean;
  /** Where a plain click goes instead, for links whose own click cannot be rewritten. */
  openHref?: string;
  children: ReactNode;
}) {
  const host = usePluginSurfaceHost();
  const transientKey = useId();
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activate = useAtomCommand(pluginLinks.activate, { reportFailure: false });
  const canActivate = useAtomValue(pluginLinks.activate.permissionAtom(props.environmentId));
  const takesClick = props.link.click === "activate" && canActivate;
  const activation = useRef<"idle" | "asking" | "replaying">("idle");
  /** Asks the plugin; when it declines, fails or is gone, replays the click as an unclaimed one. */
  const askPlugin = async (target: HTMLElement) => {
    activation.current = "asking";
    const result = await activate({
      environmentId: props.environmentId,
      input: {
        pluginId: props.link.pluginId,
        linkId: props.link.linkId,
        url: props.url,
        client: { local: props.local },
      },
    });
    activation.current = "idle";
    if ((result._tag === "Success" && result.value.handled) || !target.isConnected) return;
    activation.current = "replaying";
    target.click();
    activation.current = "idle";
  };
  const cancelOpen = () => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a pending hover timer must not fire after the link unmounts
  useEffect(
    () => () => {
      if (openTimer.current !== null) clearTimeout(openTimer.current);
    },
    [],
  );
  const hasCard = props.link.card !== false;
  const show = (anchor: Element) => {
    cancelOpen();
    if (!anchor.isConnected || !hasCard) return;
    host.showLinkCard({
      environmentId: props.environmentId,
      link: props.link,
      url: props.url,
      anchor,
      transientKey,
    });
  };
  const leave = () => {
    cancelOpen();
    host.scheduleHoverClose(transientKey);
  };
  return (
    <span
      data-plugin-link={props.link.pluginId}
      onClickCapture={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (takesClick && activation.current !== "replaying") {
          event.preventDefault();
          event.stopPropagation();
          cancelOpen();
          if (activation.current === "idle")
            void askPlugin(
              event.target instanceof HTMLElement ? event.target : event.currentTarget,
            );
          return;
        }
        if (props.link.click !== "card" || !hasCard) {
          if (props.openHref === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          window.open(props.openHref, "_blank", "noopener,noreferrer");
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        cancelOpen();
        host.openLinkCardDialog({
          environmentId: props.environmentId,
          link: props.link,
          url: props.url,
        });
      }}
      onPointerEnter={() => host.cancelHoverClose(transientKey)}
      // Scrolling under a still pointer sends enter but no move, so only a move opens a card.
      onPointerMove={(event) => {
        if (openTimer.current !== null) return;
        const anchor = event.currentTarget;
        openTimer.current = setTimeout(() => show(anchor), HOVER_OPEN_MS);
      }}
      onPointerLeave={leave}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={leave}
    >
      {props.children}
    </span>
  );
}
