import type { EnvironmentId, PluginPanel } from "@t3tools/contracts";
import { usePreparedConnection } from "../../state/session";
import { PluginBridgeWebView } from "./PluginBridge";

export function PluginWebPanel({
  environmentId,
  panel,
  height,
  agentKey,
}: {
  environmentId: EnvironmentId;
  panel: Extract<PluginPanel, { kind: "web" }>;
  height: number;
  agentKey: string;
}) {
  const connection = usePreparedConnection(environmentId);
  if (connection._tag === "None") return null;
  const url = new URL(panel.path, connection.value.httpBaseUrl).href;
  return (
    <PluginBridgeWebView
      key={url}
      src={url}
      height={height}
      nodeId={null}
      ownSurfaceId={undefined}
      gatewayUrl={url}
      panelTitle={panel.title}
      agentKey={agentKey}
    />
  );
}
