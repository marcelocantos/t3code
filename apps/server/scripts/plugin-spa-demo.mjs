import * as NodeHttp from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const counts = new Map();
const viewers = new Map();
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="./style.css"></head><body><h1>Thread counter</h1><p id="thread">Loading…</p><p id="module"></p><p id="isolation"></p><output id="count">0</output><button id="increment">Increment</button><section id="bridge"><p><span id="details" tabindex="0">Counter details</span></p><button id="pick">Pick a colour…</button> <output id="picked"></output><p><button id="ask">Ask the agent</button> <output id="agent"></output></p><p><button id="maximize" hidden>Maximize</button></p><p id="last-action"></p></section><script type="module" src="./main.js"></script></body></html>`;
// A web surface the panel opens through the host bridge; it closes itself with a result.
const dialog = `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><p>Pick a colour</p><button data-colour="red">Red</button> <button data-colour="blue">Blue</button><script type="module" src="./dialog.js"></script></body></html>`;
const dialogMain = `
const port = await new Promise(resolve => window.addEventListener('message', event => {
  if (event.source === parent && event.data?.type === 't3.bridge.init' && event.ports[0]) resolve({ port: event.ports[0], surfaceId: event.data.surfaceId });
}, { once: true }));
for (const button of document.querySelectorAll('button[data-colour]'))
  button.onclick = () => port.port.postMessage({ type: 'surface.close', surfaceId: port.surfaceId, result: { colour: button.dataset.colour } });
document.body.dataset.bridge = 'ready';
`;
const main = `
const { label } = await import('./chunk.js');
document.querySelector('#module').textContent = label;
// Host bridge: T3 sends a MessagePort in t3.bridge.init; everything else goes over that port.
let port = null;
let nextRequest = 0;
const open = new Set();
const request = message => port?.postMessage({ requestId: String(++nextRequest), ...message });
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 't3.bridge.init' || !event.ports[0]) return;
  port = event.ports[0];
  const ownSurfaceId = event.data.surfaceId;
  // A surface (not the panel) on a host that can maximize it offers a toggle.
  const toggle = document.querySelector('#maximize');
  toggle.hidden = !ownSurfaceId || !event.data.features?.includes('surface.maximize');
  let maximized = false;
  toggle.onclick = () => {
    maximized = !maximized;
    toggle.textContent = maximized ? 'Restore' : 'Maximize';
    port.postMessage({ type: 'surface.update', surfaceId: ownSurfaceId, maximized });
  };
  port.onmessage = ({ data }) => {
    // Opened from the composer: a sent prompt finishes the page's job.
    if (data.type === 'agent.result' && data.ok && location.hash === '#t3-composer') port.postMessage({ type: 'surface.close', surfaceId: ownSurfaceId });
    if (data.type === 'surface.opened') open.add(data.surfaceId);
    if (data.type === 'surface.closed') open.delete(data.surfaceId);
    if (data.type === 'surface.closed' && data.surfaceId === 'picker' && data.result) document.querySelector('#picked').textContent = data.result.colour;
    if (data.type === 'surface.action') document.querySelector('#last-action').textContent = data.actionId;
    if (data.type === 'agent.result') document.querySelector('#agent').textContent = data.ok ? 'Sent' : data.error;
    if (data.type === 'error') document.querySelector('#last-action').textContent = data.message;
  };
  document.body.dataset.bridge = 'ready';
});
parent.postMessage({ type: 't3.bridge.hello' }, '*');
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
const details = document.querySelector('#details');
const showDetails = () => {
  if (open.has('details')) return;
  const box = details.getBoundingClientRect();
  request({ type: 'surface.open', surfaceId: 'details', presentation: 'popover', placement: 'left-start',
    anchor: { x: box.x, y: box.y, width: box.width, height: box.height },
    content: { kind: 'structured', surface: { title: 'Counter details', blocks: [
      { type: 'fields', items: [{ label: 'Count', value: document.querySelector('#count').textContent }] },
      { type: 'actions', items: [{ kind: 'plugin', id: 'reset', label: 'Reset' }] },
    ] } } });
};
details.onmouseenter = showDetails;
details.onfocus = showDetails;
document.querySelector('#pick').onclick = () => open.has('picker') || request({ type: 'surface.open', surfaceId: 'picker', presentation: 'dialog',
  size: { width: 320, height: 160 }, content: { kind: 'web', path: 'dialog.html' } });
