declare const __T3CODE_PLUGIN_BUILD__: boolean;

// A build-time switch keeps the fork's profiles isolated without changing upstream defaults.
export const isPluginBuild =
  typeof __T3CODE_PLUGIN_BUILD__ !== "undefined" && __T3CODE_PLUGIN_BUILD__;
