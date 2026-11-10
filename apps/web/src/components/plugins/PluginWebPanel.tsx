import type { EnvironmentId, PluginPanel } from "@t3tools/contracts";
import { usePreparedConnection } from "../../state/session";
import { PluginFrame, pluginFrameAgentSource } from "./PluginSurfaceHost";

export function PluginWebPanel({
  environmentId,
  pluginId,
  panel,
}: {
  environmentId: EnvironmentId;
  pluginId: string;
  panel: Extract<PluginPanel, { kind: "web" }>;
}) {
  const connection = usePreparedConnection(environmentId);
  if (connection._tag === "None") return null;
  const url = new URL(panel.path, connection.value.httpBaseUrl).href;
  return (
    <PluginFrame
      // A new gateway URL is a new grant; the bridge starts over with it.
      key={url}
      src={url}
      title={panel.title}
      height={panel.height ?? 420}
      nodeId={null}
      ownSurfaceId={undefined}
      gatewayUrl={url}
      panelTitle={panel.title}
      agentSource={pluginFrameAgentSource(pluginId, panel.id)}
    />
  );
}
