import { useAtomValue } from "@effect/atom-react";
import { pluginNeedsDecision } from "@t3tools/client-runtime/state/pluginDiscovery";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PuzzleIcon } from "lucide-react";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { pluginDiscovery } from "./pluginState";

/**
 * Stays in the sidebar while a connected machine has plugins awaiting a decision, so a plugin
 * that appeared after the startup prompt, or whose toast was missed, is still one click away.
 */
export function SidebarPluginsNotice() {
  const { environments } = useEnvironments();
  return environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => (
      <EnvironmentPluginsNotice
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    ));
}

function EnvironmentPluginsNotice({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(pluginDiscovery.state({ environmentId, input: {} }));
  const canDecide = useAtomValue(pluginDiscovery.act.permissionAtom(environmentId));
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pending = (query.data?.plugins ?? []).filter(pluginNeedsDecision);
  if (!canDecide || pending.length === 0) return null;
  const label =
    pending.length === 1
      ? `New plugin: ${pending[0]!.name}. Review in Settings`
      : `${String(pending.length)} new plugins. Review in Settings`;
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              size="icon"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void navigate({ to: "/settings/plugins", search: { machine: environmentId } });
              }}
            />
          }
        >
          <span className="relative inline-flex">
            <PuzzleIcon />
            <span className="absolute -end-0.5 -top-0.5 size-2 rounded-full bg-primary" />
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
