import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { WebSocket } from "@effect/platform-node/NodeWS";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  HttpClient,
  HttpClientRequest,
  HttpMethod,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { requestUrl } from "../requestUrl.ts";
import * as PluginGateway from "./PluginGateway.ts";
import {
  PLUGIN_GATEWAY_PREFIX,
  pluginRelativePath,
  type PluginGatewayGrant,
} from "./PluginGatewaySessions.ts";

const REQUEST_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const ACTIVE_LIMIT = 32;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
class GatewayError extends Schema.TaggedError<GatewayError>()("PluginGatewayError", {
  cause: Schema.Defect(),
}) {}

const bytes = Effect.fn("PluginGateway.readBody")(function* (
  stream: Stream.Stream<Uint8Array, unknown>,
  limit: number,
) {
  let size = 0;
  const chunks = yield* stream.pipe(
    Stream.mapError((cause) => new GatewayError({ cause })),
    Stream.runFoldEffect(
      () => [] as Uint8Array[],
      (chunks, chunk) => {
        size += chunk.byteLength;
        return size > limit
          ? Effect.fail(new GatewayError({ cause: "Body limit" }))
          : Effect.sync(() => {
              chunks.push(chunk);
              return chunks;
            });
      },
    ),
  );
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
});

// Retain an error listener while Effect tears down a connecting native WebSocket.
const socketConstructor = Layer.succeed(Socket.WebSocketConstructor)((url, options) => {
  const protocols =
    options === undefined || typeof options === "string" || Array.isArray(options)
      ? options
      : options.protocols;
  const headers =
    typeof options === "object" && !Array.isArray(options) ? options.headers : undefined;
  const socket = new WebSocket(url, protocols, {
    ...(headers ? { headers } : {}),
    maxPayload: REQUEST_LIMIT,
  });
  socket.addEventListener("error", () => undefined);
  return socket;
});

const pump = Effect.fnUntraced(function* (source: Socket.Socket, target: Socket.Writer) {
  // Continuous frame forwarding shares its enclosing gateway request span.
  const { pull } = yield* source.reader;
  while (true) {
    const frames = yield* pull;
    for (const frame of frames) {
      if (
        (typeof frame === "string" ? new TextEncoder().encode(frame).length : frame.byteLength) >
        REQUEST_LIMIT
      ) {
        return yield* new GatewayError({ cause: "Frame limit" });
      }
    }
    yield* target.writeAll(frames);
  }
});

