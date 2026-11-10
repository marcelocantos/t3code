import { assert, describe, it } from "@effect/vitest";

import { parsePluginBuildMode } from "./plugin-build-mode.ts";

describe("parsePluginBuildMode", () => {
  it("maps the environment value to a build mode", () => {
    assert.equal(parsePluginBuildMode(undefined), "off");
    assert.equal(parsePluginBuildMode(" "), "off");
    assert.equal(parsePluginBuildMode("1"), "parallel");
    assert.equal(parsePluginBuildMode("upgrade"), "upgrade");
  });

  it("rejects anything else rather than silently building the wrong variant", () => {
    for (const value of ["0", "true", "Upgrade", "parallel"]) {
      assert.throws(() => parsePluginBuildMode(value), /T3CODE_PLUGIN_BUILD/);
    }
  });
});
