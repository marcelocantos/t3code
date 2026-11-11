// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Node socket/process adapter owns callback resources and timers.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import WebSocket from "ws";
import * as Schema from "effect/Schema";
import {
  PluginInboundMessage,
  PluginPanelRequestError,
  PluginSidecarReady,
  type PanelPluginConfig,
  type PluginActionResult,
  type PluginLinkResolution,
  type PluginLinkWebCard,
  type PluginPanelSnapshot,
  type SubscribePluginPanelsInput,
} from "@t3tools/contracts";

const decodeReady = Schema.decodeUnknownSync(PluginSidecarReady);
const decodeMessage = Schema.decodeUnknownSync(PluginInboundMessage);
const IDLE_GRACE_MS = 250;
const MAX_PENDING_REQUESTS = 64;
const MAX_FRAME_BYTES = 1024 * 1024;
const START_TIMEOUT_MS = 10_000;
const RECONNECT_MS = 1_000;
const STOP_TIMEOUT_MS = 2_000;

export interface PluginProject {
  readonly projectId: string;
  readonly title: string;
  readonly cwd: string;
}

/** What a frame is about: one thread's workspace, or every project of the environment. */
export type PluginFrameTarget =
  | { readonly scope: "thread"; readonly threadId: string; readonly cwd: string }
  | { readonly scope: "environment"; readonly projects: ReadonlyArray<PluginProject> };

type Subscription = {
  target: PluginFrameTarget;
  filters: SubscribePluginPanelsInput["filters"];
  emit: (snapshot: PluginPanelSnapshot, endpoint?: string) => void;
};

/** `web` answers only link card requests, `link` only link resolution. */
export type PluginRequestResult = PluginActionResult & {
  readonly web?: PluginLinkWebCard;
  readonly link?: PluginLinkResolution;
};
export type PluginRequestOutcome = PluginRequestResult | PluginPanelRequestError;

export type PluginRequestFrame =
  | {
      readonly type: "action";
      readonly panelId: string;
      readonly rowId: string;
      readonly actionId: string;
      readonly surfaceId?: string | undefined;
      readonly value?: unknown;
    }
  | {
      readonly type: "surface";
      readonly panelId: string;
      readonly rowId: string;
      readonly surfaceId: string;
      readonly itemId?: string | undefined;
    }
  | {
      readonly type: "surface" | "resolve";
      readonly scope: "link";
      readonly linkId: string;
      readonly url: string;
    };

const targetFields = (target: PluginFrameTarget) =>
  target.scope === "thread"
    ? { scope: "thread", threadId: target.threadId, cwd: target.cwd }
    : { scope: "environment", projects: target.projects };

/** A malformed result still answers its request, so the caller sees why instead of a timeout. */
function malformedResultId(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { type, requestId } = raw as { type?: unknown; requestId?: unknown };
  return type === "result" && typeof requestId === "string" ? requestId : undefined;
}

export function pluginSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.hash) throw new Error("Invalid plugin URL");
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Invalid plugin protocol");
  return url.href;
}

/** Node socket/process adapter; one connection multiplexes all subscribers of a configured plugin. */
export class PanelPluginConnection {
  private subscriptions = new Map<string, Subscription>();
  private pending = new Map<string, (outcome: PluginRequestOutcome) => void>();
  private socket: WebSocket | undefined;
  private child: NodeChildProcess.ChildProcess | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readinessTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Holders keep the socket open without a subscription, as link cards need. */
  private holders = new Set<(status: PluginPanelSnapshot["status"]) => void>();
  private status: PluginPanelSnapshot["status"] = "connecting";

  private readonly config: PanelPluginConfig;

  constructor(config: PanelPluginConfig) {
    this.config = config;
  }

