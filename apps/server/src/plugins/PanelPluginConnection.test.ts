// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real sockets and child-process readiness records.
import WebSocket, { WebSocketServer } from "ws";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ThreadId, type PluginPanelSnapshot } from "@t3tools/contracts";
import { PanelPluginConnection, pluginSocketUrl } from "./PanelPluginConnection.ts";

it("converts HTTP base URLs without losing their path and rejects unsafe schemes", () => {
  expect(pluginSocketUrl("https://example.test/plugins/bullseye?key=x")).toBe(
    "wss://example.test/plugins/bullseye?key=x",
  );
  expect(() => pluginSocketUrl("file:///tmp/plugin")).toThrow();
  expect(() => pluginSocketUrl("http://user:password@example.test")).toThrow();
});

it.live("multiplexes threads, replaces panels, and rejects malformed frames", () =>
  Effect.promise(async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("No socket address");
    const connection = new PanelPluginConnection({
      id: "test",
      connection: { kind: "server", baseUrl: `http://127.0.0.1:${address.port}` },
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
        input: { threadId: ThreadId.make("first"), filters: [] },
        cwd: "/first",
        emit: (snapshot) => {
          first.push(snapshot);
          if (snapshot.panels.length) firstChanged.resolve(snapshot);
          if (first.some((value) => value.panels.length) && snapshot.panels.length === 0)
            removed.resolve();
          if (snapshot.status === "error") invalid.resolve();
        },
      });
      connection.subscribe({
        input: { threadId: ThreadId.make("second"), filters: [] },
        cwd: "/second",
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
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
        input: { threadId: ThreadId.make("thread"), filters: [] },
        cwd: "/tmp",
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
          input: { threadId: ThreadId.make("thread"), filters: [] },
          cwd: "/tmp",
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
