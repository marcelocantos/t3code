// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real sockets and child-process readiness records.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import WebSocket, { WebSocketServer } from "ws";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ThreadId, type PluginPanelSnapshot } from "@t3tools/contracts";
import {
  PanelPluginConnection,
  pluginSocketUrl,
  type PluginRequestOutcome,
} from "./PanelPluginConnection.ts";

it("converts HTTP base URLs without losing their path and rejects unsafe schemes", () => {
  expect(pluginSocketUrl("https://example.test/plugins/bullseye?key=x")).toBe(
    "wss://example.test/plugins/bullseye?key=x",
  );
  expect(() => pluginSocketUrl("file:///tmp/plugin")).toThrow();
  expect(() => pluginSocketUrl("http://user:password@example.test")).toThrow();
});

/** HTTP identity answer plus the WebSocket the panel connection dials. */
const servePlugin = (id: string) =>
  new Promise<{ sockets: WebSocketServer; port: number; close: () => Promise<void> }>(
    (resolve, reject) => {
      const httpServer = NodeHttp.createServer((_request, response) => {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ protocol: 1, id, name: id }));
      });
      const sockets = new WebSocketServer({ server: httpServer });
      httpServer.on("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        const address = httpServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("No socket address"));
          return;
        }
        resolve({
          sockets,
          port: address.port,
          close: () =>
            new Promise((done) => {
              for (const socket of sockets.clients) socket.terminate();
              sockets.close(() => httpServer.close(() => done()));
            }),
        });
      });
    },
  );

it.live("multiplexes threads, replaces panels, and rejects malformed frames", () =>
  Effect.promise(async () => {
    const plugin = await servePlugin("test");
    const server = plugin.sockets;
    const connection = new PanelPluginConnection({
      id: "test",
      connection: { kind: "server", baseUrl: `http://127.0.0.1:${plugin.port}` },
    });
    const first: PluginPanelSnapshot[] = [];
    const second: PluginPanelSnapshot[] = [];
    const firstChanged = Promise.withResolvers<PluginPanelSnapshot>();
    const secondChanged = Promise.withResolvers<PluginPanelSnapshot>();
    const removed = Promise.withResolvers<void>();
    const invalid = Promise.withResolvers<void>();
    try {
      const connected = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
      connection.subscribe({
        target: { scope: "thread", threadId: ThreadId.make("first"), cwd: "/first" },
        filters: [],
        emit: (snapshot) => {
          first.push(snapshot);
          if (snapshot.panels.length) firstChanged.resolve(snapshot);
          if (first.some((value) => value.panels.length) && snapshot.panels.length === 0)
            removed.resolve();
          if (snapshot.status === "error") invalid.resolve();
        },
      });
      connection.subscribe({
        target: { scope: "thread", threadId: ThreadId.make("second"), cwd: "/second" },
        filters: [],
        emit: (snapshot) => {
          second.push(snapshot);
          if (snapshot.panels.length) secondChanged.resolve(snapshot);
        },
      });
      const socket = await connected;
      const ids = new Map<string, string>();
      socket.on("message", (raw: Buffer) => {
        const message = JSON.parse(raw.toString());
        if (message.type !== "subscribe") return;
        ids.set(message.threadId, message.subscriptionId);
        socket.send(
          JSON.stringify({
            type: "panels",
            subscriptionId: message.subscriptionId,
            panels: [{ id: "list", title: message.cwd, rows: [], filters: [], filter: "frontier" }],
          }),
        );
      });
      expect((await firstChanged.promise).panels[0]?.title).toBe("/first");
      expect((await secondChanged.promise).panels[0]?.title).toBe("/second");
      expect(server.clients.size).toBe(1);
      socket.send(JSON.stringify({ type: "panels", subscriptionId: ids.get("first"), panels: [] }));
      await removed.promise;
      expect(second.at(-1)?.panels).toHaveLength(1);
      const reconnected = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
      socket.send("invalid json");
      await invalid.promise;
      expect(first.at(-1)?.status).toBe("error");
      const replacement = await reconnected;
      const replayed = Promise.withResolvers<void>();
      const replayedThreads = new Set<string>();
      replacement.on("message", (raw: Buffer) => {
        const message = JSON.parse(raw.toString());
        replayedThreads.add(message.threadId);
        if (replayedThreads.size === 2) replayed.resolve();
      });
      await replayed.promise;
      expect([...replayedThreads].sort()).toEqual(["first", "second"]);
    } finally {
      connection.stop();
      await plugin.close();
    }
  }),
);

