import { MessageId, RunId, type PluginAction } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parsePluginCalendarDate, pluginAgentRunState, pluginRowMenu } from "./pluginRowMenu";

const actions: ReadonlyArray<PluginAction> = [
  { kind: "agent", id: "work", label: "Work on it", prompt: "Do the thing" },
  { kind: "plugin", id: "done", label: "Done", tone: "danger", confirm: "Sure?" },
  { kind: "date", id: "due", label: "Due", value: "2026-11-12" },
  {
    kind: "menu",
    id: "more",
    label: "More",
    items: [
      { kind: "agent", id: "review", label: "Review", prompt: "Review it" },
      { kind: "surface", id: "info", label: "Info", surfaceId: "info-card" },
    ],
  },
  {
    kind: "menu",
    id: "agents",
    label: "Agents",
    items: [{ kind: "agent", id: "plan", label: "Plan", prompt: "Plan it" }],
  },
];

describe("pluginRowMenu", () => {
  const now = new Date(2026, 10, 10, 9);

  it("drops the primary action and resolves submenu entries to their action and value", () => {
    const menu = pluginRowMenu(actions, { primaryActionId: "work", agentActions: true, now });
    expect(menu.actions.map((action) => action.title)).toEqual(["Done", "Due", "More", "Agents"]);
    const due = menu.actions[1]!.subactions!;
    expect(due.map((entry) => entry.title)).toEqual([
      "Tomorrow",
      "Thursday",
      "Next week",
      "Custom…",
      "Clear",
    ]);
    // The set value is marked on its shortcut.
    expect(due[1]!.state).toBe("on");
    expect(menu.resolve(due[0]!.id!)).toEqual({
      kind: "run",
      action: actions[2],
      value: "2026-11-11",
    });
    expect(menu.resolve(due[3]!.id!)).toEqual({ kind: "custom-date", action: actions[2] });
    expect(menu.resolve(due[4]!.id!)).toEqual({ kind: "run", action: actions[2], value: null });
    const more = menu.actions[2]!.subactions!;
    expect(menu.resolve(more[1]!.id!)).toEqual({
      kind: "run",
      action: { kind: "surface", id: "info", label: "Info", surfaceId: "info-card" },
    });
  });

  it("leaves out agent actions, and menus left empty, where prompts cannot be sent", () => {
    const menu = pluginRowMenu(actions, { agentActions: false, now });
    expect(menu.actions.map((action) => action.title)).toEqual(["Done", "Due", "More"]);
    expect(menu.actions[2]!.subactions!.map((entry) => entry.title)).toEqual(["Info"]);
  });

  it("offers no clear choice for an unset date", () => {
    const menu = pluginRowMenu([{ kind: "date", id: "due", label: "Due" }], {
      agentActions: false,
      now,
    });
    expect(menu.actions[0]!.subactions!.map((entry) => entry.title)).not.toContain("Clear");
  });
});

describe("parsePluginCalendarDate", () => {
  it.each([
    [" 2026-02-28 ", "2026-02-28"],
    ["2028-02-29", "2028-02-29"],
    ["2026-02-29", null],
    ["2026-13-01", null],
    ["2026-1-01", null],
    ["tomorrow", null],
  ])("parses %j", (text, expected) => {
    expect(parsePluginCalendarDate(text)).toBe(expected);
  });
});

describe("pluginAgentRunState", () => {
  const sent = MessageId.make("sent");
  const runId = RunId.make("run-1");

  it("is idle until the row sends a prompt", () => {
    expect(
      pluginAgentRunState({ messageId: undefined, queuedMessageIds: new Set(), runs: [] }),
    ).toEqual({
      kind: "idle",
    });
  });

  it("follows the prompt from the outbox to its run and back to idle", () => {
    expect(
      pluginAgentRunState({ messageId: sent, queuedMessageIds: new Set([sent]), runs: [] }),
    ).toEqual({ kind: "sending" });
    expect(
      pluginAgentRunState({
        messageId: sent,
        queuedMessageIds: new Set(),
        runs: [
          { id: RunId.make("other"), userMessageId: MessageId.make("other"), status: "running" },
          { id: runId, userMessageId: sent, status: "queued" },
        ],
      }),
    ).toEqual({ kind: "active", runId });
    expect(
      pluginAgentRunState({
        messageId: sent,
        queuedMessageIds: new Set(),
        runs: [{ id: runId, userMessageId: sent, status: "interrupted" }],
      }),
    ).toEqual({ kind: "idle" });
  });

  it("does not treat another message's running turn as the row's", () => {
    expect(
      pluginAgentRunState({
        messageId: sent,
        queuedMessageIds: new Set(),
        runs: [{ id: runId, userMessageId: MessageId.make("other"), status: "running" }],
      }),
    ).toEqual({ kind: "idle" });
  });
});
