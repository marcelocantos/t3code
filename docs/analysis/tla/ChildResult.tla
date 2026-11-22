----------------------------- MODULE ChildResult -----------------------------
(* One app-owned delegated child and its parent, across server crashes.
   Invariant I5: a child's result reaches its parent.

   - The child's terminal run.updated commits; the in-memory reaction
     handleRunUpdate -> finalizeAppOwnedSubagent (Orchestrator.ts:16261-16330)
     is lost on a crash.
   - finalizeAppOwnedSubagentTask writes the task result, the subagent_result
     context transfer and the parent's delivery plan in one commit
     (Orchestrator.ts:15083); the offer that wakes the parent is in memory.
   - finalizeAppOwnedSubagent skips a task that already has a result and a
     transfer (openTasks, Orchestrator.ts ~14700).
   - Startup: reconcile ends an active child run (ProviderRuntimeRecoveryService);
     recoverDelegatedTasks then runs the subagent-results and
     delegated-completions sweeps (ProjectionStore.ts:5091-5127).
   - AllowRevive = TRUE adds defect D1: Retry revives the child's failed setup
     run after its result was delivered.                                     *)
EXTENDS Naturals

CONSTANTS MaxCrashes, AllowRevive

VARIABLES
  child,        \* "active" | "ended" | "revived"
  ends,         \* how many times the child's run has ended
  resultOf,     \* which end the parent's stored result reflects (0 = none)
  delivery,     \* "none" | "planned" | "delivered" (the parent's wake)
  reaction,     \* in memory: finalize owed for the latest end
  offer,        \* in memory: the planned delivery has not been offered yet
  sweepResults, \* startup sweep subagent-results still to run
  sweepDeliver, \* startup sweep delegated-completions still to run
  up, crashes

vars == <<child, ends, resultOf, delivery, reaction, offer, sweepResults, sweepDeliver, up, crashes>>

Init ==
  /\ child = "active" /\ ends = 0 /\ resultOf = 0 /\ delivery = "none"
  /\ reaction = FALSE /\ offer = FALSE
  /\ sweepResults = FALSE /\ sweepDeliver = FALSE
  /\ up = TRUE /\ crashes = 0

ChildEnds ==
  /\ up /\ child \in {"active", "revived"}
  /\ child' = "ended" /\ ends' = ends + 1 /\ reaction' = TRUE
  /\ UNCHANGED <<resultOf, delivery, offer, sweepResults, sweepDeliver, up, crashes>>

\* The finalize body, shared by the reaction and the subagent-results sweep.
Finalize ==
  IF resultOf = 0
    THEN /\ resultOf' = ends /\ delivery' = "planned" /\ offer' = TRUE
    ELSE UNCHANGED <<resultOf, delivery, offer>>   \* openTasks skips the task

React ==
  /\ up /\ reaction /\ child = "ended"
  /\ Finalize /\ reaction' = FALSE
  /\ UNCHANGED <<child, ends, sweepResults, sweepDeliver, up, crashes>>

\* SQL arms: requested run terminal and result NULL; or latest run terminal and no transfer.
SweepResults ==
  /\ up /\ sweepResults
  /\ IF child = "ended" /\ resultOf = 0 THEN Finalize ELSE UNCHANGED <<resultOf, delivery, offer>>
  /\ sweepResults' = FALSE
  /\ UNCHANGED <<child, ends, reaction, sweepDeliver, up, crashes>>

SweepDeliver ==
  /\ up /\ sweepDeliver /\ ~sweepResults
  /\ delivery' = IF delivery = "planned" THEN "delivered" ELSE delivery
  /\ sweepDeliver' = FALSE
  /\ UNCHANGED <<child, ends, resultOf, reaction, offer, sweepResults, up, crashes>>

Offer ==
  /\ up /\ offer /\ delivery = "planned"
  /\ delivery' = "delivered" /\ offer' = FALSE
  /\ UNCHANGED <<child, ends, resultOf, reaction, sweepResults, sweepDeliver, up, crashes>>

Revive ==
  /\ AllowRevive /\ up /\ child = "ended" /\ resultOf > 0 /\ ends < 2
  /\ child' = "revived"
  /\ UNCHANGED <<ends, resultOf, delivery, reaction, offer, sweepResults, sweepDeliver, up, crashes>>

Crash ==
  /\ up /\ crashes < MaxCrashes
  /\ up' = FALSE /\ crashes' = crashes + 1
  /\ reaction' = FALSE /\ offer' = FALSE
  /\ UNCHANGED <<child, ends, resultOf, delivery, sweepResults, sweepDeliver>>

\* reconcile ends an active child run (no reaction: the streams start after it);
\* the sweeps run after reconcile.
Restart ==
  /\ ~up
  /\ up' = TRUE
  /\ IF child \in {"active", "revived"}
       THEN child' = "ended" /\ ends' = ends + 1
       ELSE UNCHANGED <<child, ends>>
  /\ sweepResults' = TRUE /\ sweepDeliver' = TRUE
  /\ UNCHANGED <<resultOf, delivery, reaction, offer, crashes>>

Next == ChildEnds \/ React \/ SweepResults \/ SweepDeliver \/ Offer \/ Revive \/ Crash \/ Restart

Spec == Init /\ [][Next]_vars

Quiescent ==
  /\ up /\ child = "ended" /\ ~reaction /\ ~offer /\ ~sweepResults /\ ~sweepDeliver

\* I5: once nothing is left to run, the parent has been woken with the child's latest end.
ParentHearsLatestEnd == Quiescent => (delivery = "delivered" /\ resultOf = ends)
==============================================================================
