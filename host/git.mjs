// Minimal promise wrapper over the git CLI — only what the integration needs.
// Every call is scoped to the run's project workspace.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function git(cwd, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error(String(stderr || err.message).trim());
          reject(e);
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

export async function isRepo(cwd) {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(cwd) {
  return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/** Porcelain status (empty string when the tree is clean). */
export async function statusPorcelain(cwd) {
  return (await git(cwd, ["status", "--porcelain"])).trim();
}

export async function assertClean(cwd) {
  const out = await statusPorcelain(cwd);
  if (out) {
    const preview = out.split("\n").slice(0, 8).join("\n");
    throw new Error(`working tree not clean — commit or stash first:\n${preview}`);
  }
}

/** Stage everything, tracked + untracked. Prefer stagePaths — the leftover
 *  hook no longer sweeps blindly (it must not commit .env-looking files). */
export async function stageAll(cwd) {
  await git(cwd, ["add", "-A"]);
}

/** Parsed `status --porcelain -z`: [{ x, y, path, orig? }]. Untracked files
 *  are listed individually (never collapsed to a directory). Honors .gitignore. */
export async function statusEntries(cwd) {
  const out = await git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const parts = out.split("\0");
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const entry = { x, y, path: rec.slice(3) };
    if (x === "R" || x === "C" || y === "R" || y === "C") entry.orig = parts[++i]; // rename/copy: next field is the source
    entries.push(entry);
  }
  return entries;
}

/** Stage exactly these paths (adds, modifications AND deletions). Chunked. */
export async function stagePaths(cwd, relPaths) {
  for (let i = 0; i < relPaths.length; i += 100) {
    await git(cwd, ["add", "-A", "--", ...relPaths.slice(i, i + 100)]);
  }
}

/** Park uncommitted work (incl. untracked, excl. ignored) in a labelled stash
 *  so the tree is clean for the next run. Returns true when something was stashed. */
export async function stashPush(cwd, message) {
  const out = await git(cwd, ["stash", "push", "--include-untracked", "-m", message]);
  return !/No local changes to save/i.test(out);
}

/** Find the newest stash whose subject carries `message`; returns its ref or null. */
export async function stashFind(cwd, message) {
  const out = await git(cwd, ["stash", "list", "--format=%gd%x09%s"]);
  for (const line of out.split("\n")) {
    const [ref, ...rest] = line.split("\t");
    if (ref && rest.join("\t").includes(message)) return ref;
  }
  return null;
}

export async function stashPop(cwd, ref) {
  await git(cwd, ["stash", "pop", ref]);
}

export async function createBranch(cwd, branch, base) {
  await git(cwd, ["checkout", "-b", branch, base]);
}

export async function checkout(cwd, branch) {
  await git(cwd, ["checkout", branch]);
}

export async function stagePath(cwd, relPath) {
  await git(cwd, ["add", "--", relPath]);
}

export async function hasStaged(cwd) {
  return (await git(cwd, ["diff", "--cached", "--name-only"])).trim().length > 0;
}

export async function commit(cwd, message) {
  await git(cwd, ["commit", "-m", message]);
  return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
}

/** True when the repo has an `origin` remote configured. */
export async function hasRemote(cwd) {
  try {
    return (await git(cwd, ["remote", "get-url", "origin"])).trim().length > 0;
  } catch {
    return false;
  }
}

/** Push a branch with upstream tracking. Used ONLY for owner-opted remote CI verification. */
export async function pushBranch(cwd, branch) {
  await git(cwd, ["push", "-u", "origin", branch]);
}

/** Full HEAD sha (for SHA-scoped `gh run list`). */
export async function headSha(cwd) {
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

export async function ffMerge(cwd, branch) {
  await git(cwd, ["merge", "--ff-only", branch]);
}

export async function deleteBranch(cwd, branch, { force = false } = {}) {
  await git(cwd, ["branch", force ? "-D" : "-d", branch]);
}

/** Stage one file and commit it with the given subject. Returns the hash. */
export async function commitFile(projectPath, relPath, subject) {
  await stagePath(projectPath, relPath);
  // Path-limited: the owner's checkout may carry their own staged work — the
  // commit must contain this one file and nothing else.
  if (!(await git(projectPath, ["diff", "--cached", "--name-only", "--", relPath])).trim()) return null;
  await git(projectPath, ["commit", "-m", subject, "--", relPath]);
  return (await git(projectPath, ["rev-parse", "--short", "HEAD"])).trim();
}


// --- worktrees (one per run — REWRITE-ANALYSIS §2.4 / §6.7) ------------------------
//
// The owner's checkout is never switched to a run branch: every run works in
// `git worktree add <runDir>/wt -b <runBranch> <baseSha>` and only the final,
// explicit merge step touches the owner's tree.

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Full sha of any rev, or null when it does not resolve. */
export async function revParse(cwd, rev) {
  try {
    return (await git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

export async function branchExists(cwd, branch) {
  return (await revParse(cwd, `refs/heads/${branch}`)) !== null;
}

/** Parsed `git worktree list --porcelain`: [{ path, head, branch|null, detached }]. */
export async function worktreeList(cwd) {
  const out = await git(cwd, ["worktree", "list", "--porcelain"]);
  const list = [];
  for (const block of out.split(/\n\n+/)) {
    const wt = { path: null, head: null, branch: null, detached: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wt.path = line.slice(9);
      else if (line.startsWith("HEAD ")) wt.head = line.slice(5);
      else if (line.startsWith("branch ")) wt.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") wt.detached = true;
    }
    if (wt.path) list.push(wt);
  }
  return list;
}

/** Path of the worktree that has `branch` checked out (main checkout included), or null. */
export async function branchCheckoutPath(cwd, branch) {
  return (await worktreeList(cwd)).find((w) => w.branch === branch)?.path ?? null;
}

export async function worktreePrune(cwd) {
  await git(cwd, ["worktree", "prune"]);
}

/** New worktree on a NEW branch cut from `baseSha`. */
export async function worktreeAdd(cwd, dir, branch, baseSha) {
  await git(cwd, ["worktree", "add", "--quiet", "-b", branch, dir, baseSha], 120_000);
}

/** Re-attach a worktree to an EXISTING branch (resume after the dir was lost). */
export async function worktreeAddExisting(cwd, dir, branch) {
  await git(cwd, ["worktree", "add", "--quiet", dir, branch], 120_000);
}

/** True when `dir` is currently a live registered worktree of the repo at `cwd`. */
export async function isWorktree(cwd, dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    const target = real(dir);
    return (await worktreeList(cwd)).some((w) => real(w.path) === target);
  } catch {
    return false;
  }
}

/** Absolute path of the main repo's common git dir, resolved from any worktree. */
export async function commonGitDir(cwd) {
  return real((await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
}

/** Remove a worktree (force: its dirt is disposable by the time this is called)
 *  and make sure nothing is left on disk. Never follows the node_modules symlinks. */
export async function worktreeRemove(repoCwd, dir) {
  try {
    await git(repoCwd, ["worktree", "remove", "--force", dir], 120_000);
  } catch {
    /* not registered / already gone — fall through to the disk cleanup */
  }
  fs.rmSync(dir, { recursive: true, force: true }); // rm never follows symlinks
  try {
    await worktreePrune(repoCwd);
  } catch {
    /* best effort */
  }
}

/** `a` is an ancestor of (or equal to) `b`. */
export async function isAncestor(cwd, a, b) {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

/** Rebase the branch checked out at `cwd` onto `onto`; aborts and rethrows on conflict. */
export async function rebaseOnto(cwd, onto) {
  try {
    await git(cwd, ["rebase", onto], 180_000);
  } catch (e) {
    try {
      await git(cwd, ["rebase", "--abort"]);
    } catch {
      /* no rebase in progress */
    }
    throw e;
  }
}

/** Compare-and-swap a branch ref (base not checked out anywhere → no checkout to update). */
export async function updateBranchRef(cwd, branch, newSha, oldSha) {
  await git(cwd, ["update-ref", `refs/heads/${branch}`, newSha, oldSha]);
}

// Dependencies: a fresh worktree lacks gitignored node_modules. Symlink the
// main checkout's (root + one level of workspace dirs + packages/*, apps/*, …).
// LIMITATION: only node_modules is shared — other gitignored build output and
// env files (.env, dist/, .venv, …) are NOT copied into the worktree, and an
// `npm install` run by the agent writes through the link into the owner's
// node_modules.
const WORKSPACE_PARENTS = ["packages", "apps", "libs", "services", "modules"];
function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Root + one level of workspace dirs (+ packages/*, apps/*, …), relative to `mainDir`. */
function workspaceDirs(mainDir) {
  const candidates = [""];
  for (const d of subdirs(mainDir)) {
    candidates.push(d);
    if (WORKSPACE_PARENTS.includes(d)) for (const c of subdirs(path.join(mainDir, d))) candidates.push(path.join(d, c));
  }
  return candidates;
}

/** Symlink node_modules dirs from `mainDir` into `wtDir`. Returns the relative paths linked. */
export function linkNodeModules(mainDir, wtDir) {
  const linked = [];
  for (const rel of workspaceDirs(mainDir)) {
    const src = path.join(mainDir, rel, "node_modules");
    const dest = path.join(wtDir, rel, "node_modules");
    try {
      if (!fs.statSync(src).isDirectory()) continue;
      if (!fs.statSync(path.join(wtDir, rel)).isDirectory()) continue;
      try {
        fs.lstatSync(dest);
        continue; // tracked, or already linked
      } catch {
        /* absent — link it */
      }
      fs.symlinkSync(src, dest, "dir");
      linked.push(path.join(rel, "node_modules"));
    } catch {
      /* no node_modules here / unreadable — skip */
    }
  }
  return linked;
}

// Real env files (.env, .env.local, .env.production, …) — NOT templates.
const ENV_FILE_RE = /^\.env(\..+)?$/;
const ENV_TEMPLATE_RE = /\.(example|sample|template|dist|defaults?)$/i;

/** COPY (never link) the project's gitignored .env / .env.* files — root and one
 *  level of workspace dirs — into the worktree. Only files git ignores in the
 *  checkout are copied (an untracked, un-ignored env file is the owner's
 *  business, and tracked ones are already in the worktree); templates are
 *  skipped; existing files are never overwritten. Returns the relative paths. */
export async function copyEnvFiles(mainDir, wtDir) {
  const copied = [];
  for (const rel of workspaceDirs(mainDir)) {
    let names = [];
    try {
      names = fs.readdirSync(path.join(mainDir, rel));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!ENV_FILE_RE.test(name) || ENV_TEMPLATE_RE.test(name)) continue;
      const relFile = path.join(rel, name);
      const src = path.join(mainDir, relFile);
      const dest = path.join(wtDir, relFile);
      try {
        if (!fs.lstatSync(src).isFile()) continue;
        if (!fs.statSync(path.join(wtDir, rel)).isDirectory()) continue;
        try {
          fs.lstatSync(dest);
          continue; // tracked or already copied
        } catch {
          /* absent */
        }
        await git(mainDir, ["check-ignore", "-q", "--", relFile]); // rejects (exit 1) when NOT ignored
        fs.copyFileSync(src, dest);
        fs.chmodSync(dest, 0o600);
        copied.push(relFile);
      } catch {
        /* not ignored / unreadable — never copied */
      }
    }
  }
  return copied;
}

/** Paths changed between two revs (`a..b`), repo-relative. */
export async function diffNames(cwd, a, b) {
  return (await git(cwd, ["diff", "--name-only", "-z", `${a}..${b}`])).split("\0").filter(Boolean);
}

/** Every path the checkout reports as dirty (modified/staged/untracked, renames' sources too). */
export async function dirtyPaths(cwd) {
  const out = new Set();
  for (const e of await statusEntries(cwd)) {
    out.add(e.path);
    if (e.orig) out.add(e.orig);
  }
  return out;
}

/** Remove the symlinks created by linkNodeModules (only symlinks — never a real dir). */
export function unlinkNodeModules(wtDir, rels) {
  for (const rel of rels ?? []) {
    const p = path.join(wtDir, rel);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
    } catch {
      /* gone */
    }
  }
}

/** Make sure git never reports (or stages/stashes) the given worktree-relative
 *  paths. Most projects already ignore `node_modules/` — but that pattern does
 *  not match a SYMLINK, so those fall through to the repo's info/exclude
 *  (`git rev-parse --git-path info/exclude`). NOTE: for linked worktrees that
 *  file is shared with the main checkout; the anchored `/node_modules` lines are
 *  harmless there (they only hide paths the project already ignores or never
 *  tracks). Idempotent. */
export async function ensureExcluded(wtDir, rels) {
  const missing = [];
  for (const rel of rels) {
    try {
      await git(wtDir, ["check-ignore", "-q", "--", rel]);
    } catch {
      missing.push(`/${rel.split(path.sep).join("/")}`);
    }
  }
  if (missing.length === 0) return [];
  const file = path.resolve(wtDir, (await git(wtDir, ["rev-parse", "--git-path", "info/exclude"])).trim());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let cur = "";
  try {
    cur = fs.readFileSync(file, "utf8");
  } catch {
    /* new file */
  }
  const have = new Set(cur.split("\n"));
  const add = missing.filter((m) => !have.has(m));
  if (add.length) {
    fs.appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}# nano-cycle: run worktrees symlink node_modules\n${add.join("\n")}\n`);
  }
  return missing;
}
