// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Facts for an upstream merge, read from git alone so the merge agent never counts its own work.
// See docs/operations/upstream-merges.md for the process that uses it.
//
//   node scripts/upstream-merge-report.ts --next              newest stable upstream tag, if unmerged
//   node scripts/upstream-merge-report.ts --tag v0.1.12       preview merging that tag into origin/main
//   node scripts/upstream-merge-report.ts --merge <commit>    the same facts for a merge already made
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    next: { type: "boolean", default: false },
    tag: { type: "string" },
    merge: { type: "string" },
    fork: { type: "string", default: "origin/main" },
    upstream: { type: "string", default: "upstream" },
  },
});

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const ledgerPath = NodePath.join(repoRoot, "docs/operations/upstream-merges.json");
// Upstream's stable releases are plain vMAJOR.MINOR.PATCH; nightlies carry a suffix.
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const lines = (text: string) => text.split("\n").filter((line) => line !== "");

if (values.next) {
  // Ask the upstream remote, not local tags: the fork's own release tags share the v* namespace.
  const remoteTags = lines(git("ls-remote", "--tags", "--refs", values.upstream))
    .map((line) => line.split("\t")[1]!.replace("refs/tags/", ""))
    .filter((tag) => STABLE_TAG.test(tag));
  const newest = remoteTags.toSorted((a, b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
  if (newest === undefined) throw new Error(`No stable tags on ${values.upstream}.`);
  git("fetch", "--quiet", values.upstream, "tag", newest);
  const merged =
    NodeChildProcess.spawnSync("git", ["merge-base", "--is-ancestor", newest, values.fork], {
      cwd: repoRoot,
    }).status === 0;
  console.log(JSON.stringify({ newest, merged }));
  process.exit(0);
}

let fork: string;
let tag: string;
if (values.merge !== undefined) {
  fork = git("rev-parse", `${values.merge}^1`);
  tag = git("describe", "--tags", "--exact-match", `${values.merge}^2`);
} else if (values.tag !== undefined) {
  fork = git("rev-parse", values.fork);
  tag = values.tag;
} else {
  throw new Error("Pass --next, --tag <tag> or --merge <commit>.");
}

const base = git("merge-base", fork, tag);
// Conflicts as git sees them before anyone resolves anything. Exit status 1 means "conflicts".
const mergeTree = NodeChildProcess.spawnSync(
  "git",
  ["merge-tree", "--write-tree", "--name-only", "--no-messages", fork, tag],
  { cwd: repoRoot, encoding: "utf8" },
);
if (mergeTree.status !== 0 && mergeTree.status !== 1) throw new Error(mergeTree.stderr);
const conflicted = lines(mergeTree.stdout).slice(1);

type LedgerEntry = { tag: string; conflicts: { file: string }[] };
const ledger: LedgerEntry[] = NodeFS.existsSync(ledgerPath)
  ? JSON.parse(NodeFS.readFileSync(ledgerPath, "utf8")).merges
  : [];
const priorMerges = (file: string) =>
  ledger
    .filter((entry) => entry.tag !== tag && entry.conflicts.some((c) => c.file === file))
    .map((entry) => entry.tag);

// Upstream files the fork has edited. Files the fork added are its own and cannot conflict.
const numstat = (from: string, to: string, files: string[]) =>
  new Map(
    lines(git("diff", "--numstat", from, to, "--", ...files)).map((line) => {
      const [added, removed, file] = line.split("\t");
      return [file!, Number(added) + Number(removed)] as const;
    }),
  );
const footprint = lines(git("diff", "--name-only", "--diff-filter=M", base, fork));
const forkLines = numstat(base, fork, footprint);
const upstreamLines = footprint.length === 0 ? new Map() : numstat(base, tag, footprint);

console.log(
  JSON.stringify(
    {
      tag,
      fork,
      base,
      upstreamCommits: Number(git("rev-list", "--count", `${base}..${tag}`)),
      conflicts: conflicted.map((file) => ({ file, priorMerges: priorMerges(file) })),
      // Fork-edited upstream files upstream also changed: where the next conflicts come from.
      hotFiles: footprint
        .filter((file) => upstreamLines.has(file))
        .map((file) => ({
          file,
          forkLines: forkLines.get(file) ?? 0,
          upstreamLines: upstreamLines.get(file),
          conflicted: conflicted.includes(file),
        }))
        .toSorted((a, b) => b.upstreamLines - a.upstreamLines),
      forkEditedUpstreamFiles: footprint.length,
    },
    null,
    2,
  ),
);
