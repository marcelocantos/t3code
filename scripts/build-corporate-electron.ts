// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Build and verify the native runtime without loading application services.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import source from "./lib/corporate-electron-source.json" with { type: "json" };
import { verifyCorporateNativePayload } from "./lib/corporate-electron-distribution.ts";

const host = Effect.runSync(
  Effect.all({ platform: HostProcess.Platform, arch: HostProcess.Architecture }),
);

const { values } = NodeUtil.parseArgs({
  options: {
    "output-dir": { type: "string" },
    "sdk-path": { type: "string" },
    jobs: { type: "string", default: "8" },
  },
});
NodeAssert.ok(
  host.platform === "darwin" && host.arch === "arm64",
  "The corporate Electron patch currently targets macOS arm64.",
);
NodeAssert.ok(values["output-dir"], "Pass --output-dir for the verified Electron distribution.");
NodeAssert.ok(values["sdk-path"], "Pass --sdk-path with the macOS 26.5 SDK.");
const metalVersion = NodeChildProcess.execFileSync(
  "xcrun",
  ["--sdk", "macosx", "metal", "--version"],
  {
    encoding: "utf8",
  },
).trim();
const jobs = Number(values.jobs);
NodeAssert.ok(Number.isInteger(jobs) && jobs > 0, "--jobs must be a positive integer.");
const sdk = NodePath.resolve(values["sdk-path"]);
const sdkSettings = JSON.parse(
  await NodeFSP.readFile(NodePath.join(sdk, "SDKSettings.json"), "utf8"),
);
NodeAssert.equal(
  sdkSettings.Version,
  source.sdk,
  "Use the pinned SDK version; newer SDK targets can be incompatible with the pinned linker.",
);
const output = NodePath.resolve(values["output-dir"]);
await NodeFSP.access(NodePath.dirname(output));
await NodeAssert.rejects(
  NodeFSP.access(output),
  { code: "ENOENT" },
  "The output directory must not exist.",
);
const scratchRoot = NodeChildProcess.execFileSync("scratch-root", { encoding: "utf8" }).trim();
const task = await NodeFSP.mkdtemp(NodePath.join(scratchRoot, "t3code-corporate-electron-"));
console.log(`Corporate Electron source and build: ${task}`);

const patches = [
  ["corporate-electron.patch", "src/electron"],
  ["corporate-electron-node.patch", "src/third_party/electron_node"],
  ["corporate-chromium.patch", "src"],
  ["corporate-webrtc.patch", "src/third_party/webrtc"],
] as const;
const patchDigests: Record<string, string> = {};
for (const [name] of patches) {
  const bytes = await NodeFSP.readFile(NodePath.join(import.meta.dirname, "lib", name));
  await NodeFSP.writeFile(NodePath.join(task, name), bytes, { flag: "wx" });
  patchDigests[name] = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}
