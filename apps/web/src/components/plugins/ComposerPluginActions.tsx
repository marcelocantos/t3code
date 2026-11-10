import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PencilRulerIcon } from "lucide-react";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePluginThreadAgent } from "./pluginAgent";
import { threadPluginPanels } from "./pluginState";
import {
  PluginAgentContext,
  PluginSurfaceHost,
  pluginFrameAgentSource,
  usePluginSurfaceHost,
} from "./PluginSurfaceHost";

/** The fragment a plugin page reads to know it was opened from the composer. */
const COMPOSER_FRAGMENT = "#t3-composer";

/** Buttons beside the paperclip for web panels that declare `composer`. */
export function ComposerPluginActions(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(
    threadPluginPanels({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, filters: [] },
    }),
  );
  const agent = usePluginThreadAgent(props.environmentId, props.threadId);
  const actions = (query.data ?? []).flatMap((snapshot) =>
    snapshot.panels.flatMap((panel) =>
      panel.kind === "web" && panel.composer !== undefined
        ? [{ pluginId: snapshot.pluginId, panel, label: panel.composer.label }]
        : [],
    ),
  );
  if (agent === null || actions.length === 0) return null;
  return (
    <PluginAgentContext value={agent}>
      <PluginSurfaceHost>
        <div className="me-2 flex items-center">
          {actions.map((action) => (
            <ComposerPluginButton
              key={`${action.pluginId}:${action.panel.id}`}
              environmentId={props.environmentId}
              agentSource={pluginFrameAgentSource(action.pluginId, action.panel.id)}
              path={action.panel.path}
              label={action.label}
            />
          ))}
        </div>
      </PluginSurfaceHost>
    </PluginAgentContext>
  );
}

function ComposerPluginButton(props: {
  readonly environmentId: EnvironmentId;
  readonly agentSource: string;
  readonly path: string;
  readonly label: string;
}) {
  const host = usePluginSurfaceHost();
  const connection = usePreparedConnection(props.environmentId);
  if (connection._tag === "None") return null;
  const url = new URL(`${props.path}${COMPOSER_FRAGMENT}`, connection.value.httpBaseUrl).href;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() =>
              host.openWebModal({ url, title: props.label, agentSource: props.agentSource })
            }
            aria-label={props.label}
          />
        }
      >
        <PencilRulerIcon />
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}
