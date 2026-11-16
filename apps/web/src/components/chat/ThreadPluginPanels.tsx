import { useState } from "react";
import type {
  EnvironmentId,
  PluginPanelSnapshot,
  SubscribePluginPanelsInput,
  ThreadId,
} from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { usePluginThreadAgent } from "../plugins/pluginAgent";
import { PluginPanels } from "../plugins/PluginPanels";
import { threadPluginPanels } from "../plugins/pluginState";
import { PluginAgentContext, PluginSurfaceHost } from "../plugins/PluginSurfaceHost";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

type Filters = SubscribePluginPanelsInput["filters"];

/**
 * The thread's plugin panels subscription. The details card owns it because panels can replace
 * built-in items. Filters reset when the thread changes.
 */
export function useThreadPluginPanels(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  enabled: boolean,
) {
  const key = `${environmentId}:${threadId}`;
  const [selected, setSelected] = useState<{ key: string; filters: Filters }>({ key, filters: [] });
  const filters = selected.key === key ? selected.filters : [];
  const query = useEnvironmentQuery(
    enabled ? threadPluginPanels({ environmentId, input: { threadId, filters } }) : null,
  );
  return {
    snapshots: query.data,
    error: query.error,
    onFilter: (next: (current: Filters) => Filters) =>
      setSelected((current) => ({
        key,
        filters: next(current.key === key ? current.filters : []),
      })),
  };
}

/** Keyed by thread, so every surface a panel opened closes on a switch. */
export function ThreadPluginPanels(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  snapshots: ReadonlyArray<PluginPanelSnapshot> | null;
  error: string | null;
  onFilter: (next: (current: Filters) => Filters) => void;
}) {
  return <Panels key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function Panels(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  snapshots: ReadonlyArray<PluginPanelSnapshot> | null;
  error: string | null;
  onFilter: (next: (current: Filters) => Filters) => void;
}) {
  const agent = usePluginThreadAgent(props.environmentId, props.threadId);
  return (
    <PluginAgentContext value={agent}>
      <PluginSurfaceHost>
        <div data-thread-plugin-panels="">
          <PluginPanels
            environmentId={props.environmentId}
            target={{ scope: "thread", threadId: props.threadId }}
            snapshots={props.snapshots}
            error={props.error}
            onFilter={props.onFilter}
            Section={ThreadDetailsSection}
            // The details panel is on the right; cards open over the chat.
            hoverSide="left"
            defaultHeight={320}
          />
        </div>
      </PluginSurfaceHost>
    </PluginAgentContext>
  );
}
