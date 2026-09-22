// Project registry — the local folder paths nano-cycle can run against.
// Persisted to projects.json (gitignored — local paths). A "sandbox" project
// is seeded on FIRST boot only (scratch/demo work); the owner may remove it
// like any other project, and it stays removed.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REGISTRY = path.join(ROOT, "projects.json");

export const SANDBOX_DIR = path.join(ROOT, "sandbox");

export function loadProjects() {
  let projects = [];
  if (fs.existsSync(REGISTRY)) {
    try {
      projects = JSON.parse(fs.readFileSync(REGISTRY, "utf8")).projects ?? [];
    } catch {
      projects = [];
    }
  } else {
    // first boot ever — seed the sandbox once; removal is then respected
    projects = [{ name: "sandbox", path: SANDBOX_DIR }];
    persist(projects);
  }
  return projects;
}

function persist(projects) {
  fs.writeFileSync(REGISTRY, JSON.stringify({ projects }, null, 2));
}

export function addProject({ name, path: dir }) {
  const cleanName = String(name ?? "").trim();
  const cleanPath = String(dir ?? "").trim();
  if (!cleanName || !cleanPath) throw new Error("name and path are required");
  if (!path.isAbsolute(cleanPath)) throw new Error("path must be absolute");
  if (cleanName === "sandbox" && path.resolve(cleanPath) === SANDBOX_DIR) {
    // re-adding the removed sandbox: recreate the scratch folder + its
    // CommonJS pin (the repo is type:module — sandbox .js must stay CommonJS)
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    const pkg = path.join(SANDBOX_DIR, "package.json");
    if (!fs.existsSync(pkg)) {
      fs.writeFileSync(pkg, JSON.stringify({ name: "nano-cycle-sandbox", private: true, version: "0.0.0", type: "commonjs" }, null, 2));
    }
  }
  if (!fs.existsSync(cleanPath) || !fs.statSync(cleanPath).isDirectory()) {
    throw new Error(`path is not a directory: ${cleanPath}`);
  }
  const projects = loadProjects().filter((p) => p.name !== cleanName);
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
  const projects = loadProjects();
  if (!projects.some((p) => p.name === cleanName)) {
    throw new Error(`unknown project: ${cleanName}`);
  }
  persist(projects.filter((p) => p.name !== cleanName));
  if (cleanName === "sandbox") {
    fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
  }
  return loadProjects();
}

export function resolveProject(nameOrPath) {  const projects = loadProjects();
  const byName = projects.find((p) => p.name === nameOrPath);
  if (byName) return byName;
  // Allow passing a raw absolute path directly — register-on-the-fly is the GUI's job,
  // but the API stays friendly to scripts.
  if (path.isAbsolute(nameOrPath) && fs.existsSync(nameOrPath)) {
    return { name: path.basename(nameOrPath), path: path.resolve(nameOrPath) };
  }
  throw new Error(`unknown project: ${nameOrPath}`);
}
