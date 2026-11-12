import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

const Label = Schema.String.check(Schema.isMaxLength(4096));
const ShortLabel = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const Id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
/** A calendar date in the user's local calendar, never a timestamp: `YYYY-MM-DD`. */
export const PluginCalendarDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
const Tone = Schema.Literals(["default", "muted", "info", "success", "warning", "danger"]);

/**
 * What a plugin serves. `thread` panels sit in a thread's details and are scoped to its workspace.
 * `environment` panels sit in the left sidebar and see every project of the environment. `links`
 * shows the plugin's cards for chat links matching its declared patterns.
 */
export const PluginPanelScope = Schema.Literals(["thread", "environment", "links"]);
export type PluginPanelScope = typeof PluginPanelScope.Type;
export const PluginPanelScopes = Schema.Array(PluginPanelScope).check(Schema.isMaxLength(3));

/** An absolute http(s) URL prefix with a path, so `https://a.example` cannot match `a.example.evil`. */
export const PluginLinkPrefix = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https?:\/\/[^\s/?#@]+\/\S*$/),
);
/**
 * A pattern matched against a whole http(s) URL, or a file link's absolute path. `*` and `?` stay
 * within one `/`-separated segment, `**` spans segments, `{a,b}` picks one; the rest is literal.
 */
export const PluginLinkGlob = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^[^\s{}]*(\{[^\s{}]*\}[^\s{}]*)*$/),
  Schema.isPattern(/[*?{]/),
);
/**
 * An http(s) URL with `{url}` (the whole link) and `{rest}` (what follows the prefix, or the glob's
 * text before its first wildcard) filled in, each URI-encoded. Anything else is ignored.
 */
export const PluginLinkTemplate = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https?:\/\/\S+$/),
);
/** `open` follows the link (rewritten if the plugin says so); `card` shows the plugin's card. */
export const PluginLinkClick = Schema.Literals(["open", "card"]);
export type PluginLinkClick = typeof PluginLinkClick.Type;
const PluginLinkBehaviour = {
  click: Schema.optional(PluginLinkClick),
  href: Schema.optional(PluginLinkTemplate),
  /** The plugin answers a `resolve` request per distinct link with its own href and text. */
  resolve: Schema.optional(Schema.Boolean),
};
/** Chat links starting with `prefix`, or matching `glob`, belong to the plugin that declared it. */
export const PluginLinkPattern = Schema.Union([
  Schema.Struct({ id: Id, prefix: PluginLinkPrefix, ...PluginLinkBehaviour }),
  Schema.Struct({ id: Id, glob: PluginLinkGlob, ...PluginLinkBehaviour }),
]);
export type PluginLinkPattern = typeof PluginLinkPattern.Type;
export const PluginLinkPatterns = Schema.Array(PluginLinkPattern).check(Schema.isMaxLength(16));

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
  /** Scopes the plugin serves. Absent means `["thread"]`, so older plugins never see new frames. */
  scopes: Schema.optional(PluginPanelScopes),
  /** Link patterns the plugin shows cards for; used only with the `links` scope. */
  links: Schema.optional(PluginLinkPatterns),
});
export type PanelPluginConfig = typeof PanelPluginConfig.Type;

export const PluginBadge = Schema.Struct({ label: ShortLabel, tone: Schema.optional(Tone) });
export type PluginBadge = typeof PluginBadge.Type;

/** T3 submits `prompt` to the thread as the user's own message. Thread panels only. */
export const PluginAgentAction = Schema.Struct({
  kind: Schema.Literal("agent"),
  id: Id,
  label: ShortLabel,
  prompt: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(16_384)),
});
/** T3 sends an `action` frame without a value. `confirm` asks the user first. */
export const PluginRequestAction = Schema.Struct({
  kind: Schema.Literal("plugin"),
  id: Id,
  label: ShortLabel,
  tone: Schema.optional(Tone),
  confirm: Schema.optional(Label),
});
/**
 * T3 offers date shortcuts (tomorrow, the day after, next week, a custom date) and, when `value` is
 * set, a clear choice. The chosen date, or `null` for clear, is the action's value.
 */
