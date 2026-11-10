// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Node socket/process adapter owns callback resources and timers.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import WebSocket from "ws";
import * as Schema from "effect/Schema";
import {
  PluginPanelMessage,
  PluginSidecarReady,
  type PanelPluginConfig,
  type PluginPanelSnapshot,
  type SubscribePluginPanelsInput,
} from "@t3tools/contracts";

const decodeReady = Schema.decodeUnknownSync(PluginSidecarReady);
const decodeMessage = Schema.decodeUnknownSync(PluginPanelMessage);
const IDLE_GRACE_MS = 250;
const MAX_FRAME_BYTES = 1024 * 1024;
const START_TIMEOUT_MS = 10_000;
const RECONNECT_MS = 1_000;
const STOP_TIMEOUT_MS = 2_000;

type Subscription = {
  input: SubscribePluginPanelsInput;
  cwd: string;
  emit: (snapshot: PluginPanelSnapshot, endpoint?: string) => void;
};

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
  private socket: WebSocket | undefined;
  private child: NodeChildProcess.ChildProcess | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readinessTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private status: PluginPanelSnapshot["status"] = "connecting";

  private readonly config: PanelPluginConfig;

  constructor(config: PanelPluginConfig) {
    this.config = config;
  }

  subscribe(subscription: Subscription): () => void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const id = NodeCrypto.randomUUID();
    this.subscriptions.set(id, subscription);
    subscription.emit({ pluginId: this.config.id, panels: [], status: this.status });
    if (this.socket?.readyState === WebSocket.OPEN) this.send(id, subscription);
    else if (this.subscriptions.size === 1 && !this.socket && !this.child && !this.timer)
      this.start();
    return () => {
      this.subscriptions.delete(id);
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "unsubscribe", subscriptionId: id }));
      }
      if (this.subscriptions.size === 0)
        this.idleTimer = setTimeout(() => this.stop(), IDLE_GRACE_MS);
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.readinessTimer);
    clearTimeout(this.timer);
    this.timer = undefined;
    this.socket?.terminate();
    this.socket = undefined;
    this.stopChild();
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
  }

  private retry = () => {
    if (this.stopped || this.timer) return;
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
        try {
          const message = decodeMessage(JSON.parse(data.toString()));
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
    this.socket?.send(
      JSON.stringify({
        type: "subscribe",
        protocol: 1,
        subscriptionId: id,
        threadId: subscription.input.threadId,
        cwd: subscription.cwd,
        filters: subscription.input.filters.filter((filter) => filter.pluginId === this.config.id),
      }),
    );
  }
}
