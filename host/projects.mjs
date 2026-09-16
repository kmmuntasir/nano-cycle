// Project registry — the local folder paths nano-cycle can run against.
// Persisted to projects.json (gitignored — local paths); a built-in "sandbox"
// project always exists for scratch/demo work.
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
  }
  if (!projects.some((p) => p.name === "sandbox")) {
    projects.unshift({ name: "sandbox", path: SANDBOX_DIR });
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
  if (!fs.existsSync(cleanPath) || !fs.statSync(cleanPath).isDirectory()) {
    throw new Error(`path is not a directory: ${cleanPath}`);
  }
  const projects = loadProjects().filter((p) => p.name !== cleanName);
  projects.push({ name: cleanName, path: path.resolve(cleanPath) });
  persist(projects);
  return projects;
}

/** Remove a project from the registry. Registry-only: nothing on disk is
 *  touched, and historical runs keep working (they load from runs/ by id).
 *  The built-in sandbox cannot be removed. Throws when the name is unknown. */
export function removeProject(name) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw new Error("name is required");
  if (cleanName === "sandbox") throw new Error("the built-in sandbox project cannot be removed");
  const projects = loadProjects();
  if (!projects.some((p) => p.name === cleanName)) {
    throw new Error(`unknown project: ${cleanName}`);
  }
  persist(projects.filter((p) => p.name !== cleanName));
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