const proxySocket = Effect.fn("PluginGateway.socket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  url: string,
  grant: PluginGatewayGrant,
) {
  const upstream = yield* Socket.makeWebSocket(url.replace(/^http/, "ws"), {
    openTimeout: "10 seconds",
    headers: { "x-t3-thread-id": grant.threadId, "x-t3-workspace": encodeURIComponent(grant.cwd) },
  }).pipe(Effect.provide(socketConstructor));
  const client = yield* request.upgrade;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const toClient = yield* client.writer;
      const toUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(pump(upstream, toClient), pump(client, toUpstream));
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("PluginGateway.http")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  grant: PluginGatewayGrant,
  headers: Record<string, string>,
) {
  const body =
    request.method === "GET" ||
    request.method === "HEAD" ||
    (request.source instanceof Request && request.source.body === null)
      ? undefined
      : yield* bytes(request.stream, REQUEST_LIMIT);
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  if (!HttpMethod.isHttpMethod(method)) return HttpServerResponse.empty({ status: 405 });
  const upstreamRequest = HttpClientRequest.make(method)(upstreamUrl).pipe(
    HttpClientRequest.setHeaders({
      accept: request.headers.accept ?? "*/*",
      "content-type": request.headers["content-type"] ?? "application/octet-stream",
      "x-t3-thread-id": grant.threadId,
      "x-t3-workspace": encodeURIComponent(grant.cwd),
    }),
    body ? HttpClientRequest.bodyUint8Array(body, request.headers["content-type"]) : (self) => self,
  );
  const response = yield* client.execute(upstreamRequest);
  if (response.status >= 300 && response.status < 400) {
    return HttpServerResponse.text("Plugin redirects are not supported", { status: 502, headers });
  }
  if (method === "HEAD" || response.status === 204 || response.status === 205) {
    return HttpServerResponse.empty({ status: response.status, headers });
  }
  const data = yield* bytes(response.stream, RESPONSE_LIMIT);
  return HttpServerResponse.uint8Array(data, {
    status: response.status,
    headers: {
      ...headers,
      "content-type": response.headers["content-type"] ?? "application/octet-stream",
    },
  });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const parsed = requestUrl(request);
  const sessions = yield* PluginGateway.PluginGateway;
  if (Option.isNone(parsed)) return HttpServerResponse.empty({ status: 400 });
  // Inspect the raw request target before URL's dot-segment normalization.
  const rawPath = request.url.split("?", 1)[0]!;
  if (!pluginRelativePath(rawPath) || !rawPath.startsWith(PLUGIN_GATEWAY_PREFIX))
    return HttpServerResponse.empty({ status: 400 });
  const suffix = rawPath.slice(PLUGIN_GATEWAY_PREFIX.length);
  const slash = suffix.indexOf("/");
  if (slash < 0) return HttpServerResponse.empty({ status: 404 });
  const token = suffix.slice(0, slash);
  const grant = sessions.get(token);
  if (!grant || grant.abort.signal.aborted) return HttpServerResponse.empty({ status: 404 });
  if (!METHODS.has(request.method)) return HttpServerResponse.empty({ status: 405 });
  const root = new URL(`${PLUGIN_GATEWAY_PREFIX}${token}/`, parsed.value).href;
  const wsRoot = root.replace(/^http/, "ws");
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "null",
    "access-control-allow-methods": [...METHODS].join(", "),
    "access-control-allow-headers": "content-type, accept",
    "content-security-policy": `sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' ${root}; style-src 'unsafe-inline' ${root}; img-src data: blob: ${root}; font-src ${root}; connect-src ${root} ${wsRoot}; base-uri ${root}; form-action ${root}; frame-src 'none'; worker-src 'none'; object-src 'none'`,
  };
  if (request.method === "OPTIONS") return HttpServerResponse.empty({ status: 204, headers });
  if (grant.active >= ACTIVE_LIMIT) return HttpServerResponse.empty({ status: 429, headers });
  const relative = suffix.slice(slash + 1);
  const upstream = new URL(relative + parsed.value.search, grant.upstreamRoot);
  if (!upstream.href.startsWith(grant.upstreamRoot))
    return HttpServerResponse.empty({ status: 400 });
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      grant.active++;
    }),
    () =>
      Effect.sync(() => {
        grant.active--;
      }),
  );
  const revoked = Effect.callback<never, GatewayError>((resume) => {
    const abort = () => resume(Effect.fail(new GatewayError({ cause: "Revoked" })));
    grant.abort.signal.addEventListener("abort", abort, { once: true });
    if (grant.abort.signal.aborted) abort();
    return Effect.sync(() => grant.abort.signal.removeEventListener("abort", abort));
  });
  const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
  const forward = upgrade
    ? proxySocket(request, upstream.href, grant).pipe(
        Effect.mapError((cause) => new GatewayError({ cause })),
      )
    : proxyHttp(request, upstream.href, grant, headers).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) => new GatewayError({ cause })),
      );
  return yield* Effect.raceFirst(forward, revoked).pipe(
    Effect.orElseSucceed(() =>
      HttpServerResponse.text("Plugin gateway unavailable", { status: 502, headers }),
    ),
  );
});

export const layer = HttpRouter.add(
  "*",
  `${PLUGIN_GATEWAY_PREFIX}*`,
  Effect.scoped(handler).pipe(
    HttpMiddleware.withLoggerDisabled,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", credentials: "omit" }),
    Effect.provide(FetchHttpClient.layer),
  ),
);
