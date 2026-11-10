import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const loadBuild = (mode: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      vi.stubEnv("T3CODE_PLUGIN_BUILD", mode);
      vi.resetModules();
    }),
    () =>
      Effect.gen(function* () {
        const script = yield* Effect.promise(() => import("./build-desktop-artifact.ts"));
        const config = yield* script
          .createBuildConfig("mac", "dmg", "0.2.0", false, false, undefined, undefined)
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                ConfigProvider.layer(
                  ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "pingdotgg/t3code" } }),
                ),
              ),
            ),
          );
        return { config, productName: script.resolveDesktopProductName("0.2.0") };
      }),
    () =>
      Effect.sync(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
      }),
  );

describe("T3CODE_PLUGIN_BUILD packaging", () => {
  it.effect("keeps the official identity and publish feed when unset", () =>
    Effect.gen(function* () {
      const { config, productName } = yield* loadBuild("");
      assert.equal(config.appId, "com.t3tools.t3code");
      assert.equal(productName, "T3 Code (Beta)");
      assert.isNotNull(config.publish);
    }),
  );

  it.effect("installs beside the official app in parallel mode", () =>
    Effect.gen(function* () {
      const { config, productName } = yield* loadBuild("1");
      assert.equal(config.appId, "com.marcelocantos.t3code.plugins");
      assert.equal(productName, "T3 Code+");
      assert.isNull(config.publish);
    }),
  );

  it.effect("replaces the official app in upgrade mode without a publish feed", () =>
    Effect.gen(function* () {
      const { config, productName } = yield* loadBuild("upgrade");
      assert.equal(config.appId, "com.t3tools.t3code");
      assert.equal(productName, "T3 Code (Beta)");
      assert.isNull(config.publish);
    }),
  );
});