it.live("accepts a chunked sidecar announcement and stops its socket", () =>
  Effect.promise(async () => {
    const received = Promise.withResolvers<PluginPanelSnapshot>();
    const connection = new PanelPluginConnection({
      id: "sidecar",
      connection: {
        kind: "sidecar",
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `
      import { WebSocketServer } from ${JSON.stringify(import.meta.resolve("ws"))};
      const server = new WebSocketServer({host:"127.0.0.1",port:0});
      server.on("listening", () => {
        const line = JSON.stringify({type:"ready",protocol:1,url:"ws://127.0.0.1:"+server.address().port})+"\\n";
        process.stdout.write("diagnostic\\n"+line.slice(0,10));
        setImmediate(()=>process.stdout.write(line.slice(10)));
      });
      server.on("connection", socket => socket.on("message", raw => {
        const message=JSON.parse(raw.toString());
        socket.send(JSON.stringify({type:"panels",subscriptionId:message.subscriptionId,panels:[{id:"test",title:"ws://127.0.0.1:"+server.address().port,rows:[],filters:[],filter:"frontier"}]}));
      }));
    `,
        ],
      },
    });
    try {
      connection.subscribe({
        target: { scope: "thread", threadId: ThreadId.make("thread"), cwd: "/tmp" },
        filters: [],
        emit: (snapshot) => {
          if (snapshot.panels.length) received.resolve(snapshot);
        },
      });
      const url = (await received.promise).panels[0]!.title;
      const probe = new WebSocket(url);
      await new Promise<void>((resolve) => probe.once("open", resolve));
      const closed = new Promise<void>((resolve) => probe.once("close", () => resolve()));
      connection.stop();
      await closed;
      expect(probe.readyState).toBe(WebSocket.CLOSED);
    } finally {
      connection.stop();
    }
  }),
);

it.live("reports sidecars that fail before readiness and can be disposed", () =>
  Effect.promise(async () => {
    for (const command of ["/missing-t3-panel-command", process.execPath]) {
      const disconnected = Promise.withResolvers<void>();
      const connection = new PanelPluginConnection({
        id: "broken",
        connection: {
          kind: "sidecar",
          command,
          args: command === process.execPath ? ["-e", "process.exit(1)"] : [],
        },
      });
      try {
        connection.subscribe({
          target: { scope: "thread", threadId: ThreadId.make("thread"), cwd: "/tmp" },
          filters: [],
          emit: (snapshot) => {
            if (snapshot.status === "disconnected") disconnected.resolve();
          },
        });
        await disconnected.promise;
      } finally {
        connection.stop();
      }
    }
  }),
);

