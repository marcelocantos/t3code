import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";

it.effect("isolates plugin build data and browser profiles from the official app", () =>
  Effect.gen(function* () {
    vi.stubGlobal("__T3CODE_PLUGIN_BUILD__", true);
    vi.resetModules();
    try {
      const { resolveDesktopBaseDir } = yield* Effect.promise(
        () => import("./DesktopStatePaths.ts"),
      );
      const { resolveUserDataPath } = yield* Effect.promise(() => import("./DesktopUserData.ts"));
      const input = {
        homeDirectory: "/Users/example",
        joinPath: (...segments: string[]) => segments.join("/"),
        t3Home: Option.none<string>(),
      };
      expect(resolveDesktopBaseDir(input)).toBe("/Users/example/.t3-plugins");
      expect(resolveDesktopBaseDir({ ...input, t3Home: Option.some("/tmp/custom") })).toBe(
        "/tmp/custom",
      );
      const profile = yield* resolveUserDataPath({
        appDataDirectory: "/tmp/application-support",
        isDevelopment: false,
        platform: "darwin",
      }).pipe(Effect.provide(NodeServices.layer));
      expect(profile).toBe("/tmp/application-support/t3code-plugins");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  }),
);