export const PluginDateAction = Schema.Struct({
  kind: Schema.Literal("date"),
  id: Id,
  label: ShortLabel,
  value: Schema.optional(PluginCalendarDate),
  clearLabel: Schema.optional(ShortLabel),
});
/** T3 asks the plugin for surface `surfaceId` of this row and opens it as a dialog. */
export const PluginSurfaceAction = Schema.Struct({
  kind: Schema.Literal("surface"),
  id: Id,
  label: ShortLabel,
  surfaceId: Id,
  modal: Schema.optional(Schema.Boolean),
});
const LeafAction = Schema.Union([
  PluginAgentAction,
  PluginRequestAction,
  PluginDateAction,
  PluginSurfaceAction,
]);
export const PluginMenuAction = Schema.Struct({
  kind: Schema.Literal("menu"),
  id: Id,
  label: ShortLabel,
  items: Schema.Array(LeafAction).check(Schema.isMaxLength(32)),
});
export const PluginAction = Schema.Union([
  PluginAgentAction,
  PluginRequestAction,
  PluginDateAction,
  PluginSurfaceAction,
  PluginMenuAction,
]);
export type PluginAction = typeof PluginAction.Type;
export type PluginLeafAction = typeof LeafAction.Type;

export const PluginPanelRow = Schema.Struct({
  id: Id,
  label: Label,
  detail: Schema.optional(Label),
  badges: Schema.optional(Schema.Array(PluginBadge).check(Schema.isMaxLength(8))),
  /** Shown in the row's `…` menu, except `primaryActionId`, which gets a visible button. */
  actions: Schema.optional(Schema.Array(PluginAction).check(Schema.isMaxLength(32))),
  primaryActionId: Schema.optional(Id),
  /** Surface fetched on hover or focus and shown as a card beside the row. */
  hoverSurfaceId: Schema.optional(Id),
  /** Environment panels: clicking the row opens a thread of one of these projects. */
  navigate: Schema.optional(
    Schema.Struct({ projectIds: Schema.Array(Id).check(Schema.isMaxLength(16)) }),
  ),
});
export type PluginPanelRow = typeof PluginPanelRow.Type;

const NativePluginPanel = Schema.Struct({
  kind: Schema.optional(Schema.Literal("list")),
  id: Id,
  title: Label,
  rows: Schema.Array(PluginPanelRow).check(Schema.isMaxLength(2000)),
  filters: Schema.Array(Schema.Struct({ id: Id, label: Label })).check(Schema.isMaxLength(20)),
  filter: Id,
});
/** Icons both clients draw, so two plugins' composer buttons can differ. */
export const PluginComposerIcon = Schema.Literals([
  "pencil",
  "paintbrush",
  "diagram",
  "chart",
  "image",
  "document",
  "sparkles",
  "target",
]);
export type PluginComposerIcon = typeof PluginComposerIcon.Type;
export const PluginPanel = Schema.Union([
  NativePluginPanel,
  Schema.Struct({
    kind: Schema.Literal("web"),
    id: Id,
    title: Label,
    path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
    height: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 1200 }))),
    /** Adds a composer button that opens this page, with `#t3-composer`, in a modal. */
    composer: Schema.optional(
      Schema.Struct({ label: ShortLabel, icon: Schema.optional(PluginComposerIcon) }),
    ),
  }),
]);
export type PluginPanel = typeof PluginPanel.Type;

/** Structured surface content. T3 renders it; plugins never supply executable UI to the host. */
export const PluginSurfaceBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("heading"), text: Label }),
  Schema.Struct({ type: Schema.Literal("text"), text: Label, tone: Schema.optional(Tone) }),
  Schema.Struct({
    type: Schema.Literal("fields"),
    items: Schema.Array(
      Schema.Struct({ label: ShortLabel, value: Label, tone: Schema.optional(Tone) }),
    ).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    type: Schema.Literal("list"),
    items: Schema.Array(
      Schema.Struct({
        id: Id,
        label: Label,
        detail: Schema.optional(Label),
        badges: Schema.optional(Schema.Array(PluginBadge).check(Schema.isMaxLength(8))),
        /** Opens a child surface anchored to this item; T3 sends the item id with the request. */
        surfaceId: Schema.optional(Id),
      }),
    ).check(Schema.isMaxLength(500)),
  }),
  Schema.Struct({
    type: Schema.Literal("form"),
    id: Id,
    fields: Schema.Array(
      Schema.Struct({
        id: Id,
        label: ShortLabel,
        kind: Schema.Literals(["text", "textarea", "date"]),
        required: Schema.optional(Schema.Boolean),
        value: Schema.optional(Label),
        placeholder: Schema.optional(ShortLabel),
      }),
    ).check(Schema.isMaxLength(16)),
    /** Submitting sends this action with the field values as `{ [fieldId]: string }`. */
    actionId: Id,
    submitLabel: ShortLabel,
  }),
  Schema.Struct({
    type: Schema.Literal("actions"),
    items: Schema.Array(
      Schema.Union([PluginRequestAction, PluginDateAction, PluginSurfaceAction]),
    ).check(Schema.isMaxLength(16)),
  }),
]);
export type PluginSurfaceBlock = typeof PluginSurfaceBlock.Type;

