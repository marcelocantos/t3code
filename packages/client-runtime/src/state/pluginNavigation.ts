import { isListedThreadLineage, type ProjectId, type ThreadId } from "@t3tools/contracts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import { resolveThreadActivityTimestamp, toSortableTimestamp } from "./threadSort.ts";

/** What a thread is doing, as far as someone choosing between threads needs to know. */
export type PluginNavigationActivity = "approval" | "input" | "working" | "idle";

export interface PluginNavigationThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly activity: PluginNavigationActivity;
  /** The thread's latest activity, ISO; what candidates are ordered by. */
  readonly activityAt: string | null;
}

export interface PluginNavigationProject {
  readonly projectId: ProjectId;
  readonly title: string;
}

/**
 * Where a row click with `navigate` leads: straight to the only candidate thread, a chooser
 * between several, or a new thread when none exists. `projects` back the "New thread in <project>"
 * choices in every case but `none`, which means no named project exists in this environment.
 */
export type PluginNavigationPlan =
  | {
      readonly kind: "thread";
      readonly thread: PluginNavigationThread;
      readonly projects: ReadonlyArray<PluginNavigationProject>;
    }
  | {
      readonly kind: "choose";
      readonly threads: ReadonlyArray<PluginNavigationThread>;
      readonly projects: ReadonlyArray<PluginNavigationProject>;
    }
  | { readonly kind: "new-thread"; readonly projects: ReadonlyArray<PluginNavigationProject> }
  | { readonly kind: "none" };

export type PluginNavigationThreadInput = Pick<
  EnvironmentThreadShell,
  | "id"
  | "projectId"
  | "title"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "latestUserMessageAt"
  | "latestRun"
  | "updatedAt"
>;

export type PluginNavigationProjectInput = Pick<EnvironmentProject, "id" | "title" | "archivedAt">;

function pluginNavigationActivity(
  thread: Pick<
    PluginNavigationThreadInput,
    "runtime" | "hasPendingApprovals" | "hasPendingUserInput"
  >,
): PluginNavigationActivity {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  const status = thread.runtime?.status;
  return status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
    ? "working"
    : "idle";
}

/** Threads and projects one environment's data offers for a row's `navigate.projectIds`. */
export function pluginNavigationPlan(input: {
  readonly projectIds: ReadonlyArray<string>;
  readonly threads: ReadonlyArray<PluginNavigationThreadInput>;
  readonly projects: ReadonlyArray<PluginNavigationProjectInput>;
}): PluginNavigationPlan {
  const wanted = new Set(input.projectIds);
  const projects = input.projectIds.flatMap((projectId) => {
    const project = input.projects.find(
      (candidate) => candidate.id === projectId && candidate.archivedAt == null,
    );
    return project === undefined ? [] : [{ projectId: project.id, title: project.title }];
  });
  if (projects.length === 0) return { kind: "none" };
  const threads = input.threads
    .filter(
      (thread) =>
        wanted.has(thread.projectId) &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        isListedThreadLineage(thread.lineage),
    )
    .map((thread): PluginNavigationThread & { readonly sortKey: number } => {
      const activityAt = resolveThreadActivityTimestamp(thread);
      return {
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        activity: pluginNavigationActivity(thread),
        activityAt,
        sortKey: toSortableTimestamp(activityAt ?? undefined) ?? Number.NEGATIVE_INFINITY,
      };
    })
    .sort(
      (left, right) =>
        right.sortKey - left.sortKey ||
        (left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0),
    )
    .map(({ sortKey: _sortKey, ...thread }) => thread);
  const [only] = threads;
  if (only === undefined) return { kind: "new-thread", projects };
  if (threads.length === 1) return { kind: "thread", thread: only, projects };
  return { kind: "choose", threads, projects };
}
