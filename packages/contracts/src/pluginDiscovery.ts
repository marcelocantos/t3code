import * as Schema from "effect/Schema";

const MAX_PLUGIN_ID_LENGTH = 128;
const IDENTITY_PATTERN =
  "[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?/[a-z0-9][a-z0-9._-]{0,99}/[a-z0-9][a-z0-9._-]{0,99}";
const SLUG_PATTERN = "[a-z0-9][a-z0-9-]{0,63}";

/**
 * What an advertised plugin is called: `host/owner/repo` of the project that runs it, lowercase,
 * for example `github.com/example/example`. `+` never occurs in a segment, so the manifest
 * file name (`host+owner+repo[+instance].json`) encodes the identity without collisions.
 */
export const PluginIdentity = Schema.String.check(
  Schema.isMaxLength(MAX_PLUGIN_ID_LENGTH),
  Schema.isPattern(new RegExp(`^${IDENTITY_PATTERN}$`)),
);
export type PluginIdentity = typeof PluginIdentity.Type;

/**
 * The id of any plugin discovery shows or acts on: an advertised identity, or the short name of a
 * plugin written by hand in `panel-plugins.json` (or decided before identities were canonical).
 */
export const DiscoveredPluginId = Schema.String.check(
  Schema.isMaxLength(MAX_PLUGIN_ID_LENGTH),
  Schema.isPattern(new RegExp(`^(${IDENTITY_PATTERN}|${SLUG_PATTERN})$`)),
);
export type DiscoveredPluginId = typeof DiscoveredPluginId.Type;

const Name = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const BaseUrl = Schema.String.check(Schema.isMaxLength(2048));

/**
 * `offered`: advertised, undecided. `enabled`: configured from discovery; `discoveredBaseUrl`
 * marks a different live endpoint awaiting consent. `disabled`/`dismissed`: declined until reset.
 * `manual`: hand-written in `panel-plugins.json`, which takes precedence.
 */
export const PluginDiscoveryState = Schema.Literals([
  "offered",
  "enabled",
  "disabled",
  "dismissed",
  "manual",
]);
export type PluginDiscoveryState = typeof PluginDiscoveryState.Type;

export const PluginDiscoveryItem = Schema.Struct({
  id: DiscoveredPluginId,
  name: Name,
  state: PluginDiscoveryState,
  /** The endpoint this state applies to: the offered one, or the one saved when enabled. */
  baseUrl: Schema.optional(BaseUrl),
  /** A different live endpoint for an enabled plugin; enabling it needs fresh consent. */
  discoveredBaseUrl: Schema.optional(BaseUrl),
  /** A compatible service currently answers at `baseUrl`. */
  live: Schema.Boolean,
});
export type PluginDiscoveryItem = typeof PluginDiscoveryItem.Type;

export const PluginDiscoverySnapshot = Schema.Struct({
  plugins: Schema.Array(PluginDiscoveryItem).check(Schema.isMaxLength(100)),
});
export type PluginDiscoverySnapshot = typeof PluginDiscoverySnapshot.Type;

/**
 * `enable` names the endpoint the user saw. The server enables it only if that
 * endpoint is advertised and answers now, or is the one saved when the user
 * disabled the plugin, so a service that appears between display and click is
 * never trusted by accident.
 */
export const PluginDiscoveryActionInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("enable"),
    id: DiscoveredPluginId,
    baseUrl: BaseUrl,
  }),
  Schema.Struct({ action: Schema.Literal("dismiss"), id: DiscoveredPluginId }),
  Schema.Struct({ action: Schema.Literal("disable"), id: DiscoveredPluginId }),
  Schema.Struct({ action: Schema.Literal("reset"), id: DiscoveredPluginId }),
]);
export type PluginDiscoveryActionInput = typeof PluginDiscoveryActionInput.Type;

export class PluginDiscoveryActionError extends Schema.TaggedError<PluginDiscoveryActionError>()(
  "PluginDiscoveryActionError",
  {
    id: DiscoveredPluginId,
    reason: Schema.Literals(["not-available", "invalid-state", "limit", "storage"]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-available":
        return `No compatible ${this.id} service is advertised at that address.`;
      case "invalid-state":
        return `${this.id} cannot be changed that way in its current state.`;
      case "limit":
        return "Too many plugin decisions are saved. Reset some in Settings first.";
      case "storage":
        return `Saving the ${this.id} decision failed.`;
    }
  }
}
