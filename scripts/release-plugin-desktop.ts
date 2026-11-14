// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Builds the macOS plugin desktop DMG signed with a Developer ID, notarized and stapled, then
// checks the result the way Gatekeeper will. Runs on the maintainer's Mac: the signing key lives
// in the login keychain and the App Store Connect key in ~/.appstoreconnect, never in CI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    "notary-config": {
      type: "string",
      default: NodePath.join(NodeOS.homedir(), ".appstoreconnect/canticode.json"),
    },
    // For a dry run with a non-Developer ID identity; such a build cannot be notarized.
    identity: { type: "string" },
    "skip-build": { type: "boolean", default: false },
    "skip-notarize": { type: "boolean", default: false },
  },
});

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const mode = process.env.T3CODE_PLUGIN_BUILD;
if (mode !== "1" && mode !== "upgrade")
  throw new Error("Set T3CODE_PLUGIN_BUILD to 1 or upgrade, as for any plugin build.");

interface NotaryConfig {
  readonly team: string;
  readonly team_id: string;
  readonly issuer_id: string;
  readonly key_id: string;
  readonly key_path: string;
}
const notary = JSON.parse(NodeFS.readFileSync(values["notary-config"], "utf8")) as NotaryConfig;
const identity = values.identity ?? `Developer ID Application: ${notary.team} (${notary.team_id})`;
const notarize = !values["skip-notarize"];

const run = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string => {
  console.log(`$ ${command} ${args.join(" ")}`);
  return NodeChildProcess.execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
};
const runShown = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) => {
  console.log(`$ ${command} ${args.join(" ")}`);
  NodeChildProcess.execFileSync(command, args, {
    cwd: repoRoot,
    env: env ?? process.env,
    stdio: "inherit",
  });
};

if (!run("security", ["find-identity", "-v", "-p", "codesigning"]).includes(`"${identity}"`))
  throw new Error(
    `No "${identity}" signing identity in the keychain. See "Signing and notarization" in docs/operations/panel-plugins.md.`,
  );

const version = (
  JSON.parse(NodeFS.readFileSync(NodePath.join(repoRoot, "apps/desktop/package.json"), "utf8")) as {
    version: string;
  }
).version;
const notaryArgs = [
  "--key",
  notary.key_path,
  "--key-id",
  notary.key_id,
  "--issuer",
  notary.issuer_id,
];
const buildEnv: NodeJS.ProcessEnv = {
  ...process.env,
  T3CODE_TELEMETRY_ENABLED: "false",
  // electron-builder takes the identity without its certificate-type prefix.
  CSC_NAME: identity.replace(/^[^:]+:\s*/u, ""),
};
// electron-builder only signs. Its notarization wait keeps the app in a temporary staging
// directory, which is lost if the wait is interrupted; the DMG below stays in release/.
for (const name of [
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "CSC_LINK",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "APPLE_ID",
  "APPLE_TEAM_ID",
])
  delete buildEnv[name];

const dmg = NodePath.join(repoRoot, `release/T3-Code-${version}-arm64.dmg`);
const sha256 = (file: string) => run("shasum", ["-a", "256", file]).split(" ")[0] ?? "";
// Notarization can take hours. A rerun after an interruption waits on the same submission
// instead of rebuilding, as long as the DMG is the one that was submitted.
const submissionFile = `${dmg}.notary-submission.json`;
const pending = NodeFS.existsSync(submissionFile)
  ? (JSON.parse(NodeFS.readFileSync(submissionFile, "utf8")) as { id: string; sha256: string })
  : undefined;
const resume =
  notarize && pending !== undefined && NodeFS.existsSync(dmg) && sha256(dmg) === pending.sha256;

const vp = NodePath.join(repoRoot, "node_modules/.bin/vp");
if (!resume && !values["skip-build"]) runShown(vp, ["run", "build:desktop"], buildEnv);
if (!resume)
  runShown(
    vp,
    [
      "run",
      "dist:desktop:artifact",
      "--platform",
      "mac",
      "--target",
      "dmg",
      "--arch",
      "arm64",
      "--skip-build",
      "--signed",
      "--build-version",
      version,
    ],
    buildEnv,
  );

if (!resume) runShown("codesign", ["--force", "--timestamp", "--sign", identity, dmg]);
if (notarize) {
  let id = pending?.id;
  if (!resume) {
    id = (
      JSON.parse(
        run("xcrun", ["notarytool", "submit", dmg, ...notaryArgs, "--output-format", "json"]),
      ) as { id: string }
    ).id;
    NodeFS.writeFileSync(submissionFile, JSON.stringify({ id, sha256: sha256(dmg) }));
  }
  if (!id) throw new Error("No notary submission id");
  const result = JSON.parse(
    run("xcrun", ["notarytool", "wait", id, ...notaryArgs, "--output-format", "json"]),
  ) as { status: string };
  if (result.status !== "Accepted") {
    runShown("xcrun", ["notarytool", "log", id, ...notaryArgs]);
    throw new Error(`Notarization ${id} ended ${result.status}`);
  }
  runShown("xcrun", ["stapler", "staple", dmg]);
  NodeFS.rmSync(submissionFile);
}

// Verify what a user downloads: the DMG, and the app inside it.
const mount = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-plugin-dmg-"));
runShown("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg]);
try {
  const appName = NodeFS.readdirSync(mount).find((entry) => entry.endsWith(".app"));
  if (!appName) throw new Error(`No app in ${dmg}`);
  const app = NodePath.join(mount, appName);
  runShown("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const details = NodeChildProcess.spawnSync("codesign", ["-dv", "--verbose=4", app], {
    encoding: "utf8",
  }).stderr;
  for (const expected of [`TeamIdentifier=${notary.team_id}`, "(runtime)"])
    if (!values.identity && !details.includes(expected))
      throw new Error(`${appName} signature lacks ${expected}:\n${details}`);
  if (notarize) {
    // The ticket for the DMG also covers the app inside it; Gatekeeper fetches it online.
    runShown("xcrun", ["stapler", "validate", dmg]);
    // spctl reports on stderr.
    for (const args of [
      ["--assess", "--type", "execute", "--verbose=2", app],
      ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", dmg],
    ]) {
      const result = NodeChildProcess.spawnSync("spctl", args, { encoding: "utf8" });
      process.stdout.write(result.stderr);
      if (result.status !== 0 || !result.stderr.includes("source=Notarized Developer ID"))
        throw new Error(`Gatekeeper rejected ${args.at(-1)}`);
    }
  }
} finally {
  run("hdiutil", ["detach", mount]);
  NodeFS.rmSync(mount, { recursive: true, force: true });
}

const sums = NodePath.join(repoRoot, "release/SHA256SUMS");
NodeFS.writeFileSync(
  sums,
  NodeChildProcess.execFileSync("shasum", ["-a", "256", NodePath.basename(dmg)], {
    cwd: NodePath.dirname(dmg),
    encoding: "utf8",
  }),
);
console.log(`\n${notarize ? "Signed, notarized and stapled" : "Signed"}: ${dmg}\n${sums}`);
