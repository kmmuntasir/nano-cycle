// Real-git tests for the worktree helpers in host/git.mjs (temp repos only).
// Run: node tests/worktree.test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as git from "../host/git.mjs";

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push([name, true]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push([name, false]);
    console.log(`FAIL  ${name}\n      ${String(e?.message ?? e).split("\n").join("\n      ")}`);
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nano-wt-"));
let n = 0;
function mkRepo(files = {}) {
  const repo = path.join(tmp, `repo${n++}`);
  fs.mkdirSync(repo);
  const g = (args, cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), c);
  }
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  return { repo, g, wt: path.join(tmp, `wt${n++}`) };
}

await test("worktreeAdd / worktreeList / branchCheckoutPath / isWorktree / worktreeRemove", async () => {
  const { repo, g, wt } = mkRepo();
  const sha = await git.revParse(repo, "main");
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.strictEqual(await git.revParse(repo, "nope"), null);
  await git.worktreeAdd(repo, wt, "run/x", sha);
  assert.strictEqual(await git.branchExists(repo, "run/x"), true);
  assert.strictEqual(fs.realpathSync(await git.branchCheckoutPath(repo, "run/x")), fs.realpathSync(wt));
  assert.strictEqual(fs.realpathSync(await git.branchCheckoutPath(repo, "main")), fs.realpathSync(repo));
  assert.strictEqual(await git.isWorktree(repo, wt), true);
  assert.strictEqual(await git.isWorktree(repo, path.join(tmp, "nowhere")), false);
  assert.strictEqual(path.dirname(await git.commonGitDir(wt)), fs.realpathSync(repo), "common git dir resolves to the main repo from a worktree");
  await git.worktreeRemove(repo, wt);
  assert.ok(!fs.existsSync(wt));
  assert.strictEqual(g(["worktree", "list"]).trim().split("\n").length, 1);
  assert.strictEqual(await git.branchExists(repo, "run/x"), true, "removing the worktree keeps the branch");
});

await test("worktreeAddExisting re-attaches after the dir vanished (prune first)", async () => {
  const { repo, wt } = mkRepo();
  await git.worktreeAdd(repo, wt, "run/y", await git.revParse(repo, "main"));
  fs.writeFileSync(path.join(wt, "new.txt"), "x\n");
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=t@e.c", "-c", "user.name=t", "commit", "-qm", "work"], { cwd: wt });
  fs.rmSync(wt, { recursive: true, force: true });
  await assert.rejects(() => git.worktreeAddExisting(repo, wt, "run/y"), undefined, "stale registration blocks re-add until pruned");
  await git.worktreePrune(repo);
  await git.worktreeAddExisting(repo, wt, "run/y");
  assert.ok(fs.existsSync(path.join(wt, "new.txt")), "commit survived");
});

await test("linkNodeModules: root + workspace + packages/*; skips tracked/missing; unlink never follows into the target", async () => {
  const { repo, wt } = mkRepo({ ".gitignore": "node_modules/\n", "web/package.json": "{}\n", "packages/lib/package.json": "{}\n", "other/x.txt": "1\n" });
  for (const d of ["node_modules", "web/node_modules", "packages/lib/node_modules"]) {
    fs.mkdirSync(path.join(repo, d), { recursive: true });
    fs.writeFileSync(path.join(repo, d, "marker"), "m\n");
  }
  await git.worktreeAdd(repo, wt, "run/z", await git.revParse(repo, "main"));
  const linked = git.linkNodeModules(repo, wt);
  assert.deepStrictEqual(linked.sort(), ["node_modules", "packages/lib/node_modules", "web/node_modules"]);
  for (const l of linked) assert.ok(fs.lstatSync(path.join(wt, l)).isSymbolicLink());
  assert.deepStrictEqual(git.linkNodeModules(repo, wt), [], "idempotent");
  // `node_modules/` does not match a symlink: they must be excluded explicitly
  assert.match(execFileSync("git", ["status", "--porcelain"], { cwd: wt }).toString(), /node_modules/, "premise: symlinks show up as untracked");
  await git.ensureExcluded(wt, linked);
  assert.strictEqual(execFileSync("git", ["status", "--porcelain"], { cwd: wt }).toString().trim(), "");
  const before = fs.readFileSync(execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: wt }).toString().trim().replace(/^(?!\/)/, wt + "/"), "utf8");
  await git.ensureExcluded(wt, linked); // idempotent: nothing appended
  const after = fs.readFileSync(execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: wt }).toString().trim().replace(/^(?!\/)/, wt + "/"), "utf8");
  assert.strictEqual(after, before);
  git.unlinkNodeModules(wt, linked);
  for (const l of linked) assert.ok(!fs.existsSync(path.join(wt, l)));
  assert.ok(fs.existsSync(path.join(repo, "node_modules/marker")), "targets intact");
  // a REAL dir is never removed by unlink
  fs.mkdirSync(path.join(wt, "other/node_modules"), { recursive: true });
  git.unlinkNodeModules(wt, ["other/node_modules"]);
  assert.ok(fs.existsSync(path.join(wt, "other/node_modules")), "unlink only removes symlinks");
});

await test("worktreeRemove deletes a worktree holding node_modules symlinks without touching their targets", async () => {
  const { repo, wt } = mkRepo({ ".gitignore": "node_modules/\n" });
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.writeFileSync(path.join(repo, "node_modules/marker"), "m\n");
  await git.worktreeAdd(repo, wt, "run/w", await git.revParse(repo, "main"));
  git.linkNodeModules(repo, wt);
  await git.worktreeRemove(repo, wt);
  assert.ok(!fs.existsSync(wt));
  assert.ok(fs.existsSync(path.join(repo, "node_modules/marker")));
});