it.live("sends environment frames, re-targets in place, and correlates results", () =>
  Effect.promise(async () => {
    const plugin = await servePlugin("env");
    const server = plugin.sockets;
    const connection = new PanelPluginConnection({
      id: "env",
      connection: { kind: "server", baseUrl: `http://127.0.0.1:${plugin.port}` },
      scopes: ["environment"],
    });
    const outcome = (send: (settle: (outcome: PluginRequestOutcome) => void) => void) =>
      new Promise<PluginRequestOutcome>((resolve) => send(resolve));
    const one = { projectId: "one", title: "One", cwd: "/one" };
    const two = { projectId: "two", title: "Two", cwd: "/two" };
    const target = { scope: "environment", projects: [one] } as const;
    const row = { panelId: "list", rowId: "row" };
    const statuses: Array<PluginPanelSnapshot["status"]> = [];
    const connected = Promise.withResolvers<void>();
    try {
      expect(
        await outcome((settle) =>
          connection.request(target, { type: "action", ...row, actionId: "a" }, settle),
        ),
      ).toMatchObject({ reason: "not-connected" });
      const accepted = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
      const subscription = connection.subscribe({
        target,
        filters: [],
        emit: (snapshot) => {
          statuses.push(snapshot.status);
          if (snapshot.status === "connected") connected.resolve();
        },
      });
      const socket = await accepted;
      const frames: Array<Record<string, unknown>> = [];
      const framed: Array<{ count: number; resolve: () => void }> = [];
      let heldAction: string | undefined;
      socket.on("message", (raw: Buffer) => {
        const message = JSON.parse(raw.toString());
        frames.push(message);
        for (const waiter of framed) if (frames.length >= waiter.count) waiter.resolve();
        if (message.type === "action" && message.actionId === "reject") {
          heldAction = message.requestId;
        } else if (message.type === "surface") {
          // An unknown id first: it must be ignored, not treated as a broken plugin.
          socket.send(JSON.stringify({ type: "result", requestId: "stale", ok: true }));
          socket.send(
            JSON.stringify({
              type: "result",
              requestId: message.requestId,
              ok: true,
              surface: { title: "Details", blocks: [] },
            }),
          );
          socket.send(
            JSON.stringify({ type: "result", requestId: heldAction, ok: false, error: "Nope" }),
          );
        } else if (message.type === "action" && message.actionId === "garbled") {
          socket.send(JSON.stringify({ type: "result", requestId: message.requestId, ok: "yes" }));
        }
      });
      const frameCount = (count: number) =>
        new Promise<void>((resolve) => {
          if (frames.length >= count) resolve();
          else framed.push({ count, resolve });
        });
      await connected.promise;
      await frameCount(1);
      expect(frames[0]).toEqual({
        type: "subscribe",
        protocol: 1,
        scope: "environment",
        projects: [one],
        subscriptionId: frames[0]?.subscriptionId,
        filters: [],
      });

      subscription.retarget({ scope: "environment", projects: [one, two] });
      await frameCount(2);
      expect(frames[1]).toMatchObject({
        type: "subscribe",
        subscriptionId: frames[0]?.subscriptionId,
        projects: [one, two],
      });

      const rejected = outcome((settle) =>
        connection.request(
          target,
          { type: "action", ...row, actionId: "reject", value: "2026-11-11" },
          settle,
        ),
      );
      const surface = outcome((settle) =>
        connection.request(target, { type: "surface", ...row, surfaceId: "details" }, settle),
      );
      expect(await surface).toEqual({ surface: { title: "Details", blocks: [] } });
      expect(await rejected).toMatchObject({ reason: "rejected", detail: "Nope" });
      expect(frames[2]).toMatchObject({
        type: "action",
        scope: "environment",
        projects: [one],
        actionId: "reject",
        value: "2026-11-11",
      });
      expect(frames[2]).not.toHaveProperty("threadId");
      expect(frames[3]).toMatchObject({ type: "surface", surfaceId: "details" });
      expect(statuses).not.toContain("error");

      expect(
        await outcome((settle) =>
          connection.request(target, { type: "action", ...row, actionId: "garbled" }, settle),
        ),
      ).toMatchObject({ reason: "invalid-response" });
      expect(statuses).toContain("error");
    } finally {
      connection.stop();
      await plugin.close();
    }
  }),
);

it.live("bounds requests waiting on one plugin and fails them when it goes away", () =>
  Effect.promise(async () => {
    const plugin = await servePlugin("silent");
    const connection = new PanelPluginConnection({
      id: "silent",
      connection: { kind: "server", baseUrl: `http://127.0.0.1:${plugin.port}` },
    });
    const connected = Promise.withResolvers<void>();
    const target = { scope: "thread", threadId: "thread", cwd: "/tmp" } as const;
    try {
      connection.subscribe({
        target,
        filters: [],
        emit: (snapshot) => {
          if (snapshot.status === "connected") connected.resolve();
        },
      });
      await connected.promise;
      const waiting = Array.from(
        { length: 64 },
        () =>
          new Promise<PluginRequestOutcome>((resolve) =>
            connection.request(
              target,
              { type: "action", panelId: "list", rowId: "row", actionId: "a" },
              resolve,
            ),
          ),
      );
      const overflow = await new Promise<PluginRequestOutcome>((resolve) =>
        connection.request(
          target,
          { type: "action", panelId: "list", rowId: "row", actionId: "a" },
          resolve,
        ),
      );
      expect(overflow).toMatchObject({ reason: "rejected" });
      connection.stop();
      for (const outcome of await Promise.all(waiting)) {
        expect(outcome).toMatchObject({ reason: "not-connected" });
      }
    } finally {
      connection.stop();
      await plugin.close();
    }
  }),
);

