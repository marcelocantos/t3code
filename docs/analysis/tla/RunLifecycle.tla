---------------------------- MODULE RunLifecycle ----------------------------
(* One thread's runs, as apps/server/src/orchestration-v2 decides them.
   Each action names the code that takes the step. Status values follow
   OrchestrationV2RunStatus (packages/contracts/src/orchestrationV2.ts:680).

   Abstractions:
   - The per-thread KeyedLock (ThreadCommandExecutor.ts) makes every
     orchestrator command one atomic step here.
   - Writes from the effect worker are compare-and-set on (status,
     activeAttemptId) through EventSink.writeIfRunCurrent (EventSink.ts:545),
     also one atomic step each.
   - The provider process is "turn[r]": NoTurn, Live (a native turn is
     running in a provider process) or Done.
   - A server crash loses every in-memory thing; startup reconcile
     (ProviderRuntimeRecoveryService.reconcile, :1108) ends every
     non-terminal run, and no provider process survives the server.
   - Run 1 is a launch with worktree preparation. Later runs are messages.
   - FixRetry = TRUE adds the guard proposed for defect D1.
   - FixStop = TRUE makes a Stop that lands while a start is past its running
     write wait for the provider (the proposed fix for defect D2).   *)
EXTENDS Naturals, FiniteSets

CONSTANTS Runs, MaxClock, FixRetry, FixStop

Active   == {"preparing", "starting", "running"}
Terminal == {"completed", "interrupted", "failed", "usage_limited"}
\* "usage_limited" is status failed with a usage_limit root failure.

VARIABLES
  status,      \* run -> "none" | "queued" | Active | Terminal
  ended,       \* run -> times the run has entered a terminal state
  endedAt,     \* run -> logical end time (0 while not ended); latestExecutedRun
  turn,        \* run -> "NoTurn" | "Live" | "Done"
  stopAsked,   \* run -> an interrupt request is stored without its result
  lateKill,    \* run -> a turn started after Stop is being interrupted (RunExecutionService.ts:1905)
  inFlight,    \* run -> its provider-turn.start effect is past the running write (in memory)
  worktree,    \* "none" | "made" | "chosen"
  up,          \* server is running
  clock

vars == <<status, ended, endedAt, turn, stopAsked, lateKill, inFlight, worktree, up, clock>>

First == CHOOSE r \in Runs : \A s \in Runs : r <= s

TypeOK ==
  /\ status \in [Runs -> {"none", "queued"} \cup Active \cup Terminal]
  /\ ended \in [Runs -> 0..MaxClock]
  /\ turn \in [Runs -> {"NoTurn", "Live", "Done"}]
  /\ worktree \in {"none", "made", "chosen"}

Init ==
  /\ status = [r \in Runs |-> IF r = First THEN "preparing" ELSE "none"]
  /\ ended = [r \in Runs |-> 0]
  /\ endedAt = [r \in Runs |-> 0]
  /\ turn = [r \in Runs |-> "NoTurn"]
  /\ stopAsked = [r \in Runs |-> FALSE]
  /\ lateKill = [r \in Runs |-> FALSE]
  /\ inFlight = [r \in Runs |-> FALSE]
  /\ worktree = "none"
  /\ up = TRUE
  /\ clock = 1

ActiveRuns == {r \in Runs : status[r] \in Active}
Executed == {r \in Runs : status[r] \notin {"none", "queued"}}
\* latestExecutedRun (packages/shared/src/orchestrationV2ThreadError.ts:62):
\* an unfinished run counts as ending at +infinity.
IsLatest(r) ==
  /\ r \in Executed
  /\ \A s \in Executed \ {r} :
       \/ status[s] \in Terminal /\ status[r] \in Active
       \/ status[s] \in Terminal /\ status[r] \in Terminal /\ endedAt[s] < endedAt[r]

End(r, st) ==
  /\ status' = [status EXCEPT ![r] = st]
  /\ ended' = [ended EXCEPT ![r] = @ + 1]
  /\ endedAt' = [endedAt EXCEPT ![r] = clock]
  /\ clock' = clock + 1

Tick == clock < MaxClock

\* Worktree setup (ThreadLaunchService schedulePreparation, Orchestrator dispatchPreparedRunFail :12486)
SetupFails(r) ==
  /\ up /\ Tick /\ r = First /\ status[r] = "preparing"
  /\ End(r, "failed")
  /\ UNCHANGED <<turn, stopAsked, lateKill, worktree, up, inFlight>>

\* dispatchPreparedRunRelease (:12379): preparing -> starting, worktree bound.
SetupSucceeds(r) ==
  /\ up /\ r = First /\ status[r] = "preparing"
  /\ status' = [status EXCEPT ![r] = "starting"]
  /\ worktree' = IF worktree = "none" THEN "made" ELSE worktree
  /\ UNCHANGED <<ended, endedAt, turn, stopAsked, lateKill, up, clock, inFlight>>

