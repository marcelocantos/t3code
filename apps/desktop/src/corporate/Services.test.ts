import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ssh from "../ssh/DesktopSshEnvironment.ts";
import * as Saved from "../settings/DesktopSavedEnvironments.ts";

vi.mock("@t3tools/shared/buildEdition", () => ({ corporateBuild: true }));

const withoutServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Context.makeUnsafe<R>(new Map()));

it.effect("refuses saved SSH targets without acquiring remote process services", () =>
  Effect.gen(function* () {
    const service = yield* Ssh.make.pipe(withoutServices);
    expect(yield* service.discoverHosts()).toEqual([]);
    const refused = yield* Effect.flip(service.resolveHost("saved-host"));
    expect(refused._tag).toBe("SshInvalidTargetError");
    const saved = yield* Saved.make.pipe(withoutServices);
    expect(yield* saved.getRegistry).toEqual([]);
    const secret = yield* saved.getSecret("saved-host");
    expect(secret._tag).toBe("None");
  }),
);