/** `id` undefined: the port accepts sockets but does not answer the identity probe. */
const listenPlugin = (port: number, id: string | undefined) =>
  new Promise<{
    port: number;
    leaked: Promise<string>;
    probed: Promise<void>;
    close: () => Promise<void>;
  }>((resolve, reject) => {
    let probes = 0;
    let markProbed: () => void = () => undefined;
    const probed = new Promise<void>((done) => {
      markProbed = done;
    });
    let markLeaked: (body: string) => void = () => undefined;
    const leaked = new Promise<string>((done) => {
      markLeaked = done;
    });
    const server = NodeHttp.createServer((_request, response) => {
      probes += 1;
      if (probes >= 2) markProbed();
      if (id === undefined) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ protocol: 1, id, name: "Panels" }));
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => {
      socket.on("message", (raw: Buffer) => markLeaked(raw.toString()));
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("No socket address"));
        return;
      }
      resolve({
        port: address.port,
        leaked,
        probed,
        close: () =>
          new Promise((done) => {
            for (const socket of wss.clients) socket.terminate();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });

it.live("does not send a workspace to whoever binds a server plugin's port next", () =>
  Effect.promise(async () => {
    const id = "github.com/acme/panels";
    const first = await listenPlugin(0, id);
    const connection = new PanelPluginConnection({
      id,
      connection: { kind: "server", baseUrl: `http://127.0.0.1:${first.port}/plugins/t3` },
    });
    const opened: Array<{ close: () => Promise<void> }> = [first];
    try {
      connection.subscribe({
        target: { scope: "thread", threadId: ThreadId.make("thread-1"), cwd: "/secret/worktree" },
        filters: [],
        emit: () => undefined,
      });
      expect(JSON.parse(await first.leaked)).toMatchObject({
        cwd: "/secret/worktree",
        threadId: "thread-1",
      });
      await first.close();
      const impostor = await listenPlugin(first.port, undefined);
      opened.push(impostor);
      const outcome = await Promise.race([
        impostor.leaked.then((body) => ({ kind: "leaked" as const, body })),
        impostor.probed.then(() => ({ kind: "probed" as const })),
      ]);
      expect(outcome.kind).toBe("probed");
      await impostor.close();
      const restored = await listenPlugin(first.port, id);
      opened.push(restored);
      expect(JSON.parse(await restored.leaked)).toMatchObject({ cwd: "/secret/worktree" });
    } finally {
      connection.stop();
      for (const server of opened) await server.close();
    }
  }),
);

const fileAppeared = (directory: string, file: string) =>
  new Promise<void>((resolve) => {
    if (NodeFS.existsSync(file)) {
      resolve();
      return;
    }
    const watcher = NodeFS.watch(directory, () => {
      if (!NodeFS.existsSync(file)) return;
      watcher.close();
      resolve();
    });
    if (NodeFS.existsSync(file)) {
      watcher.close();
      resolve();
    }
  });

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "stopping a sidecar signals the grandchild, then ends it",
  () =>
    Effect.promise(async () => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-plugin-stop-"));
      const hit = NodePath.join(directory, "hit");
      const parentExit = NodePath.join(directory, "parent-exit");
      const ready = NodePath.join(directory, "ready");
      const grandchild = `
      const fs = require("node:fs");
      const net = require("node:net");
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, port: address.port }));
      });
      process.on("SIGHUP", () => {});
      process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(hit)}, "1"));
      setInterval(() => {}, 1e9);
    `;
      const parent = `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["--input-type=commonjs", "-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
      process.on("SIGTERM", () => {
        setTimeout(() => {
          fs.writeFileSync(${JSON.stringify(parentExit)}, "1");
          process.exit(0);
        }, 200);
      });
      setInterval(() => {}, 1e9);
    `;
      let grandchildPid = 0;
      const connection = new PanelPluginConnection({
        id: "sidecar",
        connection: {
          kind: "sidecar",
          command: process.execPath,
          args: ["--input-type=commonjs", "-e", parent],
        },
      });
      try {
        connection.subscribe({
          target: { scope: "thread", threadId: ThreadId.make("thread-1"), cwd: "/tmp" },
          filters: [],
          emit: () => undefined,
        });
        await fileAppeared(directory, ready);
        const info = JSON.parse(NodeFS.readFileSync(ready, "utf8")) as {
          pid: number;
          port: number;
        };
        grandchildPid = info.pid;
        const socket = NodeNet.connect(info.port, "127.0.0.1");
        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
        connection.stop();
        const outcome = await Promise.race([
          fileAppeared(directory, hit).then(() => "hit" as const),
          fileAppeared(directory, parentExit).then(() => "parent-exit" as const),
        ]);
        expect(outcome).toBe("hit");
        await closed;
        expect(socket.destroyed).toBe(true);
      } finally {
        connection.stop();
        if (grandchildPid !== 0) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
);
