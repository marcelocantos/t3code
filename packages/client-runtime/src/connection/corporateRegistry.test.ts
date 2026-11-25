import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";

import * as Persistence from "../platform/persistence.ts";
import * as Capabilities from "../platform/capabilities.ts";
import * as Profiles from "./profileStore.ts";
import * as Credentials from "./credentialStore.ts";
import * as Connectivity from "./connectivity.ts";
import * as Driver from "./driver.ts";
import * as Wakeups from "./wakeups.ts";
import * as Registry from "./registry.ts";
import { PrimaryConnectionTarget, RelayConnectionTarget } from "./model.ts";
import { PrimaryConnectionRegistration, RelayConnectionRegistration } from "./catalog.ts";

vi.mock("@t3tools/shared/buildEdition", () => ({ corporateBuild: true }));

const corporateRegistry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Scope.Scope>();
    const services = new Map(context.mapUnsafe);
    for (const key of [
      Persistence.ConnectionTargetStore,
      Persistence.ConnectionRegistrationStore,
      Persistence.EnvironmentCacheStore,
      Persistence.EnvironmentOwnedDataCleanup,
      Profiles.ConnectionProfileStore,
      Credentials.ConnectionCredentialStore,
      Driver.ConnectionDriver,
      Wakeups.ConnectionWakeups,
      Capabilities.SshEnvironmentGateway,
    ]) {
      services.set(key.key, {});
    }
    services.set(Connectivity.Connectivity.key, {
      status: Effect.succeed("online"),
      changes: Stream.empty,
    });
    services.set(Wakeups.ConnectionWakeups.key, { changes: Stream.empty });
    return yield* effect.pipe(Effect.provide(Context.makeUnsafe<R>(services)));
  });

it.effect(
  "ignores persisted remote routes and refuses new ones while retaining the local primary",
  () =>
    Effect.gen(function* () {
      // Empty stores fail if startup tries to read saved routes, profiles or credentials.
      const registry = yield* corporateRegistry(Registry.make);
      expect((yield* SubscriptionRef.get(registry.entries)).size).toBe(0);
      const remote = new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: EnvironmentId.make("saved-remote"),
          label: "Saved remote",
        }),
      });
      const refused = yield* Effect.flip(registry.register(remote));
      expect(refused).toMatchObject({ _tag: "ConnectionBlockedError", reason: "permission" });
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make("local"),
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      });
      yield* registry.reconcilePlatform([
        new PrimaryConnectionRegistration({ target }),
        new PrimaryConnectionRegistration({
          target: new PrimaryConnectionTarget({
            ...target,
            environmentId: remote.target.environmentId,
            httpBaseUrl: "https://example.invalid",
            wsBaseUrl: "wss://example.invalid",
          }),
        }),
      ]);
      const entries = yield* SubscriptionRef.get(registry.entries);
      expect([...entries.keys()]).toEqual([target.environmentId]);
      expect(entries.get(target.environmentId)?.target).toEqual(target);
    }).pipe(Effect.scoped),
);
