// Small durable-file helpers shared by the persistence layer.
//
//   writeFileAtomic / writeJsonAtomic — write a temp file in the SAME directory,
//     fsync it, rename over the target. A crash or a concurrent reader sees the
//     old file or the new file, never a truncated one.
//   readJsonSafe — distinguishes "missing" from "corrupt". A corrupt file is
//     never treated as empty: the caller gets a flagged result (and, by
//     default, a `.corrupt-<mtime>` copy is kept) so a later write can't
//     silently destroy the only evidence of the owner's data.
import fs from "node:fs";
import path from "node:path";

let tmpSeq = 0;

export function writeFileAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${++tmpSeq}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw e;
  }
}

export function writeJsonAtomic(file, data, space = 2) {
  writeFileAtomic(file, JSON.stringify(data, null, space));
}

/**
 * Read + parse a JSON file without ever mistaking damage for emptiness.
 * Returns:
 *   { status: "ok", data }
 *   { status: "missing" }                         — the file does not exist
 *   { status: "corrupt", error, copy }            — unparsable/empty/truncated;
 *                                                   `copy` = path of the kept
 *                                                   `.corrupt-<mtime>` copy (null
 *                                                   when keepCopy is false)
 * Other I/O errors (EACCES, EISDIR…) are thrown — they are not "empty".
 * The copy name is derived from the file's mtime, so re-detecting the same
 * damaged file never piles up duplicates.
 */
export function readJsonSafe(file, { keepCopy = true } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return { status: "missing" };
    throw e;
  }
  try {
    return { status: "ok", data: JSON.parse(text) };
  } catch (e) {
    let copy = null;
    if (keepCopy) {
      try {
        const mtime = Math.floor(fs.statSync(file).mtimeMs);
        copy = `${file}.corrupt-${mtime}`;
        if (!fs.existsSync(copy)) fs.copyFileSync(file, copy);
      } catch {
        copy = null;
      }
    }
    return { status: "corrupt", error: e?.message ?? String(e), copy };
  }
}
