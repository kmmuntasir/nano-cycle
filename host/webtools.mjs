// Optional capability tools — present only when their backing service is
// available. The driver decides availability; the model decides usage.
//
//   web_search  → SearXNG JSON API (set NANO_SEARXNG_URL, e.g. http://127.0.0.1:8888)
//   web_reader  → obscura CLI (JS-rendering fetch, on PATH)
//
// Both are read-only research tools for clarify (PM) and plan nodes.
import { execFile, execFileSync } from "node:child_process";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

const CAP = 16_000;

/** Async twin of detectWebCapabilities — same probes, but never blocks the event
 *  loop (the sync one can stall boot for up to ~18 s). */
export async function detectWebCapabilitiesAsync(searxngUrl, signal) {
  const probe = async () => {
    if (!searxngUrl) return false;
    try {
      const base = searxngUrl.replace(/\/$/, "");
      const res = await fetch(`${base}/search?q=test&format=json`, {
        signal: AbortSignal.any([AbortSignal.timeout(6_000), ...(signal ? [signal] : [])]),
      });
      return Array.isArray((await res.json()).results);
    } catch {
      return false;
    }
  };
  const readerProbe = new Promise((resolve) => {
    execFile("obscura", ["--version"], { timeout: 10_000, signal }, (err) => resolve(!err));
  });
  const [search, reader] = await Promise.all([probe(), readerProbe]);
  return { search, reader };
}

export function detectWebCapabilities(searxngUrl) {
  // search: PROBE the JSON API — a defaulted URL (deploy.sh installs SearXNG
  // at a known endpoint) must silently disable the tool when nothing answers.
  let search = false;
  if (searxngUrl) {
    try {
      const base = searxngUrl.replace(/\/$/, "");
      const out = execFileSync(
        "curl",
        // plain common query — hyphenated rare strings make some upstream
        // engines hang past searxng's own timeout and return an empty body
        ["-s", "-m", "6", `${base}/search?q=test&format=json`],
        { encoding: "utf8", timeout: 8_000, maxBuffer: 1_000_000 },
      );
      search = Array.isArray(JSON.parse(out).results);
    } catch {
      search = false;
    }
  }
  let reader = false;
  try {
    execFileSync("obscura", ["--version"], { stdio: "ignore", timeout: 10_000 });
    reader = true;
  } catch {
    reader = false;
  }
  return { search, reader };
}

export function makeWebSearchTool(searxngUrl, log) {
  return defineTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web (SearXNG metasearch) and return the top results with URLs and snippets. " +
      "Use it to research libraries, APIs, and design questions.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
    }),
    execute: async (_id, params, signal) => {
      const base = searxngUrl.replace(/\/$/, "");
      const raw = await new Promise((resolve, reject) => {
        const req = execFile(
          "curl",
          ["-s", "-m", "15", `${base}/search?q=${encodeURIComponent(params.query)}&format=json`],
          { maxBuffer: 4 * 1024 * 1024, signal },
          (err, stdout) => (err ? reject(new Error(`web_search failed: ${err.message}`)) : resolve(stdout)),
        );
        return req;
      });
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("web_search: SearXNG returned non-JSON (is format=json enabled?)");
      }
      const results = (data.results ?? []).slice(0, 6);
      log?.(`web_search "${params.query}" → ${results.length} results`);
      const text =
        results.length === 0
          ? "No results."
          : results
              .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.content ?? "").slice(0, 200)}`)
              .join("\n");
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}

export function makeWebReaderTool(log) {
  return defineTool({
    name: "web_reader",
    label: "Web reader",
    description:
      "Read a web page as markdown (renders JavaScript via a headless browser). " +
      "Use it to read documentation or articles found via web_search.",
    parameters: Type.Object({
      url: Type.String({ description: "The http(s) URL to read" }),
    }),
    execute: async (_id, params, signal) => {
      if (!/^https?:\/\//.test(params.url)) throw new Error("url must be http(s)");
      const md = await new Promise((resolve, reject) => {
        execFile(
          "obscura",
          ["fetch", params.url, "--allow-private-network", "--dump", "markdown"],
          { timeout: 45_000, maxBuffer: 8 * 1024 * 1024, signal },
          (err, stdout) => {
            if (err && !stdout) return reject(new Error(`web_reader failed: ${err.message}`));
            const content = String(stdout ?? "").trim();
            if (!content) return reject(new Error("web_reader returned empty content"));
            resolve(content.length > CAP ? content.slice(0, CAP) + "\n\n(truncated)" : content);
          },
        );
      });
      log?.(`web_reader ${params.url} → ${md.length} chars`);
      return { content: [{ type: "text", text: md }], details: {} };
    },
  });
}