document.querySelector('#ask').onclick = () => request({ type: 'agent.prompt', prompt: 'Summarize what the thread counter panel shows.' });
`;
// Link cards: `message` gets a structured card, `page` a web card, and `person` is taken over
// (resolved to a name, rewritten, card on click). See "Link cards" in panel-plugins.md for the
// `links` entries to configure.
const LINK_PREFIXES = {
  message: "https://example.invalid/msg/",
  page: "https://example.invalid/page/",
  person: "https://example.invalid/staff/",
};
const PEOPLE = { jdoe: "Jane Doe", rroe: "Richard Roe" };
const linkKey = (url, prefix) =>
  (url.slice(prefix.length).match(/^[A-Za-z0-9._-]{1,64}/) ?? ["unknown"])[0];
const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const cardPage = (key) =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:12px;font:13px system-ui;color:#ddd;background:#17191c}h1{font-size:15px;margin:0 0 8px}dt{color:#999}dd{margin:0 0 6px}</style></head><body><h1>Page ${escapeHtml(key)}</h1><dl><dt>Served by</dt><dd>plugin-spa-demo through the T3 gateway</dd><dt>Rendered</dt><dd>${new Date().toISOString()}</dd></dl></body></html>`;
const linkResult = (message) => {
  const prefix = LINK_PREFIXES[message.linkId];
  if (typeof message.url !== "string" || !prefix || !message.url.startsWith(prefix))
    return { ok: false, error: "Unknown link" };
  const key = linkKey(message.url, prefix);
  if (message.type === "resolve")
    return PEOPLE[key]
      ? { ok: true, link: { text: PEOPLE[key], href: `https://example.invalid/people/${key}` } }
      : { ok: true, link: {} };
  if (message.linkId === "person")
    return {
      ok: true,
      surface: {
        title: PEOPLE[key] ?? key,
        blocks: [
          {
            type: "fields",
            items: [
              { label: "Staff ID", value: key },
              { label: "Team", value: "Payments" },
            ],
          },
        ],
      },
    };
  if (message.linkId === "page")
    return { ok: true, web: { path: `/cards/page/${encodeURIComponent(key)}`, height: 140 } };
  return {
    ok: true,
    surface: {
      title: `Message ${key}`,
      blocks: [
        {
          type: "fields",
          items: [
            { label: "Type", value: "pacs.008" },
            { label: "Status", value: "Settled", tone: "success" },
            { label: "Amount", value: "AUD 1,250.00" },
          ],
        },
        { type: "text", text: "A structured card from the demo plugin.", tone: "muted" },
      ],
    },
  };
};

const server = NodeHttp.createServer((request, response) => {
  const path = new URL(request.url, "http://plugin.local").pathname;
  // Link card pages belong to no thread, so they come without thread headers.
  if (path.startsWith("/cards/page/") && request.method === "GET") {
    const key = decodeURIComponent(path.slice("/cards/page/".length));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(cardPage(key));
    return;
  }
  const threadId = request.headers["x-t3-thread-id"];
  if (!threadId) {
    response.writeHead(403).end();
    return;
  }
  const files = {
    "/app/": ["text/html", html],
    "/app/main.js": ["text/javascript", main],
    "/app/chunk.js": ["text/javascript", "export const label = 'Dynamic module loaded';"],
    "/app/dialog.html": ["text/html", dialog],
    "/app/dialog.js": ["text/javascript", dialogMain],
    "/app/style.css": [
      "text/css",
      "body{font:14px system-ui;padding:12px;color:#ddd;background:#17191c}h1{font-size:18px}output{margin-right:12px}button{padding:8px}",
    ],
  };
  const file = files[path];
  if (file && request.method === "GET") {
    response.writeHead(200, { "content-type": `${file[0]}; charset=utf-8` }).end(file[1]);
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
      if ((message.type === "surface" || message.type === "resolve") && message.scope === "link") {
        socket.send(
          JSON.stringify({ type: "result", requestId: message.requestId, ...linkResult(message) }),
        );
        return;
      }
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
            {
              kind: "web",
              id: "counter",
              title: "Thread counter",
              path: "/app/",
              height: 360,
              composer: { label: "Thread counter", icon: "chart" },
            },
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