\* The user picks an existing worktree (thread.metadata.update worktreePath).
ChooseWorkspace ==
  /\ up /\ worktree = "none"
  /\ worktree' = "chosen"
  /\ UNCHANGED <<status, ended, endedAt, turn, stopAsked, lateKill, up, clock, inFlight>>

\* Failed setup still standing: Orchestrator worktreeSetupPending (:1005) /
\* the worktreeMissingRun guard in dispatchMessage (:7808).
SetupPending ==
  /\ worktree = "none"
  /\ status[First] \in {"failed", "interrupted"}

\* dispatchMessage: a new run starts, or queues behind the active run or a
\* standing setup failure.
Send(r) ==
  /\ up /\ r # First /\ status[r] = "none"
  /\ \A s \in Runs : s < r => status[s] # "none"
  /\ status' = [status EXCEPT ![r] =
                  IF ActiveRuns # {} \/ SetupPending THEN "queued" ELSE "starting"]
  /\ UNCHANGED <<ended, endedAt, turn, stopAsked, lateKill, worktree, up, clock, inFlight>>

\* handleRunUpdate -> startNextQueuedRun (:16261), resumeQueuedRuns (:3587).
StartQueued(r) ==
  /\ up /\ status[r] = "queued" /\ ActiveRuns = {} /\ ~SetupPending
  /\ \A s \in Runs : status[s] = "queued" => r <= s
  /\ status' = [status EXCEPT ![r] = "starting"]
  /\ UNCHANGED <<ended, endedAt, turn, stopAsked, lateKill, worktree, up, clock, inFlight>>

\* ProviderTurnStartService: abandoned turns of ended runs are interrupted and
\* written settled first (:878-905), then the CAS starting -> running (:1933).
MarkRunning(r) ==
  /\ up /\ status[r] = "starting"
  /\ status' = [status EXCEPT ![r] = "running"]
  /\ turn' = [s \in Runs |-> IF s # r /\ status[s] \in Terminal /\ turn[s] = "Live"
                              THEN "Done" ELSE turn[s]]
  /\ lateKill' = [s \in Runs |-> IF s # r /\ status[s] \in Terminal THEN FALSE ELSE lateKill[s]]
  /\ inFlight' = [inFlight EXCEPT ![r] = TRUE]
  /\ UNCHANGED <<ended, endedAt, stopAsked, worktree, up, clock>>

\* RunExecutionService.startRootRun: the provider accepts the turn. The first
\* turn update is stored under the thread lock with an ownership recheck
\* (:1893-1922); a turn that lost to Stop is interrupted in the background.
ProviderAccepts(r) ==
  /\ up /\ inFlight[r] /\ turn[r] = "NoTurn"
  /\ turn' = [turn EXCEPT ![r] = "Live"]
  /\ lateKill' = [lateKill EXCEPT ![r] = (status[r] # "running")]
  /\ inFlight' = [inFlight EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<status, ended, endedAt, stopAsked, worktree, up, clock>>

LateKillLands(r) ==
  /\ up /\ lateKill[r] /\ turn[r] = "Live"
  /\ turn' = [turn EXCEPT ![r] = "Done"]
  /\ lateKill' = [lateKill EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<status, ended, endedAt, stopAsked, worktree, up, clock, inFlight>>

\* RunExecutionService finalize (:982) via writeIfRunCurrent expecting running.
ProviderCompletes(r) ==
  /\ up /\ Tick /\ status[r] = "running" /\ turn[r] = "Live" /\ ~stopAsked[r]
  /\ End(r, "completed")
  /\ turn' = [turn EXCEPT ![r] = "Done"]
  /\ UNCHANGED <<stopAsked, lateKill, worktree, up, inFlight>>

ProviderHitsUsageLimit(r) ==
  /\ up /\ Tick /\ status[r] = "running" /\ turn[r] = "Live"
  /\ End(r, "usage_limited")
  /\ turn' = [turn EXCEPT ![r] = "Done"]
  /\ stopAsked' = [stopAsked EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<lateKill, worktree, up, inFlight>>

\* dispatchRunInterrupt (:13518). No provider turn yet: ends the run at once
\* (:13704-13791). With a turn: stores the request, enqueues provider-turn.interrupt.
Stop(r) ==
  /\ up /\ Tick /\ status[r] \in Active /\ ~stopAsked[r]
  /\ IF turn[r] = "NoTurn" /\ ~(FixStop /\ inFlight[r])
       THEN /\ End(r, "interrupted")
            /\ UNCHANGED <<turn, stopAsked, inFlight>>
       ELSE /\ stopAsked' = [stopAsked EXCEPT ![r] = TRUE]
            /\ UNCHANGED <<status, ended, endedAt, clock, turn, inFlight>>
  /\ UNCHANGED <<lateKill, worktree, up, inFlight>>

