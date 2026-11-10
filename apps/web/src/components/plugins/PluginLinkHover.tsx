import { matchPluginLink } from "@t3tools/client-runtime/state/panelPlugins";
import type { EnvironmentId, PluginLink } from "@t3tools/contracts";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { PluginSurfaceHost, usePluginSurfaceHost } from "./PluginSurfaceHost";
import { pluginLinks } from "./pluginState";

const HOVER_OPEN_MS = 350;

/**
 * A chat link whose URL starts with a prefix a plugin declared gets that plugin's card on hover or
 * focus; any other link renders `children` unchanged. Cards are fetched on hover, never on render.
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
