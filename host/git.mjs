// Minimal promise wrapper over the git CLI — only what the integration needs.
// Every call is scoped to the run's project workspace.
import { execFile } from "node:child_process";

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

/** Stage everything, tracked + untracked (the leftover hook's sweep). */
export async function stageAll(cwd) {
  await git(cwd, ["add", "-A"]);
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

export async function deleteBranch(cwd, branch) {
  await git(cwd, ["branch", "-d", branch]);
}

/** Stage one file and commit it with the given subject. Returns the hash. */
export async function commitFile(projectPath, relPath, subject) {
  await stagePath(projectPath, relPath);
  if (!(await hasStaged(projectPath))) return null;
  return commit(projectPath, subject);
}
