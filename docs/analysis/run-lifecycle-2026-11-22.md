# Run lifecycle: correctness analysis (2026-11-22)

Read-only analysis of the owner's T3 Code fork at local `main` 64d67164a6.
Method: code reading, one TLA+ model checked with TLC
(`docs/analysis/tla/RunLifecycle.tla`), and reproductions run against the real
orchestrator with an in-memory database and fakes. No server, provider or live state was
touched. The worktree had no `node_modules`, so tests ran with symlinks to the main
checkout's `node_modules`. That checkout is clean at the same commit, 64d67164a6.

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

What the continuation run does (`ProviderTurnStartService.ts:641-650`, `:2119`): it
walks the `manualContinuationOfRunId` chain
(`packages/shared/src/orchestrationV2ManualContinuation.ts`). If the source never had a
provider-accepted attempt, or a later steering restart's message never reached the
provider, it sends that unsent user message again. Otherwise it asks the adapter for a
native `resumeTurn` with no new prompt. An adapter without `resumeTurn` fails the start
with "Native resume is unavailable" (`:1788`). Clients that talk to an older server send
the fallback text "Continue where you left off." (`commands.ts:752`).

No server path (restart continuation, usage-limit auto-resume, MCP tools, scheduled
tasks) sets `manualContinuationOfRunId`; those produce their own markers
(`RestartContinuation.ts:339`: "T3 Code restarted and resumed this turn").
The server accepts it only if (`Orchestrator.ts:7146-7165`): dispatch mode is
`start_immediately`; the source run exists and is `interrupted`, or `failed` with a
`usage_limit` root failure; the source is the latest executed run; the thread is not
archived or deleted; and no runtime request is pending.

## 3. Invariants

Status key: **holds by argument** (code read, no counterexample found); **holds in model**
(TLC, bound stated); **violated** (with a trace or reproduction); **unknown**.

| # | Invariant (checkable sentence) | Where maintained | How it could break | Status |
|---|---|---|---|---|
| I1 | A run's terminal status is final. The only designed exception is Retry of a failed setup run that is still the latest executed run. | Each `run.updated` emit site (no projection guard: `ProjectionStore.ts:2542` is a whole-row upsert). Effect-worker writes are compare-and-set through `EventSink.writeIfRunCurrent` (`EventSink.ts:545`). Orchestrator writes run under the thread lock. | An emit site that sets an active status without checking recency. `dispatchPreparedRunRetry` (`Orchestrator.ts:12496`) does this. | **Violated**: D1, reproduced; TLC trace T1. |
| I1b | Native rewind relabels `completed` runs as `rolled_back` (`ProviderEventIngestor.ts:443`). | By design: terminal to terminal. | Reactions keyed on "became terminal" fire again. | Holds by argument: `handleRunUpdate` reacts to terminal statuses idempotently; finalizers re-read state. |
| I2 | At most one run of a thread is in `preparing`/`starting`/`running`. | `dispatchMessage` queues behind an active run (`Orchestrator.ts:7805-7828`); queue start checks for an active run; the recovery query `queued-runs` (`ProjectionStore.ts:5071`). | A start path that skips the active check. | **Holds in model** (TLC: 4 runs, clock 9, crash/restart; 2.8M states). |
| I3 | A thread never has two live provider turns on its provider thread. A resume, or a new message after Stop, never runs alongside the turn it replaced. | `abandonedProviderTurns` interrupts an ended run's still-running turn before a new start reuses the session (`ProviderTurnStartService.ts:878-905`). A turn accepted after Stop is interrupted (`RunExecutionService.ts:1893-1922`). Per-thread effect ordering (`EffectWorker.ts:755`). | Stop lands after the running write but before the provider accepts. It ends the run at once (`Orchestrator.ts:13700-13800`) and cancels the in-flight start (`EffectWorker.ts:939`), which frees the thread's effect queue. The next run's start finds no stored turn to clean up and starts a second turn, while the first is accepted late. | **Violated**: D2, TLC trace T2, reproduced against the real orchestrator and effect worker with a fake adapter. |
| I4 | An interrupted or failed run keeps no provider turn alive, except while a late-turn interrupt is in flight. | Same as I3, plus Force stop (`ThreadManagementService.ts:1306`) and restart reconcile (`ProviderRuntimeRecoveryService.ts:1108`). No provider process survives the server. | An unresponsive provider: the run stays `running` with `unresponsiveAt` set until the user forces a stop (`Orchestrator.ts:13207`). This is by design: the run is not marked interrupted while its process lives. | Holds in model (both fixes, bound above). Holds by argument for unresponsive Stop. |
| I5 | A child's result reaches its parent, or the parent is told it was lost. | `handleRunUpdate` → `finalizeAppOwnedSubagent` (`Orchestrator.ts:16261-16330`); startup `recoverDelegatedTasks` with the `subagent-results` and `delegated-completions` queries (`ProjectionStore.ts:5091-5127`); reconcile turns blocking waits into `completionWake: always` (`ProviderRuntimeRecoveryService.ts:838`). | A crash between the child's terminal commit and the parent's finalize. The recovery query covers it: a terminal requested run with a null task result, or a terminal latest run with no `subagent_result` transfer. | Holds by argument. D1 weakens it: a revived child run produces a second end after the parent already holds a result (unconfirmed consequence, S3). |
| I6 | A scheduled slot fires at most once. | In-memory `activeRuns` reservation (`ScheduledTaskService.ts:1226`); `markRunning` before dispatch; command and message ids derived from the slot (`:1062`), so a replay is idempotent; startup moves crash-left `running` rows to `failed` and advances `next_run_at` (`:1350`). | A crash after dispatch: recovery advances past the slot, so it never re-fires. That is at-most-once, not exactly-once: a crash between `markRunning` and dispatch loses the slot, and the task is marked "interrupted by a server restart". DST fall-back: checked, `setParts` picks the earlier instant and the next slot is the next day (probe below). | Holds by argument; DST probe run. |
| I7 | A settled or archived thread's worktree is never removed while a run, terminal or live session uses it. | `storageCleanup.ts`: idleness check, then `blockedSinceCheck` re-reads all bound threads and live sessions, inside `withWorkspaceLease(worktreePath)` (`:1603`). Turn start holds the same lease during startup (`ProviderTurnStartService.ts:2173`). A started run has `activeRunId` set, which blocks cleanup. | The lease key is the raw `path.resolve`d string (`workspace/workspaceLease.ts:9`), while cleanup groups threads by canonical path. Two threads bound to one worktree through different aliases take different leases (S1). | Holds by argument for un-aliased paths. |
| I8 | A manual resume starts only from the latest executed run, when it is interrupted or usage-limited, and never twice. | `dispatchMessage` guard (`Orchestrator.ts:7146-7165`) under the thread lock; the second resume sees the first continuation as the latest run. | D1 again: a revived setup run becomes "latest", and resuming the run that really ran last is refused. | Holds by argument, except D1. |
| I9 | Usage-limit auto-resume fires once per limit episode. | `usageLimitContinuationOfRunId` guard (`Orchestrator.ts:7168-7190`) matches `limitRecovery.requestId`, `runId` and `resetAt`; the thread is not settled, snoozed or archived. | A second worker tick with the same request id is turned into a metadata no-op. | Holds by argument. |

