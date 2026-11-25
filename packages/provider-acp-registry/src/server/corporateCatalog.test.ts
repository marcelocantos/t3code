import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { AcpRegistrySettings } from "../settings.ts";
import { makeAcpRegistryCatalog } from "./AcpRegistrySupport.ts";

vi.mock("@t3tools/shared/buildEdition", () => ({ corporateBuild: true }));
const decodeSettings = Schema.decodeEffect(AcpRegistrySettings);

it.effect("corporate ACP starts local harnesses without registry, installer or HTTP services", () =>
  Effect.gen(function* () {
    const catalog = yield* makeAcpRegistryCatalog({
      cacheDir: "/unused",
      toolsDir: "/unused/tools",
    }).pipe(
      Effect.provideService(SpawnExecutableResolution, (command) =>
        command === "agent" ? "/independent/agent" : undefined,
      ),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, { PATH: "/independent" }),
      (effect) =>
        Effect.provide(effect, Context.makeUnsafe<Effect.Services<typeof effect>>(new Map())),
    );
    expect(yield* catalog.search({ query: "cursor" })).toEqual({ agents: [] });
    const registry = yield* decodeSettings({ agentId: "cursor" });
    expect((yield* Effect.flip(catalog.prepare({ agentId: "cursor" }))).reason).toBe(
      "registry_unavailable",
    );
    expect((yield* Effect.flip(catalog.resolve(registry, "/workspace"))).reason).toBe(
      "registry_unavailable",
    );
    expect((yield* Effect.flip(catalog.inspect(registry))).reason).toBe("registry_unavailable");
    const local = yield* decodeSettings({
      source: "local",
      commandPath: "agent",
      commandArgs: ["acp"],
    });
    expect(yield* catalog.inspect(local)).toMatchObject({ status: "ready", distribution: "local" });
    expect(yield* catalog.resolve(local, "/workspace")).toEqual({
      distribution: "local",
      spawn: {
        command: "/independent/agent",
        args: ["acp"],
        cwd: "/workspace",
        env: { PATH: "/independent" },
        shell: false,
      },
    });
  }).pipe(Effect.scoped),
);
