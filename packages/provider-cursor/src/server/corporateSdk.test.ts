import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CursorSdk from "./CursorSdk.ts";
import * as Runner from "./CursorAgentSdk.ts";
import { loadCursorSdk, loadCursorSqlite } from "./sdk.ts";

vi.mock("@t3tools/shared/buildEdition", () => ({ corporateBuild: true }));
const withoutServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Context.makeUnsafe<R>(new Map())));

it.effect("corporate startup cannot load or start the in-process Cursor SDK", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(CursorSdk.layer).pipe(withoutServices);
    const sdk = Context.get(context, CursorSdk.CursorSdk);
    expect(loadCursorSdk).toThrow("independent Cursor ACP CLI");
    expect(loadCursorSqlite).toThrow("excluded from the corporate build");
    expect(sdk.load).toThrow("independent Cursor ACP CLI");
    expect(sdk.loadSqlite).toThrow("independent Cursor ACP CLI");
    const runner = yield* Runner.makeCursorAgentSdkRunner(() => undefined).pipe(withoutServices);
    const error = yield* Effect.flip(
      runner.open({
        operation: "create",
        options: {},
        threadId: ThreadId.make("corporate"),
        providerSessionId: ProviderSessionId.make("corporate"),
      }),
    );
    expect(error.method).toBe("open");
    expect(error.cause).toEqual(
      new Error("Use the independent Cursor ACP CLI in the corporate build."),
    );
  }).pipe(Effect.scoped),
);