\* The provider confirms the interrupt; or Force stop kills the agent scope
\* (ThreadManagementService.forceStopThread :1306). Both end run and turn.
InterruptLands(r) ==
  /\ up /\ Tick /\ stopAsked[r] /\ status[r] = "running" /\ turn[r] = "Live"
  /\ End(r, "interrupted")
  /\ turn' = [turn EXCEPT ![r] = "Done"]
  /\ stopAsked' = [stopAsked EXCEPT ![r] = FALSE]
  /\ UNCHANGED <<lateKill, worktree, up, inFlight>>

\* Manual continuation: dispatchMessage guard (:7146-7165), "Resumed thread".
Resume(src, r) ==
  /\ up /\ r # First /\ status[r] = "none"
  /\ \A s \in Runs : s < r => status[s] # "none"
  /\ status[src] \in {"interrupted", "usage_limited"}
  /\ IsLatest(src)
  /\ status' = [status EXCEPT ![r] = "starting"]
  /\ UNCHANGED <<ended, endedAt, turn, stopAsked, lateKill, worktree, up, clock, inFlight>>

\* dispatchPreparedRunRetry (:12496): failed setup run -> preparing.
RetrySetup(r) ==
  /\ up /\ r = First /\ status[r] = "failed"
  /\ ActiveRuns = {}
  /\ FixRetry => IsLatest(r)
  /\ status' = [status EXCEPT ![r] = "preparing"]
  /\ UNCHANGED <<ended, endedAt, turn, stopAsked, lateKill, worktree, up, clock, inFlight>>

Crash ==
  /\ up
  /\ up' = FALSE
  \* no provider process survives the server
  /\ turn' = [r \in Runs |-> IF turn[r] = "Live" THEN "Done" ELSE turn[r]]
  /\ lateKill' = [r \in Runs |-> FALSE]
  /\ inFlight' = [r \in Runs |-> FALSE]
  /\ UNCHANGED <<status, ended, endedAt, stopAsked, worktree, clock>>

\* reconcile("startup"): every unfinished run ends interrupted, in one commit.
Restart ==
  /\ ~up /\ Tick
  /\ up' = TRUE
  /\ status' = [r \in Runs |-> IF status[r] \in Active THEN "interrupted" ELSE status[r]]
  /\ ended' = [r \in Runs |-> IF status[r] \in Active THEN ended[r] + 1 ELSE ended[r]]
  /\ endedAt' = [r \in Runs |-> IF status[r] \in Active THEN clock ELSE endedAt[r]]
  /\ stopAsked' = [r \in Runs |-> FALSE]
  /\ clock' = clock + 1
  /\ UNCHANGED <<turn, lateKill, worktree, inFlight>>

Next ==
  \/ \E r \in Runs :
       \/ SetupFails(r) \/ SetupSucceeds(r) \/ Send(r) \/ StartQueued(r)
       \/ MarkRunning(r) \/ ProviderAccepts(r) \/ LateKillLands(r)
       \/ ProviderCompletes(r) \/ ProviderHitsUsageLimit(r) \/ Stop(r)
       \/ InterruptLands(r) \/ RetrySetup(r)
       \/ \E s \in Runs : Resume(s, r)
  \/ ChooseWorkspace \/ Crash \/ Restart

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* I1: a run's terminal state is final. The one designed exception is Retry of
\* the standing setup failure: the latest executed run, with no worktree yet
\* (orchestrationV2WorktreePending, orchestrationV2ThreadError.ts:79).
StandingSetupFailure(r) == r = First /\ status[r] = "failed" /\ IsLatest(r)
TerminalStays ==
  [][\A r \in Runs : (status[r] \in Terminal /\ status'[r] \notin Terminal)
                       => StandingSetupFailure(r)]_vars

\* I1 as a state count: only a standing setup failure is ever retried, so a run
\* other than run 1 ends at most once.
EndsOnce == \A r \in Runs \ {First} : ended[r] <= 1

\* I2: at most one run of a thread is active.
OneActive == Cardinality(ActiveRuns) <= 1

\* I3: at most one provider turn of the thread is live (a resume never runs two).
OneLiveTurn == Cardinality({r \in Runs : turn[r] = "Live"}) <= 1

\* I4: a terminal run keeps a provider turn alive only while its late kill is in flight.
NoOrphanTurn == \A r \in Runs : (turn[r] = "Live" /\ status[r] \in Terminal) => lateKill[r]
=============================================================================
