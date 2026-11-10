import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  pluginNavigationPlan,
  type PluginNavigationActivity,
  type PluginNavigationPlan,
} from "@t3tools/client-runtime/state/pluginNavigation";
import type {
  EnvironmentId,
  PluginPanelRow,
  SubscribeEnvironmentPluginPanelsInput,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { readProjects, readThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import { Button } from "../ui/button";
import { Popover, PopoverPopup } from "../ui/popover";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { PluginPanels } from "./PluginPanels";
import { environmentPluginPanels } from "./pluginState";
import { PluginSurfaceHost } from "./PluginSurfaceHost";

const ACTIVITY_LABEL: Record<PluginNavigationActivity, string> = {
  approval: "Needs approval",
  input: "Awaiting input",
  working: "Working",
  idle: "Idle",
};

/**
 * Environment-scoped plugin panels in the left sidebar, for the environment of the open thread or
 * the primary one. Renders nothing until a plugin serves an environment panel.
 */
export function EnvironmentPluginPanels() {
  const routeTarget = useThreadRouteTarget();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId =
    routeTarget?.kind === "server" ? routeTarget.threadRef.environmentId : primaryEnvironmentId;
  if (environmentId === null) return null;
  return <EnvironmentPanels key={environmentId} environmentId={environmentId} />;
}

type Chooser = Exclude<PluginNavigationPlan, { kind: "thread" } | { kind: "none" }>;

function EnvironmentPanels({ environmentId }: { environmentId: EnvironmentId }) {
  const [filters, setFilters] = useState<SubscribeEnvironmentPluginPanelsInput["filters"]>([]);
  const [chooser, setChooser] = useState<{ plan: Chooser; anchor: Element } | null>(null);
  const query = useEnvironmentQuery(environmentPluginPanels({ environmentId, input: { filters } }));
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const panels = (query.data ?? []).filter(
    (plugin) => plugin.status !== "connected" || plugin.panels.length > 0,
  );
  if (panels.length === 0) return null;

  const openThread = (threadId: ThreadId) => {
    setChooser(null);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };
  const navigateRow = (row: PluginPanelRow, anchor: Element) => {
    // Read once at click time; the sidebar should not re-render on every thread change for this.
    const plan = pluginNavigationPlan({
      projectIds: row.navigate?.projectIds ?? [],
      threads: readThreadShells().filter((thread) => thread.environmentId === environmentId),
      projects: readProjects().filter((project) => project.environmentId === environmentId),
    });
    if (plan.kind === "thread") openThread(plan.thread.threadId);
    else if (plan.kind === "none") {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: "No matching project",
          description: "This item's projects are not on this environment.",
        }),
      );
    } else setChooser({ plan, anchor });
  };

  return (
    <div
      className="shrink-0 border-t border-sidebar-border"
      data-testid="environment-plugin-panels"
    >
      <PluginSurfaceHost>
        <PluginPanels
          environmentId={environmentId}
          target={{ scope: "environment" }}
          snapshots={panels}
          // Older servers have no environment panels; the sidebar stays quiet about it.
          error={null}
          onFilter={setFilters}
          Section={ThreadDetailsSection}
          // The left sidebar: cards open to the right, over the chat.
          hoverSide="right"
          defaultHeight={200}
          onNavigate={navigateRow}
        />
      </PluginSurfaceHost>
      <Popover
        open={chooser !== null}
        onOpenChange={(open) => (open ? undefined : setChooser(null))}
      >
        {chooser === null ? null : (
          <PopoverPopup
            anchor={chooser.anchor}
            side="right"
            align="start"
            width="sm"
            padding="compact"
          >
            <div className="flex flex-col gap-1 text-xs" aria-label="Choose a thread">
              {chooser.plan.kind === "choose"
                ? chooser.plan.threads.map((thread) => (
                    <Button
                      key={thread.threadId}
                      variant="ghost"
                      size="sm-multiline"
                      onClick={() => openThread(thread.threadId)}
                    >
                      <span className="min-w-0 flex-1 truncate text-start">{thread.title}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {ACTIVITY_LABEL[thread.activity]}
                      </span>
                    </Button>
                  ))
                : null}
              {chooser.plan.projects.map((project) => (
                <Button
                  key={project.projectId}
                  variant="ghost"
                  size="sm-multiline"
                  onClick={() => {
                    setChooser(null);
                    void handleNewThread(scopeProjectRef(environmentId, project.projectId));
                  }}
                >
                  <PlusIcon />
                  <span className="min-w-0 flex-1 truncate text-start">
                    New thread in {project.title}
                  </span>
                </Button>
              ))}
            </div>
          </PopoverPopup>
        )}
      </Popover>
    </div>
  );
}