  get pluginId() {
    return this.config.id;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** The live socket's URL; web content is served from its origin. */
  get endpoint() {
    return this.socket?.readyState === WebSocket.OPEN ? this.socket.url : undefined;
  }

  /** Keeps the plugin connected without subscribing to panels, reporting its status. */
  retain(onStatus: (status: PluginPanelSnapshot["status"]) => void): () => void {
    this.cancelIdle();
    const holder = (status: PluginPanelSnapshot["status"]) => onStatus(status);
    this.holders.add(holder);
    onStatus(this.status);
    if (!this.socket && !this.child && !this.timer) this.start();
    return () => {
      if (this.holders.delete(holder)) this.idleIfUnused();
    };
  }

  private cancelIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private idleIfUnused() {
    if (this.subscriptions.size === 0 && this.holders.size === 0)
      this.idleTimer = setTimeout(() => this.stop(), IDLE_GRACE_MS);
  }

  /** `retarget` re-sends `subscribe` under the same id, which plugins treat as a replacement. */
  subscribe(subscription: Subscription): {
    close: () => void;
    retarget: (target: PluginFrameTarget) => void;
  } {
    this.cancelIdle();
    const id = NodeCrypto.randomUUID();
    this.subscriptions.set(id, subscription);
    subscription.emit({ pluginId: this.config.id, panels: [], status: this.status });
    if (this.socket?.readyState === WebSocket.OPEN) this.send(id, subscription);
    else if (!this.socket && !this.child && !this.timer) this.start();
    return {
      close: () => {
        if (!this.subscriptions.delete(id)) return;
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: "unsubscribe", subscriptionId: id }));
        }
        this.idleIfUnused();
      },
      retarget: (target) => {
        if (!this.subscriptions.has(id)) return;
        subscription.target = target;
        if (this.socket?.readyState === WebSocket.OPEN) this.send(id, subscription);
      },
    };
  }

  /**
   * Sends an `action` or `surface` frame and settles once with the plugin's matching `result`.
   * The returned function abandons the request; a late result for it is then ignored.
   */
  request(
    /** Absent for link cards, which belong to no thread or environment subscription. */
    target: PluginFrameTarget | undefined,
    frame: PluginRequestFrame,
    settle: (outcome: PluginRequestOutcome) => void,
  ): () => void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      settle(new PluginPanelRequestError({ reason: "not-connected" }));
      return () => undefined;
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      settle(
        new PluginPanelRequestError({
          reason: "rejected",
          detail: "Too many requests are waiting for this plugin.",
        }),
      );
      return () => undefined;
    }
    const requestId = NodeCrypto.randomUUID();
    this.pending.set(requestId, settle);
    socket.send(JSON.stringify({ ...frame, requestId, ...(target ? targetFields(target) : {}) }));
    return () => {
      this.pending.delete(requestId);
    };
  }

  stop() {
    this.stopped = true;
    this.failPending();
    clearTimeout(this.idleTimer);
    clearTimeout(this.readinessTimer);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.socket?.terminate();
    this.socket = undefined;
    this.stopChild();
  }

  private failPending() {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const settle of pending) settle(new PluginPanelRequestError({ reason: "not-connected" }));
  }

  private settle(requestId: string, outcome: PluginRequestOutcome) {
    const settle = this.pending.get(requestId);
    if (!settle) return;
    this.pending.delete(requestId);
    settle(outcome);
  }

  private stopChild() {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }

  private publish(status: PluginPanelSnapshot["status"]) {
    this.status = status;
    for (const subscription of this.subscriptions.values()) {
      subscription.emit({ pluginId: this.config.id, panels: [], status });
    }
    for (const holder of this.holders) holder(status);
  }

  private retry = () => {
    if (this.stopped || this.timer) return;
    this.failPending();
    clearTimeout(this.readinessTimer);
    this.socket?.terminate();
    this.socket = undefined;
    this.stopChild();
    this.publish("disconnected");
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, RECONNECT_MS);
  };

  private start() {
    this.stopped = false;
    this.publish("connecting");
    const connection = this.config.connection;
    if (connection.kind === "server") {
      this.connect(connection.baseUrl);
      return;
    }
    const child = NodeChildProcess.spawn(connection.command, [...connection.args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    let buffer = "";
    let ready = false;
    const timeout = setTimeout(() => this.retry(), START_TIMEOUT_MS);
    this.readinessTimer = timeout;
    const clear = () => clearTimeout(timeout);
    child.once("error", () => {
      clear();
      this.retry();
    });
    child.once("exit", () => {
      clear();
      if (this.child === child) this.retry();
    });
    // Drain diagnostics without retaining potentially sensitive plugin output.
    child.stderr?.resume();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (ready || this.child !== child) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        clear();
        this.retry();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const announcement = decodeReady(JSON.parse(line));
          const url = new URL(pluginSocketUrl(announcement.url));
          if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
            throw new Error("Non-local sidecar");
          ready = true;
          clear();
          this.connect(url.href);
          return;
        } catch {
          // Other stdout lines are diagnostics; only a valid ready record starts the connection.
        }
      }
    });
  }

  private connect(url: string) {
    try {
      const socket = new WebSocket(pluginSocketUrl(url), {
        maxPayload: MAX_FRAME_BYTES,
        handshakeTimeout: START_TIMEOUT_MS,
      });
      this.socket = socket;
      socket.on("open", () => {
        if (this.socket !== socket) return;
        this.publish("connected");
        for (const [id, subscription] of this.subscriptions) this.send(id, subscription);
      });
      socket.on("message", (data) => {
        if (this.socket !== socket) return;
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
          const message = decodeMessage(raw);
          if (message.type === "result") {
            // Unknown ids are results for requests T3 already abandoned, not protocol errors.
            this.settle(
              message.requestId,
              message.ok
                ? {
                    ...(message.surface ? { surface: message.surface } : {}),
                    ...(message.close !== undefined ? { close: message.close } : {}),
                    ...(message.web ? { web: message.web } : {}),
                    ...(message.link ? { link: message.link } : {}),
                  }
                : new PluginPanelRequestError({
                    reason: "rejected",
                    ...(message.error !== undefined ? { detail: message.error } : {}),
                  }),
            );
            return;
          }
          const ids = message.panels.map((panel) => panel.id);
          if (new Set(ids).size !== ids.length) throw new Error("Duplicate panels");
          for (const panel of message.panels) {
            if (panel.kind === "web") continue;
            if (new Set(panel.rows.map((row) => row.id)).size !== panel.rows.length)
              throw new Error("Duplicate rows");
          }
          this.subscriptions.get(message.subscriptionId)?.emit(
            {
              pluginId: this.config.id,
              panels: message.panels,
              status: "connected",
            },
            socket.url,
          );
        } catch {
          const requestId = malformedResultId(raw);
          if (requestId !== undefined)
            this.settle(requestId, new PluginPanelRequestError({ reason: "invalid-response" }));
          this.publish("error");
          socket.close(1008, "Invalid panel message");
        }
      });
      socket.on("error", () => {
        if (this.socket === socket) this.retry();
      });
      socket.on("close", () => {
        if (this.socket === socket) this.retry();
      });
    } catch {
      this.retry();
    }
  }

  private send(id: string, subscription: Subscription) {
    const target = subscription.target;
    this.socket?.send(
      JSON.stringify({
        type: "subscribe",
        protocol: 1,
        // Thread frames predate scopes and stay exactly as older plugins expect them.
        ...(target.scope === "thread"
          ? { threadId: target.threadId, cwd: target.cwd }
          : { scope: "environment", projects: target.projects }),
        subscriptionId: id,
        filters: subscription.filters.filter((filter) => filter.pluginId === this.config.id),
      }),
    );
  }
}
