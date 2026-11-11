import {
  createPluginLinkResolutions,
  matchPluginLink,
  pluginLinkHref,
} from "@t3tools/client-runtime/state/panelPlugins";
import type { EnvironmentId, PluginLink } from "@t3tools/contracts";
import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PluginSurfaceHost, usePluginSurfaceHost } from "./PluginSurfaceHost";
import { pluginLinks } from "./pluginState";

const HOVER_OPEN_MS = 350;
const resolutions = createPluginLinkResolutions();

/**
 * How a plugin that claims `url` rewrites it: where it leads, and the text to show in place of
 * the bare URL. Undefined when no plugin claims the link.
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
 * A chat link whose URL starts with a prefix a plugin declared gets that plugin's card on hover or
 * focus, and on click when the plugin takes the click over; any other link renders `children`
 * unchanged. Cards are fetched when shown, never on render. `href` is the link as written.
 */
export function PluginLinkHover(props: {
  environmentId: EnvironmentId | null;
  href: string;
  /** The bare link, shown with the card in place of `children`. */
  link: ReactNode;
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
      <LinkCardTrigger environmentId={props.environmentId} link={match} url={props.href}>
        {props.link}
      </LinkCardTrigger>
    </PluginSurfaceHost>
  );
}

function LinkCardTrigger(props: {
  environmentId: EnvironmentId;
  link: PluginLink;
  url: string;
  children: ReactNode;
}) {
  const host = usePluginSurfaceHost();
  const transientKey = useId();
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const show = (anchor: Element) => {
    cancelOpen();
    if (!anchor.isConnected) return;
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
        if (props.link.click !== "card") return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        event.stopPropagation();
        cancelOpen();
        host.openLinkCardDialog({
          environmentId: props.environmentId,
          link: props.link,
          url: props.url,
        });
      }}
      onPointerEnter={(event) => {
        const anchor = event.currentTarget;
        host.cancelHoverClose(transientKey);
        cancelOpen();
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
