// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Build the runtime without loading application libraries.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import source from "./lib/corporate-node-source.json" with { type: "json" };

const host = Effect.runSync(
  Effect.all({ platform: HostProcess.Platform, arch: HostProcess.Architecture }),
);

const { values } = NodeUtil.parseArgs({ options: { "output-dir": { type: "string" } } });
NodeAssert.ok(
  values["output-dir"],
  "Pass --output-dir for the runtime, provenance and upstream licence.",
);
NodeAssert.ok(host.platform !== "win32", "Build the corporate Node runtime on macOS or Linux.");
const output = NodePath.resolve(values["output-dir"]);
await NodeFSP.access(NodePath.dirname(output));
await NodeAssert.rejects(
  NodeFSP.access(output),
  { code: "ENOENT" },
  "The output directory must not exist.",
);

const scratchRoot = NodeChildProcess.execFileSync("scratch-root", { encoding: "utf8" }).trim();
const task = await NodeFSP.mkdtemp(NodePath.join(scratchRoot, "t3code-corporate-node-"));
console.log(`Corporate Node source and build: ${task}`);
const patch = await NodeFSP.readFile(
  NodePath.join(import.meta.dirname, "lib/corporate-node.patch"),
);
const patchPath = NodePath.join(task, "corporate-node.patch");
await NodeFSP.writeFile(patchPath, patch, { flag: "wx" });
const patchSha256 = NodeCrypto.createHash("sha256").update(patch).digest("hex");

const run = async (command: string, args: string[], cwd: string, stdout?: number) => {
  const child = NodeChildProcess.spawn(command, args, {
    cwd,
    stdio: ["ignore", stdout ?? "inherit", "inherit"],
  });
  const [code, signal] = await NodeEvents.EventEmitter.once(child, "exit");
  NodeAssert.equal(signal, null, `${command} was interrupted.`);
  NodeAssert.equal(code, 0, `${command} failed; source and build are retained at ${task}.`);
};

const archive = NodePath.join(task, "node.tar.gz");
const archiveFile = await NodeFSP.open(archive, "wx");
try {
  await run("gh", ["api", source.archive], task, archiveFile.fd);
} finally {
  await archiveFile.close();
}
const digest = NodeCrypto.createHash("sha256");
for await (const chunk of NodeFS.createReadStream(archive)) digest.update(chunk);
NodeAssert.equal(digest.digest("hex"), source.sha256, "Pinned Node archive checksum mismatch.");

const sourceDir = NodePath.join(task, "source");
await NodeFSP.mkdir(sourceDir);
await run("tar", ["-xzf", archive, "--strip-components=1", "-C", sourceDir], task);
await run("git", ["apply", "--check", patchPath], sourceDir);
await run("git", ["apply", patchPath], sourceDir);
await run("./configure", source.configure, sourceDir);
await run("ninja", ["-C", "out/Release", "node"], sourceDir);
const runtime = NodePath.join(sourceDir, "out/Release/node");
await run(
  process.execPath,
  [
    NodePath.join(import.meta.dirname, "corporate-runtime-check.ts"),
    "--runtime",
    runtime,
    "--harness-node",
    process.execPath,
  ],
  sourceDir,
);

await NodeFSP.mkdir(output);
await NodeFSP.copyFile(runtime, NodePath.join(output, "node"));
await NodeFSP.chmod(NodePath.join(output, "node"), 0o755);
await NodeFSP.copyFile(NodePath.join(sourceDir, "LICENSE"), NodePath.join(output, "NODE-LICENSE"));
await NodeFSP.copyFile(
  NodePath.join(sourceDir, "deps/openssl/openssl/LICENSE.txt"),
  NodePath.join(output, "CORPORATE-PATCH-LICENSE"),
);
await NodeFSP.writeFile(
  NodePath.join(output, "CORPORATE-NOTICE"),
  "Network policy patches: Copyright 2026 Marcelo Cantos. Licensed under Apache-2.0; see CORPORATE-PATCH-LICENSE.\n",
);
const runtimeDigest = NodeCrypto.createHash("sha256");
for await (const chunk of NodeFS.createReadStream(runtime)) runtimeDigest.update(chunk);
await NodeFSP.writeFile(
  NodePath.join(output, "provenance.json"),
  JSON.stringify(
    {
      ...source,
      platform: host.platform,
      arch: host.arch,
      patchSha256,
      runtimeSha256: runtimeDigest.digest("hex"),
      oraclePassed: true,
    },
    null,
    2,
  ) + "\n",
);
await NodeFSP.rm(task, { recursive: true });
console.log(`Verified corporate Node runtime: ${output}`);
