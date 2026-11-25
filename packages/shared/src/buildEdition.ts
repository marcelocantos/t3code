declare const __T3CODE_BUILD_EDITION__: "standard" | "corporate" | undefined;

export const corporateBuild =
  typeof __T3CODE_BUILD_EDITION__ !== "undefined" && __T3CODE_BUILD_EDITION__ === "corporate";
