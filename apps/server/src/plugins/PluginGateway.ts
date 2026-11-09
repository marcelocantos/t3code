import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PluginGatewaySessions } from "./PluginGatewaySessions.ts";

export class PluginGateway extends Context.Service<PluginGateway, PluginGatewaySessions>()(
  "t3/plugins/PluginGateway",
) {}

export const layer = Layer.effect(
  PluginGateway,
  Effect.acquireRelease(
    Effect.sync(() => new PluginGatewaySessions()),
    (sessions) => Effect.sync(() => sessions.close()),
  ),
);
