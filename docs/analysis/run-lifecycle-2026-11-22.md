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

(in progress)

## 5. Design findings

(in progress)

## 6. Unconfirmed suspicions

(in progress)

## 7. Coverage

(in progress)
