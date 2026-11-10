import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type PluginDiscoveryItem } from "@t3tools/contracts";
import {
  describePluginDiscoveryItem,
  planPluginSurfacing,
  pluginDiscoveryChoices,
  pluginNeedsDecision,
  pluginSurfacingKey,
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

  it("asks before an enabled plugin widens to every project, at the approved endpoint", () => {
    const widened = item({ state: "enabled", pendingScopes: ["environment"] });
    expect(pluginNeedsDecision(widened)).toBe(true);
    expect(pluginDiscoveryChoices(widened).map((choice) => choice.input)).toEqual([
      { action: "enable", id: "example", baseUrl: "http://127.0.0.1:9/plugins/t3" },
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

describe("planPluginSurfacing", () => {
  const environmentId = EnvironmentId.make("env");
  const offered = item({});
  const moved = item({
    id: "moved",
    state: "enabled",
    discoveredBaseUrl: "http://127.0.0.1:10/plugins/t3",
  });
  const settled = item({ id: "settled", state: "enabled" });
  const plan = (overrides: Partial<Parameters<typeof planPluginSurfacing>[0]>) =>
    planPluginSurfacing({
      environmentId,
      items: [offered, moved, settled],
      surfaced: new Set(),
      canDecide: true,
      startupDone: false,
      navigated: false,
      ...overrides,
    });

  it("opens settings once at startup for decisions this client has not shown", () => {
    expect(plan({})).toEqual({
      navigate: true,
      announce: [],
      record: [
        pluginSurfacingKey(environmentId, offered),
        pluginSurfacingKey(environmentId, moved),
      ],
    });
    // A second environment at startup records without navigating again.
    expect(plan({ navigated: true }).navigate).toBe(false);
  });

  it("announces later discoveries and skips what it already surfaced", () => {
    const result = plan({
      startupDone: true,
      surfaced: new Set([pluginSurfacingKey(environmentId, offered)]),
    });
    expect(result).toEqual({
      navigate: false,
      announce: [moved],
      record: [pluginSurfacingKey(environmentId, moved)],
    });
  });

  it("surfaces a known plugin again when its endpoint or requested scopes change", () => {
    const surfaced = new Set([pluginSurfacingKey(environmentId, offered)]);
    const elsewhere = { ...offered, baseUrl: "http://127.0.0.1:11/plugins/t3" };
    expect(plan({ items: [elsewhere], surfaced, startupDone: true }).announce).toEqual([elsewhere]);
    const widened = {
      ...offered,
      state: "enabled" as const,
      pendingScopes: ["environment" as const],
    };
    expect(plan({ items: [widened], surfaced, startupDone: true }).announce).toEqual([widened]);
  });

  it("surfaces nothing to clients that cannot decide", () => {
    expect(plan({ canDecide: false })).toEqual({ navigate: false, announce: [], record: [] });
  });
});
