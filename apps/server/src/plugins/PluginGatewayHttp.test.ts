import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerHttp from "../http.ts";
import * as ServerConfig from "../config.ts";
// @effect-diagnostics nodeBuiltinImport:off -- A real upstream verifies HTTP forwarding and credential isolation.
import * as NodeHttp from "node:http";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as PluginGateway from "./PluginGateway.ts";
import * as PluginGatewayHttp from "./PluginGatewayHttp.ts";
import { PluginGatewaySessions, pluginRelativePath } from "./PluginGatewaySessions.ts";

it("rejects alternate path spellings before URL normalization", () => {
  for (const path of [
    "//elsewhere/",
    "/../secret",
    "/%2e%2e/secret",
    "/%252e%252e/",
    "/a\\b",
    "/%5cb",
    "/app/?url=http://elsewhere",
  ]) {
    expect(pluginRelativePath(path)).toBe(false);
  }
  expect(pluginRelativePath("/app/assets/a%20b.js")).toBe(false);
  expect(pluginRelativePath("/app/assets/main.js")).toBe(true);
});

it.live("forwards only capability-scoped HTTP, preserves JSON, and revokes access", () =>
  Effect.promise(async () => {
    const received: Array<{ path: string; headers: NodeHttp.IncomingHttpHeaders; body: string }> =
      [];
    const holding = Promise.withResolvers<void>();
    const upstream = NodeHttp.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        received.push({ path: request.url!, headers: request.headers, body });
        if (request.url === "/app/no-content") {
          response.writeHead(204).end();
          return;
        }
        if (request.url === "/app/hold") {
          holding.resolve();
          return;
        }
        if (request.url === "/app/redirect") {
          response.writeHead(302, { location: "/escape" }).end();
          return;
        }
        response
          .writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=secret" })
          .end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No upstream address");
    const sessions = new PluginGatewaySessions();
    const first = sessions.session("thread-one", "/workspace/one", true);
    const second = sessions.session("thread-two", "/workspace/two", true);
    const snapshot = {
      pluginId: "test",
      status: "connected" as const,
      panels: [{ kind: "web" as const, id: "app", title: "App", path: "/app/" }],
    };
    const endpoint = `ws://127.0.0.1:${address.port}/panels`;
    const readOnly = sessions.session("viewer", "/workspace");
    const denied = readOnly.rewrite(snapshot, endpoint).panels[0]!;
    expect(denied.kind).not.toBe("web");
    expect("path" in denied).toBe(false);
    if (denied.kind !== "web") expect(denied.rows[0]?.label).toContain("permission to operate");
    const path = first.rewrite(snapshot, endpoint).panels[0]!;
    const other = second.rewrite(snapshot, endpoint).panels[0]!;
    if (path.kind !== "web" || other.kind !== "web") throw new Error("Expected web panels");
    expect(first.rewrite(snapshot, endpoint).panels[0]).toEqual(path);
    expect(other.path).not.toBe(path.path);
    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.merge(
        PluginGatewayHttp.layer,
        ServerHttp.layerBrowserApiCors.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "plugin-cors-test-" })),
          Layer.provide(NodeServices.layer),
        ),
      ).pipe(Layer.provideMerge(Layer.succeed(PluginGateway.PluginGateway, sessions))),
      { disableLogger: true },
    );
    const url = `http://t3.test${path.path}`;
    try {
      const response = await handler(
        new Request(`${url}api`, {
          method: "POST",
          body: '{"value":7}',
          headers: {
            "content-type": "application/json",
            cookie: "t3=secret",
            authorization: "Bearer secret",
            dpop: "secret",
            "x-t3-thread-id": "forged",
            origin: "null",
          },
        }),
      );
      expect(response.status).toBe(200);
      expect((await handler(new Request(`${url}no-content`, { method: "POST" }))).status).toBe(204);
      expect((await handler(new Request(`${url}api`, { method: "HEAD" }))).status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(received[0]?.path).toBe("/app/api");
      expect(received[0]?.body).toBe('{"value":7}');
      expect(received[0]?.headers["content-type"]).toBe("application/json");
      expect(received[0]?.headers["x-t3-thread-id"]).toBe("thread-one");
      expect(received[0]?.headers.cookie).toBeUndefined();
      expect(received[0]?.headers.authorization).toBeUndefined();
      expect(received[0]?.headers.dpop).toBeUndefined();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("access-control-allow-origin")).toBe("null");
      expect(response.headers.get("content-security-policy")).toContain(
        "sandbox allow-scripts allow-forms;",
      );
      expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
      expect(response.headers.get("content-security-policy")).toContain(
        "script-src 'unsafe-inline' 'wasm-unsafe-eval' ",
      );
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect((await handler(new Request(`${url}redirect`))).status).toBe(502);
      expect(received.some((item) => item.path === "/escape")).toBe(false);
      expect(
        (
          await handler(
            new Request(`${url}api`, {
              method: "OPTIONS",
              headers: {
                origin: "null",
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type",
              },
            }),
          )
        ).status,
      ).toBe(204);
      expect(
        (
          await handler(
            new Request("http://t3.test/api/plugin-panels/missing/api", { method: "OPTIONS" }),
          )
        ).status,
      ).toBe(404);
      const pending = handler(new Request(`${url}hold`));
      await holding.promise;
      first.close();
      expect((await pending).status).toBe(502);
      expect((await handler(new Request(`${url}api`))).status).toBe(404);
      expect((await handler(new Request(`http://t3.test${other.path}api`))).status).toBe(200);
      second.rewrite({ ...snapshot, panels: [] }, endpoint);
      expect((await handler(new Request(`http://t3.test${other.path}api`))).status).toBe(404);
    } finally {
      sessions.close();
      await dispose();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }),
);