await test("rebaseOnto: clean rebase succeeds; conflict aborts and leaves the worktree clean; isAncestor + updateBranchRef CAS", async () => {
  const { repo, g, wt } = mkRepo();
  const base0 = await git.revParse(repo, "main");
  await git.worktreeAdd(repo, wt, "run/r", base0);
  const wg = (args) => execFileSync("git", args, { cwd: wt, stdio: "pipe" }).toString();
  wg(["config", "user.email", "t@example.com"]);
  wg(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(wt, "a.txt"), "a\nrun edit\n");
  wg(["commit", "-qam", "run"]);
  // base moves with a conflicting edit
  fs.writeFileSync(path.join(repo, "a.txt"), "a\nbase edit\n");
  g(["commit", "-qam", "base"]);
  assert.strictEqual(await git.isAncestor(repo, "main", "run/r"), false);
  await assert.rejects(() => git.rebaseOnto(wt, "main"));
  assert.strictEqual(wg(["status", "--porcelain"]).trim(), "", "aborted: not left mid-rebase");
  assert.strictEqual(wg(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "run/r");
  // reset base, add a non-conflicting commit → clean rebase
  g(["reset", "-q", "--hard", base0]);
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  g(["add", "."]);
  g(["commit", "-qm", "b"]);
  await git.rebaseOnto(wt, "main");
  assert.strictEqual(await git.isAncestor(repo, "main", "run/r"), true);
  // base not checked out anywhere: advance its ref with compare-and-swap
  g(["checkout", "-q", "-b", "side"]);
  const oldMain = await git.revParse(repo, "main");
  const tip = await git.headSha(wt);
  await assert.rejects(() => git.updateBranchRef(repo, "main", tip, base0), "stale expected-old is refused");
  await git.updateBranchRef(repo, "main", tip, oldMain);
  assert.strictEqual(await git.revParse(repo, "main"), tip);
});

await test("commitFile commits ONLY its path (the owner's other staged work is not swept in)", async () => {
  const { repo, g } = mkRepo({ "doc.md": "x\n", "mine.txt": "m\n" });
  fs.writeFileSync(path.join(repo, "mine.txt"), "m2\n");
  g(["add", "mine.txt"]); // owner's staged work
  fs.writeFileSync(path.join(repo, "doc.md"), "y\n");
  const sha = await git.commitFile(repo, "doc.md", "chore: flip");
  assert.ok(sha);
  assert.strictEqual(g(["show", "--name-only", "--format=", "HEAD"]).trim(), "doc.md");
  assert.strictEqual(g(["diff", "--cached", "--name-only"]).trim(), "mine.txt", "owner's staged change still staged");
  assert.strictEqual(await git.commitFile(repo, "doc.md", "again"), null, "nothing to commit → null");
});

await test("copyEnvFiles copies only gitignored real env files (root + workspace), never templates/links/overwrites; diffNames + dirtyPaths", async () => {
  const { repo, g, wt } = mkRepo({ ".gitignore": ".env\n.env.*\n!.env.example\n", ".env.example": "K=\n", "web/package.json": "{}\n", "nested/deep/package.json": "{}\n" });
  fs.writeFileSync(path.join(repo, ".env"), "A=1\n");
  fs.writeFileSync(path.join(repo, ".env.production"), "B=1\n");
  fs.writeFileSync(path.join(repo, ".env.sample"), "S=\n");
  fs.writeFileSync(path.join(repo, "web/.env"), "W=1\n");
  fs.writeFileSync(path.join(repo, "nested/deep/.env"), "TOO_DEEP=1\n"); // two levels down: out of scope
  fs.writeFileSync(path.join(repo, "other.txt"), "x\n");
  await git.worktreeAdd(repo, wt, "run/e", await git.revParse(repo, "main"));
  fs.writeFileSync(path.join(wt, ".env"), "EDITED=1\n"); // pre-existing dest is never overwritten
  const copied = await git.copyEnvFiles(repo, wt);
  assert.deepStrictEqual(copied.sort(), [".env.production", "web/.env"]);
  assert.strictEqual(fs.readFileSync(path.join(wt, ".env"), "utf8"), "EDITED=1\n");
  assert.ok(!fs.existsSync(path.join(wt, ".env.sample")) && !fs.existsSync(path.join(wt, "other.txt")) && !fs.existsSync(path.join(wt, "nested/deep/.env")));
  assert.ok(!fs.lstatSync(path.join(wt, "web/.env")).isSymbolicLink());
  assert.strictEqual(execFileSync("git", ["status", "--porcelain"], { cwd: wt }).toString().trim(), "");
  // a project whose .gitignore does not cover the copy in the worktree gets the exclude entry
  assert.deepStrictEqual(await git.copyEnvFiles(repo, wt), [], "idempotent");
  // diffNames / dirtyPaths
  const wg = (args) => execFileSync("git", args, { cwd: wt, stdio: "pipe" }).toString();
  wg(["config", "user.email", "t@e.c"]);
  wg(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(wt, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(wt, "new.txt"), "n\n");
  wg(["add", "."]);
  wg(["commit", "-qm", "work"]);
  assert.deepStrictEqual((await git.diffNames(repo, "main", "run/e")).sort(), ["a.txt", "new.txt"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
  fs.writeFileSync(path.join(repo, "fresh.txt"), "u\n");
  const dirty = await git.dirtyPaths(repo);
  assert.ok(dirty.has("a.txt") && dirty.has("fresh.txt") && !dirty.has("new.txt"));
  g(["checkout", "--", "a.txt"]);
});

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} worktree scenarios passed`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failed.length) process.exit(1);
