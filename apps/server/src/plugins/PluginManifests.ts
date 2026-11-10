// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Node fs/http adapter: guarded manifest reads and a bounded loopback probe.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { PluginIdentity, PluginPanelScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readThemeFileGuarded } from "../environmentTheme.ts";

/**
 * A plugin advertises itself by writing one JSON file into the per-user plugin directory
 * (`$XDG_DATA_HOME/t3code/plugins`, else `~/.local/share/t3code/plugins`), named after its
 * identity (see `manifestFileIdentity`). The manifest is only a pointer: nothing in it is executed,
 * and T3 asks its user before connecting.
 */
const MAX_MANIFEST_FILES = 32;
const MAX_MANIFEST_BYTES = 4 * 1024;
const MAX_PROBE_BYTES = 1024;
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_CONCURRENCY = 4;
const MANIFEST_SUFFIX = ".json";
const INSTANCE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const Name = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const Manifest = Schema.Struct({
  protocol: Schema.Literal(1),
  id: PluginIdentity,
  name: Name,
  connection: Schema.Struct({
    kind: Schema.Literal("server"),
    baseUrl: Schema.String.check(Schema.isMaxLength(2048)),
  }),
});
const ProbeResponse = Schema.Struct({
  protocol: Schema.Literal(1),
  id: PluginIdentity,
  name: Name,
  // Strings, not literals: a scope this T3 doesn't know must not make the plugin incompatible.
  scopes: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(8))),
});
const isPluginIdentity = Schema.is(PluginIdentity);
const isPluginPanelScope = Schema.is(PluginPanelScope);
const decodeManifest = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest));
const decodeProbe = Schema.decodeUnknownOption(Schema.fromJsonString(ProbeResponse));

export interface PluginCandidate {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  /** Newest manifest advertising this endpoint, for choosing among several. */
  readonly mtimeMs: number;
  /** Scopes the probe answer declared; absent means thread panels only. */
  readonly scopes?: ReadonlyArray<PluginPanelScope>;
}

/**
 * The identity a manifest file name claims: `host+owner+repo.json`, optionally with one more
 * `+instance` segment so several running instances of one plugin never share a file. `+` cannot
 * occur inside an identity segment, so the mapping is exact. Undefined for any other name.
 */
export function manifestFileIdentity(fileName: string): string | undefined {
  if (!fileName.endsWith(MANIFEST_SUFFIX)) return undefined;
  const parts = fileName.slice(0, -MANIFEST_SUFFIX.length).split("+");
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  if (parts.length === 4 && !INSTANCE.test(parts[3] ?? "")) return undefined;
  const id = parts.slice(0, 3).join("/");
  return isPluginIdentity(id) ? id : undefined;
}

export function pluginManifestDirectory(
  env: { readonly XDG_DATA_HOME?: string | undefined },
  homeDirectory: string,
): string {
  const xdg = env.XDG_DATA_HOME;
  const base =
    xdg !== undefined && xdg !== "" && NodePath.isAbsolute(xdg)
      ? xdg
      : NodePath.join(homeDirectory, ".local", "share");
  return NodePath.join(base, "t3code", "plugins");
}

/** The canonical form of a discoverable endpoint, or undefined if T3 must not connect to it. */
export function normalizeLoopbackBaseUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.port === "" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.length > 256
  ) {
    return undefined;
  }
  return url.href;
}

/** Root-owned or world-writable plugin directories could let another user plant a manifest. */
function directoryIsTrusted(directory: string): boolean {
  try {
    const info = NodeFS.statSync(directory);
    if (!info.isDirectory()) return false;
    if (typeof process.getuid !== "function") return true;
    return info.uid === process.getuid() && (info.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** Valid manifests in `directory`; every malformed, oversized, foreign or excess file is skipped. */
export function readManifests(directory: string): ReadonlyArray<PluginCandidate> {
  if (!directoryIsTrusted(directory)) return [];
  let names: Array<string>;
  try {
    names = NodeFS.readdirSync(directory)
      .filter((name) => manifestFileIdentity(name) !== undefined)
      .toSorted()
      .slice(0, MAX_MANIFEST_FILES);
  } catch {
    return [];
  }
  const found: Array<PluginCandidate> = [];
  for (const name of names) {
    const file = NodePath.join(directory, name);
    const raw = readThemeFileGuarded(file, MAX_MANIFEST_BYTES);
    if (raw === null) continue;
    const manifest = decodeManifest(raw);
    if (manifest._tag === "None" || manifest.value.id !== manifestFileIdentity(name)) continue;
    const baseUrl = normalizeLoopbackBaseUrl(manifest.value.connection.baseUrl);
    if (baseUrl === undefined) continue;
    let mtimeMs: number;
    try {
      mtimeMs = NodeFS.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    found.push({ id: manifest.value.id, name: manifest.value.name, baseUrl, mtimeMs });
  }
  return found;
}

/**
 * Context-free compatibility check: a plain GET of the endpoint, with no thread, workspace or
 * upgrade, must name the same plugin. Redirects are not followed, and anything but a small JSON
 * answer counts as not compatible.
 */
function probePlugin(candidate: PluginCandidate): Promise<PluginCandidate | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: PluginCandidate | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = NodeHttp.request(
        candidate.baseUrl,
        {
          method: "GET",
          headers: { accept: "application/json" },
          agent: false,
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        },
        (response) => {
          const contentType = response.headers["content-type"] ?? "";
          if (response.statusCode !== 200 || !/^application\/json\s*(;|$)/i.test(contentType)) {
            response.resume();
            settle(undefined);
            return;
          }
          const chunks: Array<Buffer> = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_PROBE_BYTES) {
              response.destroy();
              settle(undefined);
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            const body = decodeProbe(Buffer.concat(chunks).toString("utf8"));
            if (
              body._tag === "None" ||
              body.value.id !== candidate.id ||
              body.value.name !== candidate.name
            ) {
              settle(undefined);
              return;
            }
            const declared = body.value.scopes;
            const scopes = declared && [...new Set(declared.filter(isPluginPanelScope))];
            settle(scopes ? { ...candidate, scopes } : candidate);
          });
          response.on("error", () => settle(undefined));
        },
      );
      request.on("error", () => settle(undefined));
      request.end();
    } catch {
      settle(undefined);
    }
  });
}

/**
 * Compatible services advertised right now, newest manifest first. Several manifests can name one
 * endpoint (or one plugin id from different endpoints); stale ones simply fail the probe.
 */
export const scanLivePlugins = Effect.fn("PluginManifests.scanLivePlugins")(function* (
  directory: string,
) {
  const newest = new Map<string, PluginCandidate>();
  for (const candidate of readManifests(directory)) {
    const key = `${candidate.id}\n${candidate.baseUrl}`;
    const existing = newest.get(key);
    if (!existing || candidate.mtimeMs > existing.mtimeMs) newest.set(key, candidate);
  }
  const probed = yield* Effect.forEach(
    [...newest.values()],
    (candidate) => Effect.promise(() => probePlugin(candidate)),
    { concurrency: PROBE_CONCURRENCY },
  );
  return probed
    .filter((candidate) => candidate !== undefined)
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs || a.baseUrl.localeCompare(b.baseUrl));
});
