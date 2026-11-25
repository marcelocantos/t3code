import { describe, expect, it } from "vite-plus/test";

import { parseBuildEdition } from "./build-edition.ts";

describe("build edition", () => {
  it.each([
    { value: undefined, expected: "standard" },
    { value: "", expected: "standard" },
    { value: "standard", expected: "standard" },
    { value: " corporate ", expected: "corporate" },
  ])("selects $expected for $value", ({ value, expected }) => {
    expect(parseBuildEdition(value)).toBe(expected);
  });

  it.each(["corp", "false", "0", "Corporate"])(
    "refuses an unrecognised edition instead of silently building standard (%s)",
    (value) => {
      expect(() => parseBuildEdition(value)).toThrow();
    },
  );
});
