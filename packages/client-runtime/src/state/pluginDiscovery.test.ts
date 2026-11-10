import { describe, expect, it } from "vite-plus/test";
import type { PluginDiscoveryItem } from "@t3tools/contracts";
import {
  describePluginDiscoveryItem,
  pluginDiscoveryChoices,
  pluginNeedsDecision,
} from "./pluginDiscovery.ts";

const item = (overrides: Partial<PluginDiscoveryItem>): PluginDiscoveryItem => ({
  id: "example",
  name: "Example",
  state: "offered",
  baseUrl: "http://127.0.0.1:9/plugins/t3",
  live: true,
  ...overrides,
});

describe("plugin discovery choices", () => {
  it("offers consent for the endpoint shown, never another", () => {
    const offered = item({});
    expect(pluginNeedsDecision(offered)).toBe(true);
    expect(pluginDiscoveryChoices(offered).map((choice) => choice.input)).toEqual([
      { action: "enable", id: "example", baseUrl: "http://127.0.0.1:9/plugins/t3" },
      { action: "dismiss", id: "example" },
    ]);
    expect(describePluginDiscoveryItem(offered)).toContain("127.0.0.1:9");
  });

  it("asks again before following an enabled plugin to a new endpoint", () => {
    const moved = item({ state: "enabled", discoveredBaseUrl: "http://127.0.0.1:10/plugins/t3" });
    expect(pluginNeedsDecision(moved)).toBe(true);
    expect(pluginDiscoveryChoices(moved).map((choice) => choice.input)).toEqual([
      { action: "enable", id: "example", baseUrl: "http://127.0.0.1:10/plugins/t3" },
      { action: "dismiss", id: "example" },
      { action: "disable", id: "example" },
    ]);
  });

  it("lets each declined plugin be re-enabled or reset", () => {
    expect(pluginNeedsDecision(item({ state: "disabled", live: false }))).toBe(false);
    expect(
      pluginDiscoveryChoices(item({ state: "disabled", live: false })).map(
        (choice) => choice.input.action,
      ),
    ).toEqual(["enable", "reset"]);
    // A dismissed plugin can only be enabled while a service is actually there to consent to.
    expect(
      pluginDiscoveryChoices(item({ state: "dismissed", live: false, baseUrl: undefined })).map(
        (choice) => choice.input.action,
      ),
    ).toEqual(["reset"]);
    expect(
      pluginDiscoveryChoices(item({ state: "dismissed" })).map((choice) => choice.input.action),
    ).toEqual(["enable", "reset"]);
    expect(pluginDiscoveryChoices(item({ state: "manual" }))).toEqual([]);
  });
});
