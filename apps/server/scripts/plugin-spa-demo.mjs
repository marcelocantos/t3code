import * as NodeHttp from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const counts = new Map();
const viewers = new Map();
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"></head><body><h1>Thread counter</h1><p id="thread">Loading…</p><p id="module"></p><p id="isolation"></p><output id="count">0</output><button id="increment">Increment</button><script type="module" src="./main.js"></script></body></html>`;
const main = `
const { label } = await import('./chunk.js');
document.querySelector('#module').textContent = label;
const context = await fetch('./api/context').then(r => r.json());
document.querySelector('#thread').textContent = context.threadId;
document.querySelector('#count').textContent = String(context.count);
let isolated = false; try { void parent.document.body; } catch { isolated = true; }
let storageBlocked = false; try { localStorage.setItem('plugin-test','x'); } catch { storageBlocked = true; }
document.querySelector('#isolation').textContent = isolated && storageBlocked ? 'Isolated' : 'Isolation failed';
const socketUrl = new URL('./events', location.href); socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(socketUrl);
socket.onmessage = event => { const data = JSON.parse(event.data); document.querySelector('#count').textContent = String(data.count); document.querySelector('#count').dataset.live = 'true'; };
document.querySelector('#increment').onclick = async () => { const response = await fetch('./api/count', {method:'POST',headers:{'content-type':'application/json'},body:'{}'}); document.querySelector('#increment').dataset.status = String(response.status); };
`;
const server = NodeHttp.createServer((request, response) => {
  const path = new URL(request.url, "http://plugin.local").pathname;
  const threadId = request.headers["x-t3-thread-id"];
  if (!threadId) {
    response.writeHead(403).end();
    return;
  }
  const files = {
    "/app/": ["text/html", html],
    "/app/main.js": ["text/javascript", main],
    "/app/chunk.js": ["text/javascript", "export const label = 'Dynamic module loaded';"],
    "/app/style.css": [
      "text/css",
      "body{font:14px system-ui;padding:12px;color:#ddd;background:#17191c}h1{font-size:18px}output{margin-right:12px}button{padding:8px}",
    ],
  };
  const file = files[path];
  if (file && request.method === "GET") {
    response.writeHead(200, { "content-type": file[0] }).end(file[1]);
    return;
  }
  if (path === "/app/api/context" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        threadId,
        cwd: decodeURIComponent(request.headers["x-t3-workspace"] ?? ""),
        count: counts.get(threadId) ?? 0,
      }),
    );
    return;
  }
  if (path === "/app/api/count" && request.method === "POST") {
    request.resume();
    const count = (counts.get(threadId) ?? 0) + 1;
    counts.set(threadId, count);
    for (const socket of viewers.get(threadId) ?? [])
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ threadId, count }));
    response.writeHead(204).end();
    return;
  }
  response.writeHead(404).end();
});
const panels = new WebSocketServer({ noServer: true, maxPayload: 65536 });
const events = new WebSocketServer({ noServer: true, maxPayload: 65536 });
server.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url, "http://plugin.local").pathname;
  if (request.headers.origin || (path !== "/panels" && path !== "/app/events")) {
    socket.destroy();
    return;
  }
  const target = path === "/panels" ? panels : events;
  if (target === events && !request.headers["x-t3-thread-id"]) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(request, socket, head, (client) =>
    target.emit("connection", client, request),
  );
});
panels.on("connection", (socket) => {
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "unsubscribe") return;
      if (
        message.type !== "subscribe" ||
        message.protocol !== 1 ||
        typeof message.subscriptionId !== "string"
      )
        throw new Error("Invalid subscription");
      socket.send(
        JSON.stringify({
          type: "panels",
          subscriptionId: message.subscriptionId,
          panels: [
            { kind: "web", id: "counter", title: "Thread counter", path: "/app/", height: 360 },
          ],
        }),
      );
    } catch {
      socket.close(1008, "Invalid message");
    }
  });
  socket.on("error", () => socket.close());
});
events.on("connection", (socket, request) => {
  const threadId = request.headers["x-t3-thread-id"];
  const clients = viewers.get(threadId) ?? new Set();
  clients.add(socket);
  viewers.set(threadId, clients);
  socket.send(JSON.stringify({ threadId, count: counts.get(threadId) ?? 0 }));
  socket.on("error", () => socket.close());
  socket.on("close", () => {
    clients.delete(socket);
    if (!clients.size) viewers.delete(threadId);
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(
    `${JSON.stringify({ type: "ready", protocol: 1, url: `ws://127.0.0.1:${server.address().port}/panels` })}\n`,
  );
});
const stop = () => {
  for (const collection of [panels, events])
    for (const client of collection.clients) client.terminate();
  server.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
