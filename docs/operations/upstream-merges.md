# Upstream merges

This fork follows upstream's stable releases (`vX.Y.Z` on https://github.com/pingdotgg/t3code, not the nightlies). Each one comes in as a real merge commit. Upstream history is never squashed or rebased, so `git log` keeps showing which upstream release the fork is on. The fork's own PRs are squash-merged as usual.

A daily scheduled agent runs this procedure. A person can run it too. The agent does every step up to an open PR. The maintainer approves the merge and asks for a release.

## 1. Detect

```sh
git fetch origin
node scripts/upstream-merge-report.ts --next
```

If it prints `"merged": true`, stop. There is nothing to do. Otherwise, `newest` is the tag to merge. Merge only the newest stable tag. Do not walk through the intermediate ones.

## 2. Merge

Work in a locked worktree under `scratch-root`, on branch `merge/upstream-<tag>` from `origin/main`. Run `vp i` there before checking anything.

```sh
node scripts/upstream-merge-report.ts --tag <tag>   # conflicts, with the earlier merges each one also hit
git merge --no-ff <tag> -m "Merge upstream <tag>"
```

Keep the report's output. Step 5 needs it.

Resolve every conflict hunk by hunk, keeping both intents. **Never resolve a whole file by taking one side** (`git checkout --ours/--theirs`). On v0.1.11 that dropped upstream's new dependencies from four `package.json` files. Use `git merge-file`, or edit the markers, so that only the conflicting lines are decided.

Known recurring conflicts:

- **`version` in the `package.json` files.** Keep the fork's version. Take upstream's side of every other line.
- **Inline fork entries in upstream registries** (settings search, route titles, preference fields). Keep both. Express the fork's entry in whatever form upstream adopted for its own entries. In v0.1.11, upstream moved its copy to `msg()`.
- **Upstream API drift under fork code.** Typecheck finds this, not the conflict markers. Port the fork code to the new API.

Upstream's lint rules apply to fork code after the merge. Fix any new findings in a separate `fix(...)` commit on the same branch, not in the merge commit.

## 3. Verify

```sh
vp run check:changed <tag>
```

Comparing against the tag checks the fork's footprint, not all of upstream. For each failing test, run it on a clean worktree of `<tag>`. A test that also fails there is upstream's or the machine's. Name it in the PR and leave it alone. A test that only fails on the merge is the merge's to fix.

## 4. Open the PR

Push the branch and open a PR titled `Merge upstream <tag>`. In the body, put:

- the conflict list, and how each conflict was resolved,
- the follow-up commits,
- the failing tests that also fail on clean upstream.

Mark it **merge commit, not squash**. The agent stops here.

If `main` moves before the PR merges, rebuild the merge commit on the new `main` instead of merging `main` into the branch. When the new `main` commits do not touch any conflicted file, reuse the resolved tree:

```sh
export GIT_INDEX_FILE=$(mktemp)
git read-tree <old merge>
# Re-apply each file that origin/main changed since the old merge's first parent:
git update-index --cacheinfo 100644,$(git rev-parse origin/main:<path>),<path>
tree=$(git write-tree); unset GIT_INDEX_FILE
merge=$(git commit-tree $tree -p origin/main -p <tag>^{commit} -m "Merge upstream <tag>")
git switch -C merge/upstream-<tag> $merge && git cherry-pick <follow-up commits>
```

Check that `git diff <old merge> $merge` shows only the files that `main` changed. Then force-push the branch.

## 5. Review the merge's friction

An agent that did not do the merge reviews it. It starts from the report, the conflict resolutions and the follow-up commits, and adds an entry for the tag to [`upstream-merges.json`](upstream-merges.json):

- every conflict, with its `cause` (`version-line`, `inline-registry`, `adjacent-edit`, `upstream-refactor`, `api-drift`) and the `resolution` used,
- `followUps`: what to change so the next merge hurts less.

The ledger commit goes on the merge branch. To choose follow-ups:

- **One-off:** upstream rewrote an area it rarely touches. Accept the cost. No follow-up.
- **Repeat:** a file that conflicted in an earlier merge (`priorMerges` in the report), or that sits near the top of `hotFiles` with fork edits in it. Move the fork's code into a fork-only file that upstream's file imports or registers in one line. File it as a bullseye target.
- **Patch (last resort):** a conflict that repeats every merge and cannot be moved. Keep the fork change as an uncommitted patch applied after each merge. That requires changes to the fork's CI and release scripts, so propose it to the maintainer. Never adopt it unilaterally.

## 6. Merge and release

The maintainer approves the PR. It merges with `gh pr merge <n> --merge`. A release follows only when the maintainer asks for one. It goes through `/release`, which builds with [`scripts/release-plugin-desktop.ts`](../../scripts/release-plugin-desktop.ts) (see [Panel plugins](panel-plugins.md)).
