import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CloudLink from "../cloud/CloudLink.ts";
import * as Endpoint from "../cloud/ManagedEndpointRuntime.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as Relay from "../relay/AgentAwarenessRelay.ts";
import * as Analytics from "../telemetry/AnalyticsService.ts";
import { resolveRelayClientTracingConfig } from "../cloud/publicConfig.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderMaintenance from "../provider/providerMaintenanceRunner.ts";
import * as ProviderInstallation from "../provider/providerInstallation.ts";

vi.mock("@t3tools/shared/buildEdition", () => ({ corporateBuild: true }));

// A corporate constructor must work without acquiring the standard edition's network services.
const withoutServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Context.makeUnsafe<R>(new Map()));

it.effect(
  "corporate startup ignores persisted cloud state without acquiring cloud dependencies",
  () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(CloudLink.layer).pipe(withoutServices);
      const cloud = Context.get(context, CloudLink.CloudLink);
      expect(yield* cloud.linkState()).toEqual({
        linked: false,
        cloudUserId: null,
        relayUrl: null,
        relayIssuer: null,
        managedTunnelActive: false,
        publishAgentActivity: false,
        holdWebhooksWhileOffline: false,
      });
      expect(yield* cloud.unlink()).toEqual({
        ok: true,
        endpointRuntimeStatus: { status: "disabled" },
      });
      expect(yield* cloud.recoverManagedTunnel("http://127.0.0.1:3773")).toBe(false);
      expect(yield* cloud.startManagedTunnelIfOriginConfirmed("http://127.0.0.1:3773")).toBe(false);
      const endpoint = yield* Endpoint.make.pipe(withoutServices);
      expect(yield* endpoint.inspectConnector).toBe(null);
      expect(yield* endpoint.restartConnector(123, Effect.succeed(true))).toBe(false);
      const connector = yield* RelayClient.makeCloudflaredRelayClient({ baseDir: "/unused" }).pipe(
        withoutServices,
      );
      expect((yield* connector.resolve).status).toBe("missing");
      expect((yield* Effect.flip(connector.install)).reason).toBe("managed_by_policy");
    }).pipe(Effect.scoped),
);

it.effect("corporate startup performs no analytics, activity publishing or model refresh", () =>
  Effect.gen(function* () {
    const analytics = yield* Analytics.make.pipe(withoutServices);
    yield* analytics.flush;
    expect(
      resolveRelayClientTracingConfig({
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://collector.invalid/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "corporate",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "test-token",
      }),
    ).toBeNull();
    const relay = yield* Relay.make.pipe(withoutServices);
    yield* relay.start();
    yield* relay.drain;
    yield* relay.requestCatchUp();
    const manifest = yield* ModelManifest.make.pipe(withoutServices);
    expect(yield* manifest.current).toBe(ModelManifest.BUNDLED_MODEL_MANIFEST);
    expect(yield* manifest.forceRefresh).toBe(ModelManifest.BUNDLED_MODEL_MANIFEST);
    expect(yield* manifest.refreshOnDemand).toBe(ModelManifest.BUNDLED_MODEL_MANIFEST);
    yield* manifest.refreshInBackground;
  }),
);

it.effect("corporate startup does not load saved remote environment links", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(PeerLinks.layer).pipe(withoutServices);
    const links = Context.get(context, PeerLinks.PeerLinks);
    expect(yield* links.enabled).toBe(false);
    expect(yield* links.list).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("corporate provider maintenance cannot download or execute installers", () =>
  Effect.gen(function* () {
    const maintenance = yield* ProviderMaintenance.make().pipe(withoutServices);
    const error = yield* Effect.flip(maintenance.updateProvider(ProviderDriverKind.make("codex")));
    expect(error.reason).toBe(
      "Install and update provider CLIs outside T3 Code in the corporate build.",
    );
    const context = yield* Layer.build(ProviderInstallation.layer).pipe(withoutServices);
    const installation = Context.get(context, ProviderInstallation.ProviderInstallation);
    const input = { instanceId: ProviderInstanceId.make("corporate-test") };
    const refused = yield* Effect.flip(installation.start(input));
    expect(refused.operation).toBe("install");
    expect(refused.detail).toBe(
      "Manage provider installations outside T3 Code in the corporate build.",
    );
  }).pipe(Effect.scoped),
);
