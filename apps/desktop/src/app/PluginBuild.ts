// Set at build time from T3CODE_PLUGIN_BUILD (see scripts/lib/plugin-build-mode.ts).
declare const __T3CODE_PLUGIN_BUILD__: "off" | "parallel" | "upgrade";

const mode = typeof __T3CODE_PLUGIN_BUILD__ === "undefined" ? "off" : __T3CODE_PLUGIN_BUILD__;

// Parallel installs beside the official app, so it gets its own name, data and browser profile.
export const isPluginBuild = mode === "parallel";

// Upgrade replaces the official app and keeps its identity and state. It must never self-update,
// because an official release would silently replace the fork.
export const isUpgradePluginBuild = mode === "upgrade";
