import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  pluginNavigationPlan,
  type PluginNavigationProjectInput,
  type PluginNavigationThreadInput,
} from "./pluginNavigation.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const projects: ReadonlyArray<PluginNavigationProjectInput> = [
  { id: projectA, title: "Alpha", archivedAt: null },
  { id: projectB, title: "Beta", archivedAt: null },
  { id: ProjectId.make("project-old"), title: "Old", archivedAt: "2026-01-01T00:00:00.000Z" },
];

const thread = (
  id: string,
  overrides: Partial<PluginNavigationThreadInput> = {},
): PluginNavigationThreadInput => ({
  id: ThreadId.make(id),
  projectId: projectA,
  title: id,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  archivedAt: null,
  deletedAt: null,
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestUserMessageAt: null,
  latestRun: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

describe("pluginNavigationPlan", () => {
  it("offers no route when none of the projects exist here", () => {
    expect(
      pluginNavigationPlan({
        projectIds: ["missing", "project-old"],
        threads: [thread("t1")],
        projects,
      }),
    ).toEqual({ kind: "none" });
  });

  it("offers a new thread when the projects have no listed threads", () => {
    const plan = pluginNavigationPlan({
      projectIds: ["project-a", "project-b"],
      threads: [
        thread("archived", { archivedAt: "2026-11-02T00:00:00.000Z" }),
        thread("deleted", { deletedAt: "2026-11-02T00:00:00.000Z" }),
        thread("side", {
          lineage: {
            parentThreadId: ThreadId.make("p"),
            relationshipToParent: null,
            rootThreadId: ThreadId.make("p"),
            sideChat: true,
          },
        }),
        thread("subagent", {
          lineage: {
            parentThreadId: ThreadId.make("p"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("p"),
          },
        }),
        thread("elsewhere", { projectId: ProjectId.make("project-c") }),
      ],
      projects,
    });
    expect(plan).toEqual({
      kind: "new-thread",
      projects: [
        { projectId: projectA, title: "Alpha" },
        { projectId: projectB, title: "Beta" },
      ],
    });
  });

  it("goes straight to the only candidate", () => {
    const plan = pluginNavigationPlan({
      projectIds: ["project-b"],
      threads: [thread("t1"), thread("t2", { projectId: projectB })],
      projects,
    });
    expect(plan.kind === "thread" && plan.thread.threadId).toBe("t2");
  });

  it("lists several candidates by latest activity with their state", () => {
    const plan = pluginNavigationPlan({
      projectIds: ["project-a", "project-b"],
      threads: [
        thread("quiet", { updatedAt: "2026-11-01T00:00:00.000Z" }),
        thread("asked", {
          projectId: projectB,
          latestUserMessageAt: "2026-11-05T00:00:00.000Z",
          hasPendingUserInput: true,
        }),
        thread("busy", {
          latestUserMessageAt: "2026-11-03T00:00:00.000Z",
          runtime: {
            status: "running",
            activeRunId: null,
            providerInstanceId: "codex" as never,
            providerName: null,
            lastError: null,
            updatedAt: "2026-11-03T00:00:00.000Z",
          },
        }),
      ],
      projects,
    });
    expect(plan.kind).toBe("choose");
    if (plan.kind !== "choose") return;
    expect(plan.threads.map((candidate) => [candidate.threadId, candidate.activity])).toEqual([
      ["asked", "input"],
      ["busy", "working"],
      ["quiet", "idle"],
    ]);
    expect(plan.projects.map((project) => project.title)).toEqual(["Alpha", "Beta"]);
  });
});
