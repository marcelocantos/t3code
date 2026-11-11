import { useAtomValue } from "@effect/atom-react";
import {
  createPluginLinkResolutions,
  matchPluginLink,
  pluginLinkHref,
} from "@t3tools/client-runtime/state/panelPlugins";
import type { EnvironmentId, PluginLink, PluginLinkCard } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { Sheet } from "../../components/ui/Sheet";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { pluginFailureMessage, pluginLinks } from "./pluginAtoms";
import { PluginBridgeHost, PluginBridgeWebView } from "./PluginBridge";
import { SurfaceBlock } from "./PluginSurfaceSheet";

const WEB_CARD_HEIGHT = 240;

const resolutions = createPluginLinkResolutions();

/**
 * Plugins' claims on chat links: which plugin owns an href, where it should lead, and the text it
 * names a bare URL with. Lookups for links declared with `resolve` start on first use and
 * re-render the caller when they land.
 */
export function usePluginLinkTakeover(environmentId: EnvironmentId) {
  const result = useAtomValue(pluginLinks.links({ environmentId, input: {} }));
  const links = result._tag === "Success" ? result.value : [];
  const resolve = useAtomCommand(pluginLinks.resolve, { reportFailure: false });
  useSyncExternalStore(resolutions.subscribe, resolutions.version);
  const resolutionFor = (link: PluginLink, url: string) => {
    if (link.resolve !== true) return undefined;
    const key = resolutions.key(environmentId, link, url);
    // Deferred so a render only reads; the lookup runs once per link for the session.
    if (!resolutions.requested(key))
      setTimeout(() =>
        resolutions.request(key, () =>
          resolve({
            environmentId,
            input: { pluginId: link.pluginId, linkId: link.linkId, url },
          }).then((answer) => (answer._tag === "Success" ? answer.value : undefined)),
        ),
      );
    return resolutions.read(key);
  };
  const match = (href: string) => matchPluginLink(links, href);
  return {
    match,
    hrefFor: (link: PluginLink, url: string) => pluginLinkHref(link, url, resolutionFor(link, url)),
    textFor: (href: string) => {
      const link = match(href);
      return link === undefined ? undefined : resolutionFor(link, href)?.text;
    },
  };
}

/**
 * Touch has no hover, so tapping a link a plugin claims shows its card first, with the link one
 * tap away. Cards are read-only: no row stands behind a link.
 */
export function PluginLinkCardSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly link: PluginLink;
  readonly url: string;
  readonly onOpenLink: () => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const fetchCard = useAtomCommand(pluginLinks.card, { reportFailure: false });
  const [card, setCard] = useState<PluginLinkCard | { readonly error: string } | null>(null);
  const { environmentId, link, url } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the card from the plugin when the sheet opens
  useEffect(() => {
    let live = true;
    void fetchCard({
      environmentId,
      input: { pluginId: link.pluginId, linkId: link.linkId, url },
    }).then((result) => {
      if (!live) return;
      setCard(
        result._tag === "Success" ? result.value : { error: pluginFailureMessage(result.cause) },
      );
    });
    return () => {
      live = false;
    };
  }, [fetchCard, environmentId, link.pluginId, link.linkId, url]);
  const readOnly = () => Dialog.alert("Not available here", "Link cards are read-only.");
  const title = card !== null && "surface" in card ? card.surface.title : url;

  return (
    <Sheet title={title} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(20, insets.bottom) }}
      >
        {card === null ? (
          <Text className="text-sm text-foreground-muted">Loading…</Text>
        ) : "error" in card ? (
          <Text className="text-sm text-foreground-muted">{card.error}</Text>
        ) : "surface" in card ? (
          card.surface.blocks.map((block, index) => (
            <SurfaceBlock
              // oxlint-disable-next-line react/no-array-index-key -- surface blocks carry no ids
              key={index}
              block={block}
              nowMs={0}
              busy={false}
              canOperate={false}
              onOpenItem={readOnly}
              onAction={readOnly}
              onCustomDate={readOnly}
              onSubmit={readOnly}
            />
          ))
        ) : (
          <WebCard environmentId={environmentId} card={card} />
        )}
        <View className="flex-row">
          <Button label="Open link" tone="primary" size="compact" onPress={props.onOpenLink} />
        </View>
      </ScrollView>
    </Sheet>
  );
}

function WebCard(props: {
  readonly environmentId: EnvironmentId;
  readonly card: Extract<PluginLinkCard, { webUrl: string }>;
}) {
  const connection = usePreparedConnection(props.environmentId);
  if (connection._tag === "None") return null;
  const src = new URL(props.card.webUrl, connection.value.httpBaseUrl).href;
  return (
    <PluginBridgeHost environmentId={props.environmentId} agent={undefined}>
      <PluginBridgeWebView
        src={src}
        height={props.card.height ?? WEB_CARD_HEIGHT}
        nodeId={null}
        ownSurfaceId={undefined}
        gatewayUrl={src}
        panelTitle="Link card"
        agentKey="link-card"
      />
    </PluginBridgeHost>
  );
}
