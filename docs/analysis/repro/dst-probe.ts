// DST probe for nextScheduledRunAt (invariant I6). Run from apps/server:
//   cp ../../docs/analysis/repro/dst-probe.ts src/__dst_probe.ts && TZ=Australia/Sydney node src/__dst_probe.ts; rm src/__dst_probe.ts
// Observed on 64d67164a6:
//   day before 2026-04-04T09:00:00.000Z -> 2026-04-04T15:30:00.000Z
//   after first 02:30 +1m 2026-04-04T15:31:00.000Z -> 2026-04-05T16:30:00.000Z
//   after second 02:30 +1m 2026-04-04T16:31:00.000Z -> 2026-04-05T16:30:00.000Z
//   spring 2026-10-03T09:00:00Z -> 2026-10-03T16:30:00.000Z
//   spring 2026-10-03T16:31:00Z -> 2026-10-04T15:30:00.000Z
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { nextScheduledRunAt } from "./scheduledTasks/Schedule.ts";
const prog = Effect.gen(function* () {
  const zone = DateTime.zoneMakeLocal();
  const firstUtc = DateTime.makeUnsafe("2026-04-04T15:30:00Z"); // 02:30 AEDT (+11)
  const secondUtc = DateTime.makeUnsafe("2026-04-04T16:30:00Z"); // 02:30 AEST (+10)
  const sched = { type: "fixed_time", timeOfDay: "02:30" } as const;
  for (const [label, at] of [
    ["day before", DateTime.makeUnsafe("2026-04-04T09:00:00Z")],
    ["after first 02:30 +1m", DateTime.add(firstUtc, { minutes: 1 })],
    ["after second 02:30 +1m", DateTime.add(secondUtc, { minutes: 1 })],
  ] as const) {
    const from = DateTime.makeZonedUnsafe(at, { timeZone: zone });
    const next = nextScheduledRunAt(sched as never, from);
    console.log(label, DateTime.formatIso(DateTime.toUtc(from)), "->", next && DateTime.formatIso(DateTime.toUtc(next)));
  }
  for (const at of ["2026-10-03T09:00:00Z", "2026-10-03T16:31:00Z"]) {
    const from = DateTime.makeZonedUnsafe(DateTime.makeUnsafe(at), { timeZone: zone });
    const next = nextScheduledRunAt(sched as never, from);
    console.log("spring", at, "->", next && DateTime.formatIso(DateTime.toUtc(next)));
  }
});
Effect.runSync(prog);
