// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise real files and a real loopback HTTP service.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  manifestFileIdentity,
  normalizeLoopbackBaseUrl,
  pluginManifestDirectory,
  readManifests,
  scanLivePlugins,
} from "./PluginManifests.ts";

const ID = "github.com/acme/example";
const FILE = "github.com+acme+example.json";
/** A conforming file name for one running instance of the example plugin. */
const instanceFile = (instance: string) => `github.com+acme+example+${instance}.json`;

const manifest = (baseUrl: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    protocol: 1,
    id: ID,
    name: "Example",
    connection: { kind: "server", baseUrl },
    ...overrides,
  });

const withDirectory = <A>(body: (directory: string) => A) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-manifests-"));
  NodeFS.chmodSync(directory, 0o700);
  try {
    return body(directory);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
};

describe("manifest location and endpoints", () => {
  it("prefers an absolute XDG_DATA_HOME and ignores a relative one", () => {
    expect(pluginManifestDirectory({ XDG_DATA_HOME: "/data" }, "/home/u")).toBe(
      "/data/t3code/plugins",
    );
    expect(pluginManifestDirectory({ XDG_DATA_HOME: "relative" }, "/home/u")).toBe(
      "/home/u/.local/share/t3code/plugins",
    );
    expect(pluginManifestDirectory({ XDG_DATA_HOME: "" }, "/home/u")).toBe(
      "/home/u/.local/share/t3code/plugins",
    );
    expect(pluginManifestDirectory({}, "/home/u")).toBe("/home/u/.local/share/t3code/plugins");
  });

  it("accepts only explicit-port loopback http endpoints without credentials or queries", () => {
    expect(normalizeLoopbackBaseUrl("http://127.0.0.1:18743/plugins/t3")).toBe(
      "http://127.0.0.1:18743/plugins/t3",
    );
    expect(normalizeLoopbackBaseUrl("http://localhost:9/p")).toBe("http://localhost:9/p");
    expect(normalizeLoopbackBaseUrl("http://[::1]:9/p")).toBe("http://[::1]:9/p");
    for (const rejected of [
      "https://127.0.0.1:9/p",
      "http://127.0.0.1/p",
      "http://example.com:9/p",
      "http://192.168.1.4:9/p",
      "http://0.0.0.0:9/p",
      "http://127.0.0.2:9/p",
      "http://user:pw@127.0.0.1:9/p",
      "http://127.0.0.1:9/p?key=x",
      "http://127.0.0.1:9/p#frag",
      `http://127.0.0.1:9/${"a".repeat(300)}`,
      "ws://127.0.0.1:9/p",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(normalizeLoopbackBaseUrl(rejected), rejected).toBeUndefined();
    }
  });
});

describe("manifest file names", () => {
  it("maps host+owner+repo[+instance].json to the identity it claims", () => {
    expect(manifestFileIdentity("github.com+marcelocantos+bullseye.json")).toBe(
      "github.com/marcelocantos/bullseye",
    );
    expect(manifestFileIdentity("github.com+marcelocantos+bullseye+18743.json")).toBe(
      "github.com/marcelocantos/bullseye",
    );
    expect(manifestFileIdentity("gitlab.example.com+team+my_repo.v2+a-b.json")).toBe(
      "gitlab.example.com/team/my_repo.v2",
    );
    for (const rejected of [
      "bullseye.json",
      "github.com+marcelocantos.json",
      "github.com+marcelocantos+bullseye+1+2.json",
      "github.com+marcelocantos+bullseye+.json",
      "github.com+marcelocantos+bullseye+A.json",
      "github.com++bullseye.json",
      "github.com+..+bullseye.json",
      "github.com+marcelocantos+Bullseye.json",
      "github.com+marcelocantos+bullseye.txt",
      "github.com/marcelocantos/bullseye.json",
      ".github.com+marcelocantos+bullseye.json.1.tmp",
    ]) {
      expect(manifestFileIdentity(rejected), rejected).toBeUndefined();
    }
  });
});

describe("reading manifests", () => {
  it("reads valid manifests and ignores unknown fields", () => {
    withDirectory((directory) => {
      NodeFS.writeFileSync(
        NodePath.join(directory, instanceFile("1")),
        manifest("http://127.0.0.1:9/plugins/example", { future: { anything: true } }),
      );
      expect(readManifests(directory)).toMatchObject([
        { id: ID, name: "Example", baseUrl: "http://127.0.0.1:9/plugins/example" },
      ]);
    });
  });

  it("skips malformed, incompatible, command-bearing, oversized and unsafe files", () => {
    withDirectory((directory) => {
      const write = (name: string, contents: string) =>
        NodeFS.writeFileSync(NodePath.join(directory, name), contents);
      write("garbage.json", "{not json");
      write("array.json", "[]");
      write("future-protocol.json", manifest("http://127.0.0.1:9/p", { protocol: 2 }));
      // The id must be a lowercase host/owner/repo, and the file must be named for exactly that id.
      write(instanceFile("a"), manifest("http://127.0.0.1:9/p", { id: "../etc" }));
      write(instanceFile("b"), manifest("http://127.0.0.1:9/p", { id: "example" }));
      write(instanceFile("c"), manifest("http://127.0.0.1:9/p", { id: "GitHub.com/acme/example" }));
      write(instanceFile("d"), manifest("http://127.0.0.1:9/p", { id: "github.com/acme/other" }));
      write(instanceFile("e"), manifest("http://127.0.0.1:9/p", { id: "github.com/acme/ex+am" }));
      write("example.json", manifest("http://127.0.0.1:9/p"));
      write("github.com+acme.json", manifest("http://127.0.0.1:9/p"));
      write("github.com+acme+example+a+b.json", manifest("http://127.0.0.1:9/p"));
      write("github.com+acme+Other.json", manifest("http://127.0.0.1:9/p"));
      write(instanceFile("f"), manifest("http://127.0.0.1:9/p", { name: "" }));
      write(instanceFile("g"), manifest("http://example.com:9/p"));
      write(
        instanceFile("sidecar"),
        manifest("http://127.0.0.1:9/p", {
          connection: { kind: "sidecar", command: "/bin/sh", args: ["-c", "true"] },
        }),
      );
      write(instanceFile("huge"), manifest("http://127.0.0.1:9/p", { name: "x".repeat(10_000) }));
      write("notes.txt", manifest("http://127.0.0.1:9/p"));
      write(".example-9.json.123.tmp", manifest("http://127.0.0.1:9/p"));
      NodeFS.symlinkSync(
        NodePath.join(directory, instanceFile("g")),
        NodePath.join(directory, instanceFile("link")),
      );
      NodeFS.mkdirSync(NodePath.join(directory, instanceFile("dir")));
      write(FILE, manifest("http://127.0.0.1:9/p"));
      expect(readManifests(directory).map((found) => found.baseUrl)).toEqual([
        "http://127.0.0.1:9/p",
      ]);
    });
  });

  it("examines a bounded number of files", () => {
    withDirectory((directory) => {
      for (let index = 0; index < 100; index++) {
        NodeFS.writeFileSync(
          NodePath.join(directory, instanceFile(String(index).padStart(3, "0"))),
          manifest(`http://127.0.0.1:${9000 + index}/p`),
        );
      }
      expect(readManifests(directory)).toHaveLength(32);
    });
  });

  it("does not trust a plugin directory other users can write", () => {
    withDirectory((directory) => {
      NodeFS.writeFileSync(NodePath.join(directory, FILE), manifest("http://127.0.0.1:9/p"));
      NodeFS.chmodSync(directory, 0o777);
      expect(readManifests(directory)).toEqual([]);
      NodeFS.chmodSync(directory, 0o700);
      expect(readManifests(directory)).toHaveLength(1);
    });
    expect(readManifests("/nonexistent/t3-plugins")).toEqual([]);
  });
});

interface Upstream {
  readonly port: number;
  readonly requests: Array<{
    url: string | undefined;
    headers: NodeHttp.IncomingHttpHeaders;
    method: string | undefined;
  }>;
}

const upstream = (respond: (response: NodeHttp.ServerResponse, url: string | undefined) => void) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const requests: Upstream["requests"] = [];
      const server = NodeHttp.createServer((request, response) => {
        requests.push({ url: request.url, headers: request.headers, method: request.method });
        respond(response, request.url);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No upstream address");
      return {
        port: address.port,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    }),
    (started) => Effect.promise(() => started.close()),
  );

const scopedDirectory = Effect.acquireRelease(
  Effect.sync(() => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-manifests-"));
    NodeFS.chmodSync(directory, 0o700);
    return directory;
  }),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);