const buildEnv = {
  ...process.env,
  DEPOT_TOOLS_UPDATE: "0",
  DEPOT_TOOLS_METRICS: "0",
  GIT_CACHE_PATH: NodePath.join(task, "git-cache"),
  PATH: NodePath.join(task, "depot_tools") + NodePath.delimiter + process.env.PATH,
};
const run = async (
  command: string,
  args: string[],
  cwd = task,
  env: NodeJS.ProcessEnv = buildEnv,
) => {
  const child = NodeChildProcess.spawn(command, args, { cwd, env, stdio: "inherit" });
  const [code, signal] = await NodeEvents.EventEmitter.once(child, "exit");
  NodeAssert.equal(signal, null, `${command} interrupted; source retained at ${task}.`);
  NodeAssert.equal(code, 0, `${command} failed; source retained at ${task}.`);
};
await run("git", ["init", "depot_tools"]);
const depot = NodePath.join(task, "depot_tools");
await run(
  "git",
  ["remote", "add", "origin", "https://chromium.googlesource.com/chromium/tools/depot_tools.git"],
  depot,
);
await run("git", ["fetch", "--depth=1", "origin", source.depotToolsCommit], depot);
await run("git", ["checkout", "--detach", "FETCH_HEAD"], depot);
const gclient = NodePath.join(depot, "gclient");
await run(gclient, [
  "config",
  "--name",
  "src/electron",
  "--unmanaged",
  `https://github.com/electron/electron.git@${source.commit}`,
]);
await run(gclient, [
  "sync",
  "--nohooks",
  "--no-history",
  "--revision",
  `src/electron@${source.commit}`,
]);
await run(gclient, ["runhooks"]);
await run("git", ["pack-refs", "--all"], NodePath.join(task, "src/electron"));
for (const [name, directory] of patches) {
  await run("git", ["apply", "--check", NodePath.join(task, name)], NodePath.join(task, directory));
  await run("git", ["apply", NodePath.join(task, name)], NodePath.join(task, directory));
}
const src = NodePath.join(task, "src");
const build = NodePath.join(src, "out/Corporate");
await NodeFSP.mkdir(NodePath.join(build, "sdk"), { recursive: true });
await NodeFSP.symlink(sdk, NodePath.join(build, "sdk/CorporateMacOSX26.5.sdk"));
await run(
  NodePath.join(src, "buildtools/mac/gn"),
  ["gen", "out/Corporate", `--args=${source.gnArgs}`],
  src,
);
await run(
  NodePath.join(src, "third_party/ninja/ninja"),
  [`-j${jobs}`, "-C", "out/Corporate", "electron:electron_dist_zip"],
  src,
);
await NodeFSP.mkdir(output);
await run("ditto", ["-xk", NodePath.join(build, "dist.zip"), output]);
await NodeFSP.rm(
  NodePath.join(
    output,
    "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
  ),
);
for (const framework of ["Squirrel.framework", "ReactiveObjC.framework", "Mantle.framework"]) {
  await NodeFSP.rm(NodePath.join(output, "Electron.app/Contents/Frameworks", framework), {
    recursive: true,
    force: true,
  });
}
await verifyCorporateNativePayload(NodePath.join(output, "Electron.app"));
const runtime = NodePath.join(output, "Electron.app/Contents/MacOS/Electron");
await run(
  process.execPath,
  [
    NodePath.join(import.meta.dirname, "corporate-runtime-check.ts"),
    "--runtime",
    runtime,
    "--electron",
    "--harness-node",
    process.execPath,
  ],
  src,
);
const control = NodePath.resolve(
  import.meta.dirname,
  "../apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
await run(
  process.execPath,
  [
    NodePath.join(import.meta.dirname, "corporate-electron-check.ts"),
    "--runtime",
    runtime,
    "--control-runtime",
    control,
    "--output",
    NodePath.join(task, "network-evidence.json"),
  ],
  src,
);
await NodeFSP.copyFile(
  NodePath.join(src, "third_party/electron_node/LICENSE"),
  NodePath.join(output, "NODE-LICENSE"),
);
await NodeFSP.copyFile(
  NodePath.join(src, "third_party/electron_node/deps/openssl/openssl/LICENSE.txt"),
  NodePath.join(output, "CORPORATE-PATCH-LICENSE"),
);
await NodeFSP.writeFile(
  NodePath.join(output, "CORPORATE-NOTICE"),
  "Network policy patches: Copyright 2026 Marcelo Cantos. Licensed under Apache-2.0; see CORPORATE-PATCH-LICENSE.\n",
);
await NodeFSP.copyFile(
  NodePath.join(task, "network-evidence.json"),
  NodePath.join(output, "network-evidence.json"),
);
const files: Record<string, { sha256: string } | { symlink: string }> = {};
const fingerprint = async (directory: string): Promise<void> => {
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const full = NodePath.join(directory, entry.name);
    const relative = NodePath.relative(output, full);
    if (entry.isDirectory()) await fingerprint(full);
    else if (entry.isSymbolicLink()) {
      const target = await NodeFSP.readlink(full);
      const destination = NodePath.relative(output, NodePath.resolve(directory, target));
      NodeAssert.ok(
        destination !== ".." && !destination.startsWith(".." + NodePath.sep),
        "Runtime symlink escapes its distribution.",
      );
      files[relative] = { symlink: target };
    } else if (entry.isFile()) {
      const hash = NodeCrypto.createHash("sha256");
      for await (const chunk of NodeFS.createReadStream(full)) hash.update(chunk);
      files[relative] = { sha256: hash.digest("hex") };
    } else throw new Error(`Unexpected runtime file type: ${relative}`);
  }
};
await fingerprint(output);
await NodeFSP.writeFile(
  NodePath.join(output, "provenance.json"),
  JSON.stringify(
    {
      ...source,
      platform: host.platform,
      arch: host.arch,
      patches: patchDigests,
      oraclePassed: true,
      metalVersion,
      files,
    },
    null,
    2,
  ) + "\n",
);
await NodeFSP.rm(task, { recursive: true });
console.log(`Verified corporate Electron distribution: ${output}`);
