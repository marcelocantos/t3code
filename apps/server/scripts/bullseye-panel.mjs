import { WebSocketServer, WebSocket } from "ws";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const POLL_MS = 2000;
const server = new WebSocketServer({
  host: "127.0.0.1",
  port: 0,
  maxPayload: 65536,
  verifyClient: ({ origin }) => !origin,
});
const filters = [
  { id: "frontier", label: "Frontier" },
  { id: "active", label: "Active" },
  { id: "all", label: "All" },
];

server.on("listening", () => {
  process.stdout.write(
    `${JSON.stringify({
      type: "ready",
      protocol: 1,
      url: `ws://127.0.0.1:${server.address().port}`,
    })}\n`,
  );
});
server.on("connection", (socket) => {
  const subscriptions = new Map();
  let closed = false;
  let busy = false;
  const refresh = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      for (const [subscriptionId, subscription] of subscriptions) {
        const args = [
          "query",
          "--cwd",
          subscription.cwd,
          "--view",
          subscription.filter === "frontier" ? "frontier" : "list",
        ];
        if (subscription.filter !== "frontier") args.push("--filter", subscription.filter);
        let rows;
        try {
          const { stdout } = await run("bullseye", args, {
            timeout: 10000,
            maxBuffer: 1024 * 1024,
          });
          rows = [];
          for (const line of stdout.split("\n")) {
            const target = /^🎯(T[\d.]+)\s+(.+)$/.exec(line);
            if (target) rows.push({ id: target[1], label: `🎯${target[1]} ${target[2]}` });
            else if (/^\s+\S/.test(line) && rows.length) {
              const row = rows.at(-1);
              row.detail = row.detail ? `${row.detail}\n${line.trim()}` : line.trim();
            }
          }
        } catch {
          rows = [
            {
              id: "unavailable",
              label: "Bullseye unavailable",
              detail: "Check that bullseye is installed and this workspace has an intent ledger.",
            },
          ];
        }
        if (closed || subscriptions.get(subscriptionId) !== subscription) continue;
        const message = JSON.stringify({
          type: "panels",
          subscriptionId,
          panels: [
            { id: "targets", title: "Bullseye", rows, filters, filter: subscription.filter },
          ],
        });
        if (message !== subscription.previous && socket.readyState === WebSocket.OPEN) {
          socket.send(message);
          subscription.previous = message;
        }
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void refresh(), POLL_MS);
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (typeof message.subscriptionId !== "string" || message.subscriptionId.length > 128)
        throw new Error("Invalid subscription");
      if (message.type === "unsubscribe") {
        subscriptions.delete(message.subscriptionId);
        return;
      }
      if (
        message.type !== "subscribe" ||
        message.protocol !== 1 ||
        typeof message.cwd !== "string" ||
        !Array.isArray(message.filters)
      )
        throw new Error("Invalid subscription");
      if (subscriptions.size >= 100 && !subscriptions.has(message.subscriptionId))
        throw new Error("Too many subscriptions");
      const selected =
        message.filters.find((filter) => filter.panelId === "targets")?.filter ?? "frontier";
      if (!filters.some((filter) => filter.id === selected)) throw new Error("Invalid filter");
      subscriptions.set(message.subscriptionId, { cwd: message.cwd, filter: selected });
      void refresh();
    } catch {
      socket.close(1008, "Invalid subscription");
    }
  });
  socket.on("error", () => socket.close());
  socket.on("close", () => {
    closed = true;
    clearInterval(timer);
    subscriptions.clear();
  });
});
const stop = () => {
  for (const client of server.clients) client.terminate();
  server.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