const json = (response: NodeHttp.ServerResponse, body: unknown, type = "application/json") =>
  response.writeHead(200, { "content-type": type }).end(JSON.stringify(body));

const example = { protocol: 1, id: ID, name: "Example" };

describe("probing advertised services", () => {
  it.live("confirms a compatible service with a context-free GET", () =>
    Effect.gen(function* () {
      const service = yield* upstream((response) => json(response, example));
      const directory = yield* scopedDirectory;
      NodeFS.writeFileSync(
        NodePath.join(directory, instanceFile("1")),
        manifest(`http://127.0.0.1:${service.port}/plugins/example`),
      );
      const live = yield* scanLivePlugins(directory);
      expect(live.map((found) => found.id)).toEqual([ID]);
      expect(service.requests).toHaveLength(1);
      const [request] = service.requests;
      expect(request?.method).toBe("GET");
      expect(request?.url).toBe("/plugins/example");
      // Nothing identifying a thread, workspace, credential or browser goes with the probe.
      for (const header of ["upgrade", "origin", "authorization", "cookie", "x-t3-thread-id"]) {
        expect(request?.headers[header], header).toBeUndefined();
      }
    }).pipe(Effect.scoped),
  );

  it.live("drops services that are stale, impostors, redirects or not JSON", () =>
    Effect.gen(function* () {
      const service = yield* upstream((response, url) => {
        if (url === "/wrong-id") return json(response, { ...example, id: "other" });
        if (url === "/wrong-name") return json(response, { ...example, name: "Other" });
        if (url === "/future") return json(response, { ...example, protocol: 2 });
        if (url === "/html") return json(response, example, "text/html");
        if (url === "/redirect") return void response.writeHead(302, { location: "/ok" }).end();
        if (url === "/missing") return void response.writeHead(404).end();
        if (url === "/huge") return json(response, { ...example, pad: "x".repeat(5000) });
        return json(response, example);
      });
      // A port nothing listens on: the daemon that advertised it is gone.
      const gonePort = yield* Effect.scoped(upstream(() => undefined)).pipe(
        Effect.map((gone) => gone.port),
      );
      const directory = yield* scopedDirectory;
      for (const path of [
        "wrong-id",
        "wrong-name",
        "future",
        "html",
        "redirect",
        "missing",
        "huge",
        "ok",
      ]) {
        NodeFS.writeFileSync(
          NodePath.join(directory, instanceFile(path)),
          manifest(`http://127.0.0.1:${service.port}/${path}`),
        );
      }
      NodeFS.writeFileSync(
        NodePath.join(directory, instanceFile("stale")),
        manifest(`http://127.0.0.1:${gonePort}/plugins/example`),
      );
      const live = yield* scanLivePlugins(directory);
      expect(live.map((found) => found.baseUrl)).toEqual([`http://127.0.0.1:${service.port}/ok`]);
    }).pipe(Effect.scoped),
  );

  it.live("probes an endpoint once however many manifests name it", () =>
    Effect.gen(function* () {
      const service = yield* upstream((response) => json(response, example));
      const directory = yield* scopedDirectory;
      for (const name of [instanceFile("a"), instanceFile("b"), instanceFile("c")]) {
        NodeFS.writeFileSync(
          NodePath.join(directory, name),
          manifest(`http://127.0.0.1:${service.port}/p`),
        );
      }
      expect(yield* scanLivePlugins(directory)).toHaveLength(1);
      expect(service.requests).toHaveLength(1);
    }).pipe(Effect.scoped),
  );
});
