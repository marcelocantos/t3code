import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const loadBuild = (mode: string, signed = false) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      vi.stubEnv("T3CODE_PLUGIN_BUILD", mode);
      vi.resetModules();
    }),
    () =>
      Effect.gen(function* () {
        const script = yield* Effect.promise(() => import("./build-desktop-artifact.ts"));
        const config = yield* script
          .createBuildConfig("mac", "dmg", "0.2.0", signed, false, undefined, undefined)
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
      // Spotlight shows the localized name; the bundle name the state paths depend on is unchanged.
      assert.isTrue(
        (config.mac as { extendInfo: Record<string, unknown> }).extendInfo
          .LSHasLocalizedDisplayName,
      );
      assert.deepInclude(config.extraResources as ReadonlyArray<unknown>, {
        from: "apps/desktop/resources/upgrade/InfoPlist.strings",
        to: "en.lproj/InfoPlist.strings",
      });
    }),
  );

  it.effect("signs plugin builds with the hardened runtime and no provisioning profile", () =>
    Effect.gen(function* () {
      for (const mode of ["1", "upgrade"]) {
        const mac = (yield* loadBuild(mode, true)).config.mac as Record<string, unknown>;
        assert.isTrue(mac.hardenedRuntime);
        assert.match(String(mac.entitlements), /entitlements\.plugins\.mac\.plist$/);
        assert.equal(mac.entitlementsInherit, mac.entitlements);
        assert.isUndefined(mac.provisioningProfile);
      }
      const official = (yield* loadBuild("", true)).config.mac as Record<string, unknown>;
      assert.isUndefined(official.entitlements);
    }),
  );
});
