# Run lifecycle: correctness analysis (2026-11-22)

Read-only analysis of the owner's T3 Code fork at local `main` 64d67164a6.
Status: **first pass, in progress.** Sections are filled in order and
committed one at a time; anything not yet marked "checked" is provisional.

## 1. The system, from the code

- A thread's work is a sequence of **runs** (`OrchestrationV2Run`,
  `packages/contracts/src/orchestrationV2.ts:765`). Status is one of
  `preparing, queued, starting, running, waiting` (active) or
  `completed, interrupted, failed, cancelled, rolled_back` (terminal;
  `isTerminalRunStatus`, `apps/server/src/orchestration-v2/ThreadManagementService.ts:550`).
- A run executes as one or more **attempts** (`reason: initial | steering_restart | retry |
  provider_recovery`), each bound to a provider thread and provider turn.
- Continuations are **new runs** pointing at the old one:
  `restartContinuationOfRunId` (server restart), `manualContinuationOfRunId` (user
  "Resume"), `usageLimitContinuationOfRunId` (auto resume after a usage-limit reset),
  `steerFollowUpOfRunId`.
- The orchestrator (`Orchestrator.ts`, 17k lines) decides events under a per-thread
  `KeyedLock` (`ThreadCommandExecutor.ts`); `EventSink` commits events, projections,
  receipt and outbox in one transaction; reactions (`handleRunUpdate`,
  `Orchestrator.ts:16261`) run after commit, and startup recovery
  (`recoverDelegatedTasks`, `resumeQueuedRuns`) re-derives work lost between a
  commit and its reaction.
- The run projection row is a whole-row upsert (`ProjectionStore.ts:2542`): the
  store has **no guard against a terminal run being overwritten by a later
  non-terminal `run.updated`**. "A run ends in exactly one terminal state" is
  maintained only by every emit site of `run.updated` (about 35 in
  `Orchestrator.ts`, plus `ProviderTurnStartService.ts:462,1904`).

## 2. What "Resumed thread" means

`"Resumed thread"` appears once in product code: `Orchestrator.ts:7681`. In
`dispatchMessage`, when a `message.dispatch` carries `manualContinuationOfRunId`,
the new run's user message gets a system notification
`{ source: system, outcome: updated, summary: "Resumed thread" }` and its text is
replaced with `""` (`Orchestrator.ts:7684`). It is the transcript marker of a
**manual continuation**: a new run that continues an interrupted run, or a run
that failed with a usage limit, on the same provider conversation.

Paths that set it (all go through `manualContinuationOfRunId`):

1. Web composer "Resume": `apps/web/src/components/chat/useComposerResume.ts:131`,
   via `startThreadTurn` (`packages/client-runtime/src/operations/commands.ts:829`)
   with `dispatchMode: start`.
2. Mobile "Resume": `apps/mobile/src/features/threads/resume-thread.ts:67`, same command.

No server path (restart continuation, usage-limit auto-resume, MCP tools, scheduled
tasks) sets `manualContinuationOfRunId`; those produce their own markers
(`RestartContinuation.ts:339`: "T3 Code restarted and resumed this turn").
The server accepts it only if (`Orchestrator.ts:7146-7165`): dispatch mode is
`start_immediately`; the source run exists and is `interrupted`, or `failed` with a
`usage_limit` root failure; the source is the latest executed run; the thread is not
archived or deleted; and no runtime request is pending.

## 3. Invariants

(table to be filled; see section commits)

## 4. Confirmed defects

### D1. A failed workspace-setup run stays failed once later work has run past it

- **Severity: medium.** A user-reachable click revives a terminal run. Its first
  message is sent to the provider again, after later messages, in whatever worktree
  the user has since chosen. The later run can no longer be resumed: once the old run
  is active again, the resume guard's `latestExecutedRun` (`Orchestrator.ts:7154`) is
  the old run. Every reaction that ran when the run first failed (queue start,
  delegated-completion finalization, scheduled-task outcome) has already happened, and
  they run again when it ends a second time.
- **Mechanism.** `dispatchPreparedRunRetry` (`Orchestrator.ts:12496`) accepts a retry
  when the run is `failed`, has `workspacePreparation`, has a
  `workspace_preparation_failed` error item, and **no other run is active**
  (`Orchestrator.ts:12525`). It does not check that the run is still the latest
  executed run, or that the thread still has no worktree. It then emits
  `run.updated { status: "preparing", completedAt: null }` (`Orchestrator.ts:12567`),
  a terminal-to-active transition. `ThreadLaunchService.retryPreparation`
  (`ThreadLaunchService.ts:1551`) then schedules preparation; with a `worktreePath` now
  set, it reuses that worktree (`ThreadLaunchService.ts:1572`). The client offers the
  button for every such run, with no recency check:
  `workspacePreparationRetryRunIds` (`packages/client-runtime/src/state/turnItemPresentation.ts:20`),
  used by `apps/web/src/components/chat/useWorktreeSetup.ts:113` and
  `apps/mobile/src/features/threads/thread-work-log.tsx:785`.
- **Reproduction.** `docs/analysis/repro/prepared-run-retry-after-later-run.test.ts.part`,
  appended to a copy of `ThreadLaunchService.test.ts` (real orchestrator, in-memory
  SQLite, fake git, no provider). Run 1 fails setup; the user picks an existing
  worktree (`thread.metadata.update`); run 2 starts and is stopped; Retry on run 1 is
  accepted. Output: `before retry: 1:failed 2:interrupted` → `retry exit: Success,
  after retry: 1:preparing 2:interrupted`. The test asserts the desired state and
  fails on `main`.
- **Smallest fix.** In `dispatchPreparedRunRetry`, also refuse when
  `latestExecutedRun(projection.runs)?.id !== state.run.id` or when
  `projection.thread.worktreePath !== null`. This is the condition
  `orchestrationV2WorktreePending` (`packages/shared/src/orchestrationV2ThreadError.ts:79`)
  already uses for "the setup request is still standing". Apply the same predicate in
  `workspacePreparationRetryRunIds`, so the button disappears too.

## 5. Design findings

(in progress)

## 6. Unconfirmed suspicions

(in progress)

## 7. Coverage

(in progress)
