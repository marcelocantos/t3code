import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

const Label = Schema.String.check(Schema.isMaxLength(4096));
const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
export const PanelPluginConfig = Schema.Struct({
  id: Id,
  connection: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("server"), baseUrl: Schema.String }),
    Schema.Struct({
      kind: Schema.Literal("sidecar"),
      command: Schema.String.check(Schema.isNonEmpty()),
      args: Schema.Array(Schema.String),
    }),
  ]),
});
export type PanelPluginConfig = typeof PanelPluginConfig.Type;
const NativePluginPanel = Schema.Struct({
  kind: Schema.optional(Schema.Literal("list")),
  id: Id,
  title: Label,
  rows: Schema.Array(Schema.Struct({ id: Id, label: Label, detail: Schema.optional(Label) })).check(
    Schema.isMaxLength(2000),
  ),
  filters: Schema.Array(Schema.Struct({ id: Id, label: Label })).check(Schema.isMaxLength(20)),
  filter: Id,
});
export const PluginPanel = Schema.Union([
  NativePluginPanel,
  Schema.Struct({
    kind: Schema.Literal("web"),
    id: Id,
    title: Label,
    path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
    height: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 1200 }))),
  }),
]);
export type PluginPanel = typeof PluginPanel.Type;
export const PluginPanelSnapshot = Schema.Struct({
  pluginId: Id,
  panels: Schema.Array(PluginPanel).check(Schema.isMaxLength(20)),
  status: Schema.Literals(["connecting", "connected", "disconnected", "error"]),
});
export type PluginPanelSnapshot = typeof PluginPanelSnapshot.Type;
export const SubscribePluginPanelsInput = Schema.Struct({
  threadId: ThreadId,
  filters: Schema.Array(Schema.Struct({ pluginId: Id, panelId: Id, filter: Id })).check(
    Schema.isMaxLength(100),
  ),
});
export type SubscribePluginPanelsInput = typeof SubscribePluginPanelsInput.Type;
export const PluginPanelsState = Schema.Array(PluginPanelSnapshot);
export const PluginPanelMessage = Schema.Struct({
  type: Schema.Literal("panels"),
  subscriptionId: Id,
  panels: Schema.Array(PluginPanel).check(Schema.isMaxLength(20)),
});
export const PluginSidecarReady = Schema.Struct({
  type: Schema.Literal("ready"),
  protocol: Schema.Literal(1),
  url: Schema.String,
});
