import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  turnItemIsWorkspacePreparation,
  workspacePreparationRetryRunIds,
} from "./turnItemPresentation.ts";

function command(input: string): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-08-03T00:00:00.000Z");
  return {
    id: TurnItemId.make("item-command"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Workspace ready",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input,
    output: "Workspace preparation completed.",
    exitCode: 0,
  };
}

function preparationFailure(
  status: OrchestrationV2TurnItem["status"],
  code: string | null = ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
): OrchestrationV2TurnItem {
  const {
    input: _input,
    output: _output,
    exitCode: _exitCode,
    ...base
  } = command("") as Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
  return {
    ...base,
    id: TurnItemId.make("item-error"),
    status,
    title: "Workspace preparation failed",
    type: "error",
    failure: { class: "validation_error", message: "fetch failed", code, retryable: false },
  };
}

const worktree = { type: "worktree", baseRef: "main" } as const;
const at = DateTime.makeUnsafe("2026-08-03T00:00:00.000Z");
const later = DateTime.makeUnsafe("2026-08-03T00:01:00.000Z");
function run(
  status: OrchestrationV2Run["status"],
  workspacePreparation?: typeof worktree,
  overrides?: Partial<Pick<OrchestrationV2Run, "id" | "ordinal" | "startedAt" | "completedAt">>,
): Pick<
  OrchestrationV2Run,
  "id" | "status" | "workspacePreparation" | "ordinal" | "startedAt" | "completedAt"
> {
  return {
    id: RunId.make("run-1"),
    status,
    ordinal: 1,
    startedAt: at,
    completedAt:
      status === "preparing" || status === "starting" || status === "running" || status === "queued"
        ? null
        : at,
    ...(workspacePreparation === undefined ? {} : { workspacePreparation }),
    ...overrides,
  };
}

describe("turnItemIsWorkspacePreparation", () => {
  it("hides a preparation failure only once a retry cancelled it", () => {
    expect(turnItemIsWorkspacePreparation(preparationFailure("failed"))).toBe(false);
    expect(turnItemIsWorkspacePreparation(preparationFailure("cancelled"))).toBe(true);
    expect(turnItemIsWorkspacePreparation(preparationFailure("cancelled", null))).toBe(false);
  });
});

describe("workspacePreparationRetryRunIds", () => {
  it("offers a retry while the run still ends in its failed preparation", () => {
    const failure = [preparationFailure("failed")];
    expect([...workspacePreparationRetryRunIds([run("failed", worktree)], failure)]).toEqual([
      RunId.make("run-1"),
    ]);
    expect(workspacePreparationRetryRunIds([run("preparing", worktree)], failure).size).toBe(0);
    expect(workspacePreparationRetryRunIds([run("failed")], failure).size).toBe(0);
    expect(
      workspacePreparationRetryRunIds(
        [run("failed", worktree)],
        [preparationFailure("failed", "provider_crashed")],
      ).size,
    ).toBe(0);
  });

  it("hides the retry once a later run has executed", () => {
    const failure = [preparationFailure("failed")];
    const executedLater = run("interrupted", undefined, {
      id: RunId.make("run-2"),
      ordinal: 2,
      startedAt: later,
      completedAt: later,
    });
    expect(
      workspacePreparationRetryRunIds([run("failed", worktree), executedLater], failure).size,
    ).toBe(0);
    const queuedLater = run("queued", undefined, {
      id: RunId.make("run-2"),
      ordinal: 2,
      startedAt: null,
      completedAt: null,
    });
    expect([
      ...workspacePreparationRetryRunIds([run("failed", worktree), queuedLater], failure),
    ]).toEqual([RunId.make("run-1")]);
  });
});