TLC results (`docs/analysis/tla/`, TLC 2.19, `-deadlock` because the clock bound ends
behaviours):

| Config | FixRetry | FixStop | Result |
|---|---|---|---|
| `RunLifecycle_asis.cfg` (3 runs, clock 7) | no | no | `TerminalStays` violated, trace T1 (6 states) |
| `RunLifecycle_fixretry.cfg` (3 runs, clock 7) | yes | no | `OneLiveTurn` violated, trace T2 (8 states) |
| `RunLifecycle_fixboth.cfg` (3 runs, clock 7) | yes | yes | no error, 82,326 distinct states |
| `RunLifecycle_fixboth_big.cfg` (4 runs, clock 9) | yes | yes | no error, 2,822,224 distinct states, depth 33, 25 s |

**T1** (maps to D1): `SetupFails(1)` (`dispatchPreparedRunFail`, `Orchestrator.ts:12486`) →
`ChooseWorkspace` (`thread.metadata.update worktreePath`) → `Send(2)` (`dispatchMessage`
starts run 2, since a worktree now exists, `:7808`) → `Stop(2)` (run 2 interrupted before
provider start, `:13704`) → `RetrySetup(1)` (`dispatchPreparedRunRetry`, `:12567`): run 1
goes `failed → preparing` after run 2 ended. The vitest reproduction follows the same
steps.

**T2** (maps to D2): `SetupSucceeds(1)` → `MarkRunning(1)` (CAS `starting →
running`, `ProviderTurnStartService.ts:1933`; the start effect is now delivering context
and calling `startTurn`) → `Stop(1)` (`dispatchRunInterrupt` finds no provider turn for
the attempt, so it ends run 1 `interrupted` and cancels unsettled `provider-turn.start`
effects, `Orchestrator.ts:13700-13800`; `EffectOutbox.cancelUnsettled` marks the running
row cancelled, `EffectOutbox.ts:499`, and `EffectWorker` interrupts the execution fiber,
`:939`) → `Send(2)` (no active run, so run 2 starts; run 1's cancelled row no longer
blocks the thread's effect queue) → `MarkRunning(2)` (`abandonedProviderTurns` sees no
stored turn for run 1, `:878`) → `ProviderAccepts(1)` (the `startTurn` request had already
left; the detached event fiber, `RunExecutionService.ts:2196`, stores the turn and finds
the run no longer owned, so it forks an interrupt, `:1905`) → `ProviderAccepts(2)`: two
live turns on one provider thread until the late interrupt lands. `Resume(1, 2)` is
enabled in the same state as `Send(2)`: run 1 is interrupted and latest. So the
manual-resume path reaches the same trace, and "a resume never runs two sessions on one
thread" fails in the model.

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

