import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    T3CODE_PLUGIN_BUILD: process.env.T3CODE_PLUGIN_BUILD,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined, pluginBuild?: string) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  vi.stubEnv("T3CODE_PLUGIN_BUILD", pluginBuild);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
  if (value !== "development") {
    expect(config.icon).not.toContain("blueprint");
  }
});

it("gives the plugin build its own identity beside the official app", async () => {
  const config = await loadConfig("production", "1");
  const identifier = "com.marcelocantos.t3code.plugins";
  expect(config.name).toBe("T3 Code Plugins");
  expect(config.scheme).toBe("t3code-plugins");
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  expect(config.ios?.appleTeamId).not.toBe("ARK85ZXQ4Z");
  // The fork wears the blueprint icon, not the production black one.
  expect(config.icon).toBe("../../assets/dev/blueprint-ios-1024.png");
  expect(config.ios?.icon).toBe("../../assets/dev/app-icon.icon");
  expect(config.android?.adaptiveIcon?.backgroundColor).toBe("#347FF8");
  // A Personal Team cannot claim T3's domains, and upstream's OTA bundle lacks the panel renderers.
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.updates?.enabled).toBe(false);
  expect(config.extra?.iosPersonalTeamBuild).toBe(true);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs.join()).not.toContain(identifier);
});

it("rejects the in-place upgrade mode, which only the desktop can sign", async () => {
  await expect(loadConfig("production", "upgrade")).rejects.toThrow("no mobile build");
});
