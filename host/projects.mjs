// Project registry — the local folder paths nano-cycle can run against.
// Persisted to projects.json (gitignored — local paths). A "sandbox" project
// is seeded on FIRST boot only (scratch/demo work); the owner may remove it
// like any other project, and it stays removed.
import fs from "node:fs";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./fsutil.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
// Resolved per call so tests can point NANO_PROJECTS_FILE at a throwaway file.
const registryFile = () => (process.env.NANO_PROJECTS_FILE ? path.resolve(process.env.NANO_PROJECTS_FILE) : path.join(ROOT, "projects.json"));

export const SANDBOX_DIR = path.join(ROOT, "sandbox");

/** True when `child` is `parent` itself or lies inside it. Separator-aware
 *  (so "/a/app-secrets" is NOT inside "/a/app") — lexical, via path.relative. */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(String(parent)), path.resolve(String(child)));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

// A damaged registry is NEVER treated as empty: reads degrade to [] (so the
// server stays up) but every write refuses, so the owner's real entries are not
// overwritten. The damaged file is kept (plus a .corrupt-<mtime> copy).
let corruption = null;

/** null when the registry is healthy, else { error, copy } for the GUI/log. */
export function projectsRegistryError() {
  return corruption;
}

function readRegistry() {
  const file = registryFile();
  const r = readJsonSafe(file);
  if (r.status === "ok") {
    corruption = null;
    return { projects: Array.isArray(r.data?.projects) ? r.data.projects : [], missing: false };
  }
  if (r.status === "missing") {
    corruption = null;
    return { projects: [], missing: true };
  }
  if (!corruption || corruption.error !== r.error) {
    console.error(`[projects] ${file} is corrupt (${r.error}) — registry is read-only until fixed${r.copy ? `; copy kept at ${r.copy}` : ""}`);
  }
  corruption = { error: r.error, copy: r.copy };
  return { projects: [], missing: false, corrupt: true };
}

export function loadProjects() {
  const reg = readRegistry();
  if (reg.missing) {
    // first boot ever — seed the sandbox once; removal is then respected
    const seeded = [{ name: "sandbox", path: SANDBOX_DIR }];
    persist(seeded);
    return seeded;
  }
  return reg.projects;
}

function persist(projects) {
  writeJsonAtomic(registryFile(), { projects });
}

/** Load for a mutation: refuses on a corrupt registry instead of clobbering it. */
function loadForWrite() {
  const reg = readRegistry();
  if (reg.corrupt) {
    throw new Error(`projects.json is corrupt (${corruption.error}) — fix or remove it${corruption.copy ? ` (copy kept at ${corruption.copy})` : ""}; refusing to overwrite`);
  }
  return loadProjects();
}

export function addProject({ name, path: dir }) {
  const cleanName = String(name ?? "").trim();
  const cleanPath = String(dir ?? "").trim();
  if (!cleanName || !cleanPath) throw new Error("name and path are required");
  if (!path.isAbsolute(cleanPath)) throw new Error("path must be absolute");
  const existing = loadForWrite(); // refuses on a corrupt registry before any side effect
  if (cleanName === "sandbox" && path.resolve(cleanPath) === SANDBOX_DIR) {
    // re-adding the removed sandbox: recreate the scratch folder + its
    // CommonJS pin (the repo is type:module — sandbox .js must stay CommonJS)
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    const pkg = path.join(SANDBOX_DIR, "package.json");
    if (!fs.existsSync(pkg)) {
      writeJsonAtomic(pkg, { name: "nano-cycle-sandbox", private: true, version: "0.0.0", type: "commonjs" });
    }
  }
  if (!fs.existsSync(cleanPath) || !fs.statSync(cleanPath).isDirectory()) {
    throw new Error(`path is not a directory: ${cleanPath}`);
  }
  const projects = existing.filter((p) => p.name !== cleanName);
  projects.push({ name: cleanName, path: path.resolve(cleanPath) });
  persist(projects);
  return projects;
}

/** Remove a project from the registry. Registry-only for user projects:
 *  nothing on disk is touched, and historical runs keep working (they load
 *  from runs/ by id). The sandbox is nano-cycle-owned scratch — removing it
 *  also deletes its folder. Throws when the name is unknown. */
export function removeProject(name) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw new Error("name is required");
  const projects = loadForWrite();
  if (!projects.some((p) => p.name === cleanName)) {
    throw new Error(`unknown project: ${cleanName}`);
  }
  persist(projects.filter((p) => p.name !== cleanName));
  if (cleanName === "sandbox") {
    fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  }
  return loadProjects();
}

/** Registry lookup ONLY: by registered name, or by the exact path of a
 *  registered project. Returns the registry entry; throws for anything else —
 *  an arbitrary absolute path is never accepted (register it first). */
export function resolveProject(nameOrPath) {
  const projects = loadProjects();
  const key = String(nameOrPath ?? "");
  const hit =
    projects.find((p) => p.name === key) ??
    (path.isAbsolute(key) ? projects.find((p) => path.resolve(p.path) === path.resolve(key)) : undefined);
  if (hit) return hit;
  throw new Error(`unknown project: ${key}`);
}
