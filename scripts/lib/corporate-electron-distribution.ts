// @effect-diagnostics nodeBuiltinImport:off - Verify the native distribution before the packager can select it.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { listPackage } from "@electron/asar";
import { isCorporateExcludedModule } from "./corporate-artifacts.ts";
import source from "./corporate-electron-source.json" with { type: "json" };

const EXCLUDED_NATIVE_COMPONENTS = new Set([
  "squirrel.framework",
  "reactiveobjc.framework",
  "mantle.framework",
  "shipit",
  "shipit.app",
  "chrome_crashpad_handler",
]);

export async function verifyCorporateNativePayload(appDirectory: string) {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const full = NodePath.join(directory, entry.name);
      NodeAssert.ok(
        !EXCLUDED_NATIVE_COMPONENTS.has(entry.name.toLowerCase()),
        "Excluded native component: " + full,
      );
      if (entry.isDirectory()) await visit(full);
    }
  };
  await visit(appDirectory);
  const framework = NodePath.join(
    appDirectory,
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  );
  const linked = NodeChildProcess.execFileSync("/usr/bin/otool", ["-L", framework], {
    encoding: "utf8",
  });
  NodeAssert.ok(
    !/(?:Squirrel|ReactiveObjC|Mantle)\.framework/iu.test(linked),
    "Corporate Electron still links an updater framework.",
  );
}

export async function verifyCorporateElectronDistribution(directory: string, repoRoot: string) {
  await verifyCorporateNativePayload(NodePath.join(directory, "Electron.app"));
  const root = NodePath.resolve(directory);
  const receipt = JSON.parse(
    await NodeFSP.readFile(NodePath.join(root, "provenance.json"), "utf8"),
  );
  NodeAssert.equal(receipt.version, source.version);
  NodeAssert.equal(receipt.commit, source.commit);
  NodeAssert.equal(receipt.platform, "darwin");
  NodeAssert.equal(receipt.arch, "arm64");
  NodeAssert.equal(receipt.oraclePassed, true);
  NodeAssert.ok(
    receipt.files && typeof receipt.files === "object" && Object.keys(receipt.files).length > 0,
  );
  const actualFiles = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const full = NodePath.join(directory, entry.name);
      const relative = NodePath.relative(root, full);
      if (relative === "provenance.json") continue;
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      actualFiles.add(relative);
      const expected = receipt.files[relative];
      NodeAssert.ok(expected, `Unattested runtime file: ${relative}`);
      if (entry.isSymbolicLink()) {
        const target = await NodeFSP.readlink(full);
        NodeAssert.equal(target, expected.symlink, `Runtime symlink changed: ${relative}`);
        const resolved = NodePath.relative(root, NodePath.resolve(directory, target));
        NodeAssert.ok(
          resolved !== ".." && !resolved.startsWith(".." + NodePath.sep),
          "Runtime symlink escapes its distribution.",
        );
      } else {
        NodeAssert.ok(entry.isFile(), `Unexpected runtime file type: ${relative}`);
        const hash = NodeCrypto.createHash("sha256");
        for await (const chunk of NodeFS.createReadStream(full)) hash.update(chunk);
        NodeAssert.equal(hash.digest("hex"), expected.sha256, `Runtime file changed: ${relative}`);
      }
    }
  };
  await visit(root);
  NodeAssert.deepEqual(
    [...actualFiles].sort(),
    Object.keys(receipt.files).sort(),
    "Runtime files are missing.",
  );
  for (const name of [
    "corporate-electron.patch",
    "corporate-electron-node.patch",
    "corporate-chromium.patch",
    "corporate-webrtc.patch",
  ]) {
    const hash = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(NodePath.join(import.meta.dirname, name)))
      .digest("hex");
    NodeAssert.equal(receipt.patches?.[name], hash, `Rebuild the runtime after changing ${name}.`);
  }
  const runtime = NodePath.join(root, "Electron.app/Contents/MacOS/Electron");
  const env = { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "1" };
  const versions = JSON.parse(
    NodeChildProcess.execFileSync(runtime, ["-p", "JSON.stringify(process.versions)"], {
      env,
      encoding: "utf8",
      timeout: 10000,
    }),
  );
  NodeAssert.equal(versions.electron, source.version);
  NodeAssert.equal(versions.node, source.node);
  NodeAssert.equal(versions.chrome, source.chromium);
  NodeAssert.equal(versions.t3_corporate_network, "loopback-v1");
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.join(repoRoot, "scripts/corporate-runtime-check.ts"),
      "--runtime",
      runtime,
      "--electron",
      "--harness-node",
      process.execPath,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.join(repoRoot, "scripts/corporate-electron-check.ts"),
      "--runtime",
      runtime,
      "--control-runtime",
      NodePath.join(
        repoRoot,
        "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
}

export async function verifyCorporatePackagedApp(
  appDirectory: string,
  executableName: string,
  repoRoot: string,
) {
  await verifyCorporateNativePayload(appDirectory);
  const resources = NodePath.join(appDirectory, "Contents/Resources");
  const asar = NodePath.join(resources, "app.asar");
  for (const name of listPackage(asar, { isPack: false })) {
    NodeAssert.ok(
      !isCorporateExcludedModule(name),
      `Corporate ASAR includes an excluded package: ${name}`,
    );
  }
  const inspect = async (directory: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const full = NodePath.join(directory, entry.name);
      const relative = NodePath.relative(resources, full);
      NodeAssert.ok(
        !isCorporateExcludedModule(relative),
        `Corporate resources include an excluded package: ${relative}`,
      );
      if (entry.isDirectory()) await inspect(full);
    }
  };
  await inspect(resources);
  const crashHandler = NodePath.join(
    appDirectory,
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
  );
  await NodeAssert.rejects(
    NodeFSP.access(crashHandler),
    { code: "ENOENT" },
    "Corporate app must omit the crash uploader helper.",
  );
  const receipt = JSON.parse(
    await NodeFSP.readFile(NodePath.join(resources, "corporate-runtime/provenance.json"), "utf8"),
  );
  NodeAssert.equal(receipt.commit, source.commit);
  NodeAssert.equal(receipt.oraclePassed, true);
  const framework = NodePath.join(
    appDirectory,
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  );
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(framework)) hash.update(chunk);
  NodeAssert.equal(
    hash.digest("hex"),
    receipt.files[
      "Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
    ]?.sha256,
    "Packaged Electron Framework changed from the native-verified distribution.",
  );
  const runtime = NodePath.join(appDirectory, "Contents/MacOS", executableName);
  NodeChildProcess.execFileSync(
    process.execPath,
    [
      NodePath.join(repoRoot, "scripts/corporate-runtime-check.ts"),
      "--runtime",
      runtime,
      "--electron",
      "--harness-node",
      process.execPath,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
}
