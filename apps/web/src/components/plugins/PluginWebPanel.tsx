import type { EnvironmentId, PluginPanel } from "@t3tools/contracts";
import { usePreparedConnection } from "../../state/session";

export function PluginWebPanel({
  environmentId,
  panel,
}: {
  environmentId: EnvironmentId;
  panel: Extract<PluginPanel, { kind: "web" }>;
}) {
  const connection = usePreparedConnection(environmentId);
  if (connection._tag === "None") return null;
  const url = new URL(panel.path, connection.value.httpBaseUrl).href;
  return (
    <iframe
      title={panel.title}
      src={url}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      className="w-full border-0"
      style={{ height: panel.height ?? 420 }}
    />
  );
}
