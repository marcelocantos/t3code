import { describe, expect, it } from "vite-plus/test";

import type { PluginPanelSnapshot } from "@t3tools/contracts";

import {
  applyReplacedThreadDetailsItems,
  replacedThreadDetailsItems,
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const usage = THREAD_DETAILS_ITEMS.find((item) => item.id === "usage")!;
const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;

describe("thread details items", () => {
  it.each([
    { legacy: false, items: {}, usage: false, context: false },
    { legacy: true, items: {}, usage: true, context: true },
    { legacy: true, items: { usage: false }, usage: false, context: true },
    { legacy: false, items: { usage: true, retired: false }, usage: true, context: false },
  ])("resolves Usage and Context from overrides and the retired Labs flag: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({
      threadDetailsItems: row.items,
      threadDetailsUsageEnabled: row.legacy,
    });
    expect(visibility.usage).toBe(row.usage);
    expect(visibility.context).toBe(row.context);
    expect(visibility.servers).toBe(true);
  });

  it("stores only choices that differ from the default", () => {
    const legacyOn = { threadDetailsItems: {}, threadDetailsUsageEnabled: true };
    expect(setThreadDetailsItem(legacyOn, usage, false)).toEqual({ usage: false });
    expect(setThreadDetailsItem(legacyOn, usage, true)).toEqual({});

    const hidden = { threadDetailsItems: { servers: false }, threadDetailsUsageEnabled: false };
    expect(setThreadDetailsItem(hidden, servers, true)).toEqual({});
  });

  it.each([
    { status: "connected", supersedes: ["usage", "unknown"], usage: false, kept: true },
    { status: "error", supersedes: ["usage"], usage: true, kept: true },
    { status: "connected", supersedes: undefined, usage: true, kept: true },
  ] as const)("a plugin panel replaces built-in items only while connected: %o", (row) => {
    const snapshot: PluginPanelSnapshot = {
      pluginId: "jevons",
      status: row.status,
      panels: [
        {
          kind: "web",
          id: "usage",
          title: "Jevons usage",
          path: "/usage",
          ...(row.supersedes ? { supersedes: row.supersedes } : {}),
        },
      ],
    };
    const replaced = replacedThreadDetailsItems([snapshot]);
    expect([...replaced.keys()]).toEqual(row.usage ? [] : ["usage"]);

    const chosen = resolveThreadDetailsVisibility({
      threadDetailsItems: { usage: true },
      threadDetailsUsageEnabled: false,
    });
    expect(applyReplacedThreadDetailsItems(chosen, replaced, []).usage).toBe(row.usage);
    expect(applyReplacedThreadDetailsItems(chosen, replaced, ["usage"]).usage).toBe(row.kept);
    expect(applyReplacedThreadDetailsItems(chosen, replaced, []).servers).toBe(true);
  });
});
