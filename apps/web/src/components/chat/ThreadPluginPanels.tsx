import { useState } from "react";
import type { EnvironmentId, SubscribePluginPanelsInput, ThreadId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { usePluginThreadAgent } from "../plugins/pluginAgent";
import { PluginPanels } from "../plugins/PluginPanels";
import { threadPluginPanels } from "../plugins/pluginState";
import { PluginAgentContext, PluginSurfaceHost } from "../plugins/PluginSurfaceHost";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

/** Keyed by thread, so filters reset and every surface a panel opened closes on a switch. */
export function ThreadPluginPanels(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  return <Panels key={`${props.environmentId}:${props.threadId}`} {...props} />;
}

function Panels({ environmentId, threadId }: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const [filters, setFilters] = useState<SubscribePluginPanelsInput["filters"]>([]);
  const query = useEnvironmentQuery(
    threadPluginPanels({ environmentId, input: { threadId, filters } }),
  );
  const agent = usePluginThreadAgent(environmentId, threadId);
  return (
    <PluginAgentContext value={agent}>
      <PluginSurfaceHost>
        <div data-thread-plugin-panels="">
          <PluginPanels
            environmentId={environmentId}
            target={{ scope: "thread", threadId }}
            snapshots={query.data}
            error={query.error}
            onFilter={setFilters}
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