### D2. A Stop during turn start never lets the next run's turn overlap the old one

- **Severity: medium.** The user flow is common: send, Stop at once, send a correction.
  The provider receives the second prompt while it is still starting the first, on the
  same session and native thread. The first turn is never stored, so no client shows
  it. It is interrupted only after the second turn has started, by an interrupt aimed
  at a turn id the projection does not have.
- **Mechanism (trace T2, section 3).** The window runs from the running write
  (`ProviderTurnStartService.ts:1933`) to the provider's acceptance of `startTurn`. It
  includes context-handoff delivery and history injection, so it can last seconds.
  During it, `dispatchRunInterrupt` finds no stored provider turn. It ends the run at
  once (`Orchestrator.ts:13700-13800`) and cancels the unsettled
  `provider-turn.start` effect. `EffectOutbox.cancelUnsettled` marks the running row
  cancelled (`EffectOutbox.ts:499`) and the worker interrupts its fiber
  (`EffectWorker.ts:939`). The cancelled row no longer holds the thread's effect queue,
  so the next run's start runs at once. Its `abandonedProviderTurns` check
  (`ProviderTurnStartService.ts:878`) sees no stored turn for run 1, and it calls
  `startTurn` on the same session. When the provider then accepts run 1's request, a
  consumer interrupts that turn (`RunExecutionService.ts:1893-1922`), after run 2's
  turn is live.
- **Reproduction.** `docs/analysis/repro/stop-during-turn-start.test.ts.part`, appended
  to a copy of `ThreadStop.test.ts`: real orchestrator, real effect worker, in-memory
  SQLite, and a fake Codex-capability adapter whose `startTurn` for run 1 records the
  request and then waits for a reply that never comes. The test asserts the desired
  ordering and fails on `main`. Observed log:
  ```
  startTurn run 1
  run 1 is running when Stop lands
  startTurn run 1 fiber interrupted
  after Stop: 1:interrupted
  startTurn run 2
  provider accepts run 1's request now
  interruptTurn run 1's turn
  late turn stored: None
  final runs: 1:interrupted 2:running; running turns: <run 2's turn only>
  ```
- **Residue (not verified).** Whether a real adapter's `startTurn` RPC can have left
  the process when its fiber is interrupted (the fake assumes it can). What a real
  provider does with a second prompt while the first is starting: Codex app-server may
  refuse it; Claude's prompt queue may merge it into the first turn. Whether
  `interruptTurn` for run 1's turn id stops run 2's turn on adapters that interrupt
  "the current turn" of a native thread.
- **Smallest fix (checked in the model as `FixStop`; with `FixRetry`, TLC finds no
  violation at 4 runs, clock 9).** In `dispatchRunInterrupt`, when the run is
  `running` but has no stored provider turn, store the interrupt request instead of
  ending the run. The start's own outcome then settles it: an accepted turn is stopped
  through the normal interrupt path, and a refused start fails the run. The
  `unlessInterruptRequested` guard on `writeIfRunCurrent` (`EventSink.ts:144`) already
  supports this. Keep the synchronous path for `preparing` and `starting`, where no
  prompt can have left. A smaller alternative: keep a cancelled `provider-turn.start`
  row blocking the thread's effect queue until its fiber has actually exited and the
  outcome of its RPC is known.

## 5. Design findings

1. **Run status has no store-level transition guard.** The projection upserts whole
   rows (`ProjectionStore.ts:2542`). Terminal finality is a convention kept by about 35
   emit sites in `Orchestrator.ts` and several services. D1 is what that costs. Change:
   one pure `assertRunTransition(prev, next, reason)` in the decider path, run by the
   orchestrator and by `writeIfRunCurrent`, with an explicit allow-list (setup retry of
   the latest run, rewind to `rolled_back`). Cost: small code, but every caller must
   state a reason. A table test over the allow-list replaces the per-site checks.
2. **"Is this setup failure still standing?" is decided in four places with three
   predicates.** `orchestrationV2WorktreePending` (shared, latest-run based),
   `worktreeSetupPending` (`Orchestrator.ts:1005`, any failed run), the
   `worktreeMissingRun` guard in `dispatchMessage` (`:7808`, latest-run based), and
   `workspacePreparationRetryRunIds` (client, any failed run). The retry guard and the
   client button use the "any failed run" form, which is D1. Change: one shared
   predicate used by all four. Cost: low.
