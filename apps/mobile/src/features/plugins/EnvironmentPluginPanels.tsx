import {
  pluginNavigationPlan,
  type PluginNavigationActivity,
  type PluginNavigationProject,
  type PluginNavigationThread,
} from "@t3tools/client-runtime/state/pluginNavigation";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  PluginPanelRow,
  SubscribeEnvironmentPluginPanelsInput,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Sheet } from "../../components/ui/Sheet";
import { cn } from "../../lib/cn";
import { useEnvironmentQuery } from "../../state/query";
import { environmentPluginPanels, pluginErrorMessage } from "./pluginAtoms";
import { PluginPanels } from "./PluginPanels";

const ACTIVITY_LABEL: Record<PluginNavigationActivity, string> = {
  approval: "Needs approval",
  input: "Needs input",
  working: "Working",
  idle: "Idle",
};

interface NavigationProps {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}

/** Sidebar panels that see every project of an environment; rows with `navigate` open threads. */
export function EnvironmentPluginPanels(
  props: NavigationProps & { readonly environmentIds: ReadonlyArray<EnvironmentId> },
) {
  if (props.environmentIds.length === 0) return null;
  return (
    <View className="gap-3 px-4 py-2">
      {props.environmentIds.map((environmentId) => (
        <EnvironmentPanels key={environmentId} environmentId={environmentId} {...props} />
      ))}
    </View>
  );
}

type Chooser = {
  readonly title: string;
  readonly threads: ReadonlyArray<PluginNavigationThread>;
  readonly projects: ReadonlyArray<PluginNavigationProject>;
};

function EnvironmentPanels(props: NavigationProps & { readonly environmentId: EnvironmentId }) {
  const [filters, setFilters] = useState<SubscribeEnvironmentPluginPanelsInput["filters"]>([]);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const query = useEnvironmentQuery(
    environmentPluginPanels({ environmentId: props.environmentId, input: { filters } }),
  );
  const threads = props.threads.filter((thread) => thread.environmentId === props.environmentId);
  const projects = props.projects.filter(
    (project) => project.environmentId === props.environmentId,
  );
  const openThread = (threadId: string) => {
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (thread) props.onSelectThread(thread);
  };
  const newThread = (projectId: string) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project) props.onNewThreadInProject(project);
  };
  const navigate = (row: PluginPanelRow) => {
    const plan = pluginNavigationPlan({
      projectIds: row.navigate?.projectIds ?? [],
      threads,
      projects,
    });
    switch (plan.kind) {
      case "thread":
        openThread(plan.thread.threadId);
        return;
      case "choose":
        setChooser({ title: row.label, threads: plan.threads, projects: plan.projects });
        return;
      case "new-thread": {
        const [only] = plan.projects;
        if (plan.projects.length === 1 && only) newThread(only.projectId);
        else setChooser({ title: row.label, threads: [], projects: plan.projects });
        return;
      }
      case "none":
        Dialog.alert(
          "No matching project",
          "None of this item's projects are in this environment.",
        );
    }
  };
  const snapshots = query.data ?? [];
  if (snapshots.length === 0 && !query.error) return null;
  return (
    <>
      {query.error ? (
        <Text className="text-sm text-foreground-muted">
          Plugin panels unavailable: {pluginErrorMessage(query.failure)}
        </Text>
      ) : null}
      <PluginPanels
        environmentId={props.environmentId}
        target={{ scope: "environment" }}
        snapshots={snapshots}
        onNavigate={navigate}
        onFilter={(pluginId, panelId, filter) =>
          setFilters((current) => [
            ...current.filter((item) => item.pluginId !== pluginId || item.panelId !== panelId),
            { pluginId, panelId, filter },
          ])
        }
      />
      {chooser ? (
        <ThreadChooserSheet
          chooser={chooser}
          onClose={() => setChooser(null)}
          onThread={(threadId) => {
            setChooser(null);
            openThread(threadId);
          }}
          onProject={(projectId) => {
            setChooser(null);
            newThread(projectId);
          }}
        />
      ) : null}
    </>
  );
}

function ThreadChooserSheet(props: {
  readonly chooser: Chooser;
  readonly onClose: () => void;
  readonly onThread: (threadId: string) => void;
  readonly onProject: (projectId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const entries = [
    ...props.chooser.threads.map((thread) => ({
      key: `thread:${thread.threadId}`,
      label: thread.title,
      detail: ACTIVITY_LABEL[thread.activity],
      icon: "bubble.left.and.bubble.right" as const,
      onPress: () => props.onThread(thread.threadId),
    })),
    ...props.chooser.projects.map((project) => ({
      key: `project:${project.projectId}`,
      label: `New thread in ${project.title}`,
      detail: undefined,
      icon: "plus" as const,
      onPress: () => props.onProject(project.projectId),
    })),
  ];
  return (
    <Sheet title={props.chooser.title} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="px-5 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(20, insets.bottom) }}
      >
        <View className="overflow-hidden rounded-xl bg-grouped-card">
          {entries.map((entry, index) => (
            <Pressable
              key={entry.key}
              accessibilityRole="button"
              accessibilityLabel={[entry.label, entry.detail].filter(Boolean).join(", ")}
              className={cn(
                "min-h-12 flex-row items-center gap-3 px-4 py-2 active:opacity-70",
                index > 0 && "border-t border-border-subtle",
              )}
              onPress={entry.onPress}
            >
              <SymbolView name={entry.icon} size={18} tintColorClassName="accent-icon-muted" />
              <View className="min-w-0 flex-1">
                <Text numberOfLines={2} className="text-foreground">
                  {entry.label}
                </Text>
                {entry.detail ? (
                  <Text className="text-xs text-foreground-muted">{entry.detail}</Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </Sheet>
  );
}