export const PluginSurface = Schema.Struct({
  title: Label,
  blocks: Schema.Array(PluginSurfaceBlock).check(Schema.isMaxLength(200)),
  width: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 240, maximum: 800 }))),
});
export type PluginSurface = typeof PluginSurface.Type;

export const PluginActionValue = Schema.NullOr(
  Schema.Union([Schema.String.check(Schema.isMaxLength(16_384)), Schema.Record(Id, Label)]),
);
export type PluginActionValue = typeof PluginActionValue.Type;

/**
 * `close` closes the surface the action came from. `surface` opens a child of it, or a dialog when
 * the action came from a row.
 */
export const PluginActionResult = Schema.Struct({
  surface: Schema.optional(PluginSurface),
  close: Schema.optional(Schema.Boolean),
});
export type PluginActionResult = typeof PluginActionResult.Type;

export const PluginPanelSnapshot = Schema.Struct({
  pluginId: Id,
  panels: Schema.Array(PluginPanel).check(Schema.isMaxLength(20)),
  status: Schema.Literals(["connecting", "connected", "disconnected", "error"]),
});
export type PluginPanelSnapshot = typeof PluginPanelSnapshot.Type;
const PanelFilterSelections = Schema.Array(
  Schema.Struct({ pluginId: Id, panelId: Id, filter: Id }),
).check(Schema.isMaxLength(100));
export const SubscribePluginPanelsInput = Schema.Struct({
  threadId: ThreadId,
  filters: PanelFilterSelections,
});
export type SubscribePluginPanelsInput = typeof SubscribePluginPanelsInput.Type;
export const SubscribeEnvironmentPluginPanelsInput = Schema.Struct({
  filters: PanelFilterSelections,
});
export type SubscribeEnvironmentPluginPanelsInput =
  typeof SubscribeEnvironmentPluginPanelsInput.Type;
export const PluginPanelsState = Schema.Array(PluginPanelSnapshot);

/** Which subscription an action or surface request belongs to. */
export const PluginPanelTarget = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("thread"), threadId: ThreadId }),
  Schema.Struct({ scope: Schema.Literal("environment") }),
]);
export type PluginPanelTarget = typeof PluginPanelTarget.Type;

export const PluginPanelActionInput = Schema.Struct({
  target: PluginPanelTarget,
  pluginId: Id,
  panelId: Id,
  rowId: Id,
  actionId: Id,
  /** The surface the action was invoked from, if any. */
  surfaceId: Schema.optional(Id),
  value: Schema.optional(PluginActionValue),
});
export type PluginPanelActionInput = typeof PluginPanelActionInput.Type;

export const PluginPanelSurfaceInput = Schema.Struct({
  target: PluginPanelTarget,
  pluginId: Id,
  panelId: Id,
  rowId: Id,
  surfaceId: Id,
  /** The list item that requested a child surface. */
  itemId: Schema.optional(Id),
});
export type PluginPanelSurfaceInput = typeof PluginPanelSurfaceInput.Type;

export class PluginPanelRequestError extends Schema.TaggedError<PluginPanelRequestError>()(
  "PluginPanelRequestError",
  {
    reason: Schema.Literals(["not-connected", "timeout", "rejected", "invalid-response"]),
    /** The plugin's own explanation when it rejected the request. */
    detail: Schema.optional(Label),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-connected":
        return "The plugin is not connected.";
      case "timeout":
        return "The plugin did not respond in time.";
      case "rejected":
        return this.detail ?? "The plugin rejected the request.";
      case "invalid-response":
        return "The plugin sent an invalid response.";
    }
  }
}

