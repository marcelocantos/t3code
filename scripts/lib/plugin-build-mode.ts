export type PluginBuildMode = "off" | "parallel" | "upgrade";

/**
 * Reads `T3CODE_PLUGIN_BUILD`: unset is the upstream build, `1` is the fork installed beside the
 * official app, `upgrade` is the fork replacing the official app in place.
 */
export function parsePluginBuildMode(value: string | undefined): PluginBuildMode {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return "off";
  if (trimmed === "1") return "parallel";
  if (trimmed === "upgrade") return "upgrade";
  throw new Error(`T3CODE_PLUGIN_BUILD must be unset, "1" or "upgrade", got "${trimmed}".`);
}
