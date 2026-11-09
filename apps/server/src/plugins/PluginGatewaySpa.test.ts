// @effect-diagnostics nodeBuiltinImport:off -- The acceptance slice launches the shipped example sidecar beside a real HTTP gateway.
import * as NodeURL from "node:url";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import { chromium } from "playwright-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { ThreadId } from "@t3tools/contracts";
import * as PluginGateway from "./PluginGateway.ts";
import * as PluginGatewayHttp from "./PluginGatewayHttp.ts";
import { PluginGatewaySessions } from "./PluginGatewaySessions.ts";
import { PanelPluginConnection } from "./PanelPluginConnection.ts";

it.live("runs a SPA's modules, API and socket in an isolated, revocable thread panel", () =>
  Effect.gen(function* () {
    const sessions = yield* Effect.acquireRelease(
      Effect.sync(() => new PluginGatewaySessions()),
      (value) => Effect.sync(() => value.close()),
    );
    const session = sessions.session("spa-thread", "/workspace/spa", true);
    const services = yield* Layer.build(
      HttpRouter.serve(
        Layer.merge(
          PluginGatewayHttp.layer,
          HttpRouter.add(
            "GET",
            "/host",
            HttpServerResponse.html("<!doctype html><title>Plugin host</title>"),
          ),
        ),
        { disableLogger: true, disableListenLog: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(Layer.succeed(PluginGateway.PluginGateway, sessions)),
      ),
    );
    const origin = HttpServer.formatAddress(
      Context.get(services, HttpServer.HttpServer).address,
    ).replace("[::]", "localhost");
    const connection = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new PanelPluginConnection({
            id: "demo",
            connection: {
              kind: "sidecar",
              command: process.execPath,
              args: [
                NodeURL.fileURLToPath(
                  new URL("../../scripts/plugin-spa-demo.mjs", import.meta.url),
                ),
              ],
            },
          }),
      ),
      (value) => Effect.sync(() => value.stop()),
    );
    const ready = Promise.withResolvers<string>();
    connection.subscribe({
      input: { threadId: ThreadId.make("spa-thread"), filters: [] },
      cwd: "/workspace/spa",
      emit: (snapshot, endpoint) => {
        const rewritten = session.rewrite(snapshot, endpoint);
        const panel = rewritten.panels[0];
        if (panel?.kind === "web") ready.resolve(panel.path);
      },
    });
    const path = yield* Effect.promise(() => ready.promise);
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ headless: true })),
      (value) => Effect.promise(() => value.close()),
    );
    yield* Effect.promise(async () => {
      const page = await browser.newPage();
      await page.goto(`${origin}/host`);
      const direct = await page.request.get(`${origin}${path}`);
      expect(direct.status()).toBe(200);
      const socketOpened = Promise.withResolvers<import("playwright-core").WebSocket>();
      page.once("websocket", (socket) => socketOpened.resolve(socket));
      await page.setContent(
        `<iframe title="Plugin" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="${origin}${path}"></iframe>`,
      );
      const frame = page.frameLocator("iframe");
      await frame.getByText("Dynamic module loaded").waitFor();
      await frame.getByText("spa-thread", { exact: true }).waitFor();
      await frame.getByText("Isolated", { exact: true }).waitFor();
      await frame.locator('#count[data-live="true"]').waitFor();
      const mutation = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/count") && response.request().method() === "POST",
      );
      await frame.getByRole("button", { name: "Increment" }).click();
      const mutationResponse = await mutation;
      expect(mutationResponse.status()).toBe(204);
      await frame.locator('#increment[data-status="204"]').waitFor();
      await frame.locator("#count").filter({ hasText: /^1$/ }).waitFor();
      expect(await frame.locator("#count").innerText()).toBe("1");
      const socket = await socketOpened.promise;
      const closed = socket.waitForEvent("close");
      session.close();
      await closed;
      const response = await page.request.get(`${origin}${path}api/context`);
      expect(response.status()).toBe(404);
    });
  }),
);