/** A declared link pattern of an enabled plugin, as clients match chat links against it. */
export const PluginLink = Schema.Union([
  Schema.Struct({ pluginId: Id, linkId: Id, prefix: PluginLinkPrefix, ...PluginLinkBehaviour }),
  Schema.Struct({ pluginId: Id, linkId: Id, glob: PluginLinkGlob, ...PluginLinkBehaviour }),
]);
export type PluginLink = typeof PluginLink.Type;

const globCache = new Map<string, RegExp>();
const globRegExp = (glob: string) => {
  let compiled = globCache.get(glob);
  if (compiled !== undefined) return compiled;
  let source = "";
  let inBraces = false;
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      source += ".*";
      index++;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") [source, inBraces] = [`${source}(?:`, true];
    else if (char === "}") [source, inBraces] = [`${source})`, false];
    else if (char === "," && inBraces) source += "|";
    else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  compiled = new RegExp(`^${source}$`);
  globCache.set(glob, compiled);
  return compiled;
};

/** The literal text a link's pattern starts with; longer is more specific. */
export const pluginLinkStem = (link: PluginLink): string =>
  "prefix" in link ? link.prefix : link.glob.slice(0, link.glob.search(/[*?{]/));

/**
 * Whether `target` (an http(s) URL, or a file link's absolute path) is claimed by `link`. A path
 * must already be normalized, so `..` cannot walk a link out of the directory a glob names.
 */
export const pluginLinkMatches = (link: PluginLink, target: string): boolean =>
  "prefix" in link
    ? target.startsWith(link.prefix)
    : globRegExp(link.glob).test(target) &&
      (/^https?:\/\//i.test(target) || !/(^|\/)\.\.?(\/|$)/.test(target));

export const PluginLinksState = Schema.Array(PluginLink).check(Schema.isMaxLength(320));

export const PluginLinkCardInput = Schema.Struct({
  pluginId: Id,
  linkId: Id,
  url: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8192)),
});
export type PluginLinkCardInput = typeof PluginLinkCardInput.Type;

/** What a plugin that declared `resolve` says about one link; absent fields keep the original. */
export const PluginLinkResolution = Schema.Struct({
  href: Schema.optional(PluginLinkTemplate),
  text: Schema.optional(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200))),
});
export type PluginLinkResolution = typeof PluginLinkResolution.Type;

const LinkCardHeight = Schema.Int.check(Schema.isBetween({ minimum: 80, maximum: 800 }));
/** `webUrl` is a gateway path on the environment's HTTP origin, served in a sandboxed frame. */
export const PluginLinkCard = Schema.Union([
  Schema.Struct({ surface: PluginSurface }),
  Schema.Struct({ webUrl: Schema.String, height: Schema.optional(LinkCardHeight) }),
]);
export type PluginLinkCard = typeof PluginLinkCard.Type;

// ── Plugin wire protocol (T3 server ↔ plugin) ──────────────────────────────────────────────────

export const PluginLinkWebCard = Schema.Struct({
  path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
  height: Schema.optional(LinkCardHeight),
});
export type PluginLinkWebCard = typeof PluginLinkWebCard.Type;

export const PluginPanelMessage = Schema.Struct({
  type: Schema.Literal("panels"),
  subscriptionId: Id,
  panels: Schema.Array(PluginPanel).check(Schema.isMaxLength(20)),
});
export const PluginResultMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("result"),
    requestId: Id,
    ok: Schema.Literal(true),
    surface: Schema.optional(PluginSurface),
    close: Schema.optional(Schema.Boolean),
    /** Link cards only: a page on the plugin's own origin, shown through the gateway. */
    web: Schema.optional(PluginLinkWebCard),
    /** Link resolution only: the link's new href and text. */
    link: Schema.optional(PluginLinkResolution),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    requestId: Id,
    ok: Schema.Literal(false),
    error: Schema.optional(Label),
  }),
]);
export type PluginResultMessage = typeof PluginResultMessage.Type;
export const PluginInboundMessage = Schema.Union([PluginPanelMessage, PluginResultMessage]);
export const PluginSidecarReady = Schema.Struct({
  type: Schema.Literal("ready"),
  protocol: Schema.Literal(1),
  url: Schema.String,
});
