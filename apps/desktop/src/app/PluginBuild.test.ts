import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";

// The mode is a build-time constant, so each case re-imports the modules under a stubbed value.
const withMode = <A, E, R>(mode: string | undefined, run: () => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      if (mode !== undefined) vi.stubGlobal("__T3CODE_PLUGIN_BUILD__", mode);
      vi.resetModules();
    }),
    run,
    () =>
      Effect.sync(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
      }),
  );

const resolvePaths = (mode: string | undefined) =>
  withMode(mode, () =>
    Effect.gen(function* () {
      const { resolveDesktopBaseDir } = yield* Effect.promise(
        () => import("./DesktopStatePaths.ts"),
      );
      const { resolveUserDataPath } = yield* Effect.promise(() => import("./DesktopUserData.ts"));
      const { isPluginBuild, isUpgradePluginBuild } = yield* Effect.promise(
        () => import("./PluginBuild.ts"),
      );
      const input = {
        homeDirectory: "/Users/example",
        joinPath: (...segments: string[]) => segments.join("/"),
        t3Home: Option.none<string>(),
      };
      const profile = yield* resolveUserDataPath({
        appDataDirectory: "/tmp/application-support",
        isDevelopment: false,
        platform: "darwin",
      }).pipe(Effect.provide(NodeServices.layer));
      return {
        baseDir: resolveDesktopBaseDir(input),
        customBaseDir: resolveDesktopBaseDir({ ...input, t3Home: Option.some("/tmp/custom") }),
        profile,
        flags: { isPluginBuild, isUpgradePluginBuild },
      };
    }),
  );

it.effect("keeps upstream paths when the build mode is unset", () =>
  Effect.gen(function* () {
    const paths = yield* resolvePaths(undefined);
    expect(paths.baseDir).toBe("/Users/example/.t3");
    expect(paths.profile).toBe("/tmp/application-support/t3code-v2");
    expect(paths.flags).toEqual({ isPluginBuild: false, isUpgradePluginBuild: false });
  }),
);

it.effect("isolates parallel plugin build data and browser profiles from the official app", () =>
  Effect.gen(function* () {
    const paths = yield* resolvePaths("parallel");
    expect(paths.baseDir).toBe("/Users/example/.t3-plugins");
    expect(paths.customBaseDir).toBe("/tmp/custom");
    expect(paths.profile).toBe("/tmp/application-support/t3code-plugins");
    expect(paths.flags).toEqual({ isPluginBuild: true, isUpgradePluginBuild: false });
  }),
);

it.effect("upgrade build reuses the official data and browser profile", () =>
  Effect.gen(function* () {
    const paths = yield* resolvePaths("upgrade");
    expect(paths.baseDir).toBe("/Users/example/.t3");
    expect(paths.profile).toBe("/tmp/application-support/t3code-v2");
    expect(paths.flags).toEqual({ isPluginBuild: false, isUpgradePluginBuild: true });
  }),
);

const configureUpdates = (mode: string | undefined) =>
  withMode(mode, () =>
    Effect.gen(function* () {
      const { makeHarness } = yield* Effect.promise(
        () => import("../updates/updatesTestHarness.ts"),
      );
      const DesktopUpdates = yield* Effect.promise(() => import("../updates/DesktopUpdates.ts"));
      const DesktopUpdatePolicy = yield* Effect.promise(
        () => import("../updates/DesktopUpdatePolicy.ts"),
      );
      const harness = makeHarness({
        policy: {
          ...DesktopUpdatePolicy.unmanagedUpdatePolicy,
          feedUrl: "https://updates.example.com/t3code",
        },
      });
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const checked = yield* updates.check("menu");
          return { state: yield* updates.getState, checked: checked.checked };
        }),
      ).pipe(Effect.provide(harness.layer));
      return { ...result, feedUrls: harness.feedUrls(), checkCount: harness.checkCount() };
    }),
  );

it.effect("upstream build configures the update feed it is given", () =>
  Effect.gen(function* () {
    const upstream = yield* configureUpdates(undefined);
    expect(upstream.state.enabled).toBe(true);
    expect(upstream.feedUrls).toHaveLength(1);
  }),
);

it.effect("upgrade build never configures an update feed, even when one is available", () =>
  Effect.gen(function* () {
    const upgrade = yield* configureUpdates("upgrade");
    expect(upgrade.state.status).toBe("disabled");
    expect(upgrade.state.enabled).toBe(false);
    expect(upgrade.state.message).toMatch(/plugin-panels build/);
    expect(upgrade.checked).toBe(false);
    expect(upgrade.feedUrls).toEqual([]);
    expect(upgrade.checkCount).toBe(0);
  }),
);