3. **Stop has two semantics that depend on whether a provider turn is stored yet.**
   With no stored turn, Stop ends the run synchronously. With one, it sends an interrupt
   and waits. The boundary ("is a turn stored?") is not the real one ("could the
   provider have received a prompt?"); D2 lives in that gap. Change: key the synchronous
   path on the run never having reached `running`. Cost: low, plus one integration test
   with a blocking fake `startTurn`.
4. **Recovery re-derives work from SQL predicates kept apart from the reactions they
   back up.** `handleRunUpdate` and `recoverDelegatedTasks` must agree on "a child result
   is owed"; the SQL in `ProjectionStore.ts:5098` restates `delegatedTaskResultPending`
   (`Orchestrator.ts:16596`). They agree today (checked by reading). Change: a test that
   runs both on the same fixtures. Cost: one table test.
5. **Unresponsive interrupt is user-resolved.** A provider that ignores interrupt
   leaves the run `running`, flagged `unresponsiveAt`, until Force stop. This is honest
   (the run is not called interrupted while its process lives). But no timer escalates
   it, so an unattended thread, such as a scheduled or delegated child, holds its
   session indefinitely. Change: escalate to Force stop after a bound for runs with no
   attached viewer. Cost: a policy decision.

## 6. Unconfirmed suspicions

- **S1. Workspace lease aliasing.** `withWorkspaceLease` keys on the raw resolved path
  (`workspace/workspaceLease.ts:9`); storage cleanup groups threads by canonical path but
  leases `path.resolve(owner.worktreePath)` (`storageCleanup.ts:1226`). A second thread
  bound to the same worktree through a symlink alias would start turns under a different
  lease from the one held during removal. Tried: read both sides. Not tried: a two-alias
  reproduction. The window is narrow, because `blockedSinceCheck` rereads every bound
  thread under the lease.
- **S2. Adapter behaviour under D2**: see D2's residue.
- **S3. D1 on a delegated child.** If the revived run belongs to an app-owned child, the
  parent already holds the first result. `finalizeAppOwnedSubagent` would run again on
  the second end; whether it overwrites, duplicates or ignores the result was not
  checked.
- **S4. Scheduled run lost on a crash before dispatch.** `markRunning` commits before
  dispatch; a crash in between advances `next_run_at` without sending. That follows the
  at-most-once design, but the row says "interrupted by a server restart" even when
  nothing was sent. Not a defect against the stated invariant.

## 7. Coverage

Read in full or nearly: `docs/analysis` brief, `AGENTS.md`, `~/.claude/tlaplus.md`;
`Orchestrator.ts` sections: `dispatchMessage` (7071-7900), `dispatchRunInterrupt`
(13518-13960), `dispatchInterruptUnresponsive`, the prepared-run family (12229-12600),
`resumeQueuedRuns`, `handleRunUpdate` and the recovery streams (16180-16620);
`ProviderRuntimeRecoveryService.ts` (820-1266); `ScheduledTaskService.ts` (760-1430);
`Schedule.ts`; `Scheduler.ts`; `ThreadCommandExecutor.ts`; `workspaceLease.ts`;
`EventSink.writeIfRunCurrent`; `EffectOutbox.cancelUnsettled`; `EffectWorker` claim and
race (740-1000); `ThreadManagementService.forceStopThread`;
`ProviderTurnControlService.interrupt`; the `getRecoveryThreadIds` SQL; the client
resume paths (web, mobile, client-runtime).

Skimmed: `ProviderTurnStartService.ts` (start, abandoned turns, running write),
`RunExecutionService.ts` (start, ownership recheck, finalize), `storageCleanup.ts`
worktree path (1160-1660), `ThreadLaunchService.retryPreparation`/`prepareRun`,
`WorktreeMcpService` worktree creation.

Not reached: provider adapters (`Adapters/*`; needed for D2's residue);
`ProviderSessionManager.ts` (3,495 lines: session sharing, idle unload, detach);
`RestartContinuation.ts` beyond its marker; `UsageLimitRecoveryWorker.ts` beyond the
dispatch guard; `DelegatedCompletionDelivery` internals (cohorts, generations); remote
delegated tasks (`RemoteDelegatedTask`); `ThreadSettlementService`; checkpoint
rollback; the mobile client beyond resume. The TLA+ model does not cover delegated
parent/child, steering, provider switching, or shared sessions across threads.

Probes run: D1 and D2 vitest reproductions (both fail on `main` as described); a DST probe of
`nextScheduledRunAt` in `Australia/Sydney` (fall-back 2026-04-05 and spring-forward
2026-10-04: one fire per day, no repeat); four TLC configurations.
