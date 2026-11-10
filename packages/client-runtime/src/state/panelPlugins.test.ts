// @effect-diagnostics globalDate:off - Fixtures are local calendar days.
import { describe, expect, it } from "vite-plus/test";
import { pluginDateChoices, toCalendarDate } from "./panelPlugins.ts";

describe("pluginDateChoices", () => {
  it.each([
    // Tuesday 10 Nov 2026: tomorrow Wed, the day after is Thursday, next week Mon 16.
    [new Date(2026, 10, 10, 23, 30), ["2026-11-11", "2026-11-12", "2026-11-16"], "Thursday"],
    // Sunday: next week is the following day, Monday.
    [new Date(2026, 10, 15, 9), ["2026-11-16", "2026-11-17", "2026-11-16"], "Tuesday"],
    // Monday: next week is a full week away, not today.
    [new Date(2026, 10, 16, 0, 5), ["2026-11-17", "2026-11-18", "2026-11-23"], "Wednesday"],
    // Month and year rollover stay in the local calendar.
    [new Date(2026, 11, 31, 22), ["2027-01-01", "2027-01-02", "2027-01-04"], "Saturday"],
  ])("resolves shortcuts from %s", (now, values, dayAfterLabel) => {
    const choices = pluginDateChoices(now, "en-AU");
    expect(choices.map((choice) => choice.value)).toEqual(values);
    expect(choices[1]?.label).toBe(dayAfterLabel);
  });

  it("formats local dates without a UTC shift", () => {
    expect(toCalendarDate(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });
});
