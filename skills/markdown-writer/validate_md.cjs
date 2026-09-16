#!/usr/bin/env node
/**
 * validate_md.js — deterministic Markdown linter for the markdown-writer skill.
 *
 * Enforces the rules that LLMs chronically get wrong:
 *   1. Nested code fences: outer fence must use strictly more fence chars than inner.
 *   2. Table cell-count consistency across rows (catches unescaped `|` in cells).
 *   3. Blockquote continuity: blank lines inside a blockquote must begin with `>`.
 *   4. ASCII / Unicode box-drawing alignment: right borders within one fenced
 *      block must share the same column index.
 *   5. Hard line break intent: stacked bold-label lines missing trailing two
 *      spaces (error); suspected sentence hard-wraps missing trailing two
 *      spaces (warning).
 *   6. Mermaid diagrams: known diagram-type declaration, shape-delimiter
 *      pairing (`[/` must close with `/]`, `[[` with `]]`, …), balanced
 *      brackets and quotes per line, plus a full render pass. mermaid-cli is
 *      auto-installed into a per-user cache dir on first use (cross-platform:
 *      Windows / Linux / macOS; MD_VALIDATE_NO_INSTALL=1 opts out).
 *
 * Exit codes:
 *   0 = clean
 *   1 = one or more violations
 *   2 = usage / IO error
 *
 * Usage: node validate_md.js <path-to-markdown-file> [--strict]
 *   --strict  promote warnings to errors
 */

'use strict'

const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const strictFlag = argv.includes('--strict')
const fileArg = argv.find((a) => !a.startsWith('-'))

if (!fileArg) {
  process.stderr.write('usage: validate_md.js <file.md> [--strict]\n')
  process.exit(2)
}

let src
try {
  src = fs.readFileSync(path.resolve(fileArg), 'utf8')
} catch (err) {
  process.stderr.write(`error: cannot read ${fileArg}: ${err.message}\n`)
  process.exit(2)
}

const lines = src.split(/\r?\n/)
const violations = []
const warnings = []

function v(line, msg) {
  violations.push({ line, msg })
}
function w(line, msg) {
  warnings.push({ line, msg })
}

// ---------------------------------------------------------------------------
// 1. Nested code fences
// ---------------------------------------------------------------------------
// A fence opens with a run of backticks or tildes (>=3) optionally followed by
// Rule: outer fence char count must be strictly greater than any inner
// fence's char count of the same kind. If an inner line looks like a fence
// with the same char and count >= outer count, it either prematurely closes
// the outer block (no info string) or renders ambiguously (with info).
// Either way, violation.

const FENCE_RE = /^(\s*)(`{3,}|~{3,})(.*)$/

let openFence = null // { char, count, line }
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(FENCE_RE)
  if (!m) continue
  const [, , fence, info] = m
  const char = fence[0]
  const count = fence.length

  if (!openFence) {
    openFence = { char, count, line: i + 1 }
    continue
  }

  const isClose =
    char === openFence.char &&
    count >= openFence.count &&
    info.trim() === ''
  if (isClose) {
    openFence = null
    continue
  }

  if (char === openFence.char && count >= openFence.count) {
    v(
      i + 1,
      `inner fence uses ${count} '${char}'; outer fence (line ${openFence.line}) uses ${openFence.count}. Outer must use strictly more fence chars of the same kind, or switch fence char (backticks vs tildes)`
    )
  }
}
if (openFence) {
  v(openFence.line, `unclosed code fence opened here (no matching close)`)
}

// ---------------------------------------------------------------------------
// Re-scan with fence awareness so subsequent checks skip fenced content.
// Build a boolean array isCode[i] = true when line i is inside a fence.
// ---------------------------------------------------------------------------
const isCode = new Array(lines.length).fill(false)
{
  let open = null
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE)
    if (m) {
      const char = m[2][0]
      const count = m[2].length
      if (!open) {
        open = { char, count }
        continue // fence line itself not "inside"
      }
      if (char === open.char && count >= open.count && m[3].trim() === '') {
        open = null
        continue
      }
    }
    if (open) isCode[i] = true
  }
}

// ---------------------------------------------------------------------------
// 2. Tables: cell-count consistency
// ---------------------------------------------------------------------------
// A table block is a run of consecutive non-code lines where:
//   - first row has >=2 unescaped pipes (i.e. >=3 cells with edges, or >=1 cell
//     with internal pipes and pipe edges)
//   - second row is a delimiter row: ^\s*\|?\s*:?-{1,}[-:\s|]+\|?\s*$
// For each table, every row must have the same cell count. A mismatch usually
// means an unescaped `|` in cell content.

const CELL_SPLIT_RE = /(?<!\\)\|/ // unescaped pipe
const DELIM_RE = /^\s*\|?\s*:?-{1,}[-:\s|]*\|?\s*$/

let i = 0
while (i < lines.length) {
  if (isCode[i]) {
    i++
    continue
  }
  const line = lines[i]
  const cells = line.split(CELL_SPLIT_RE)
  const hasEdges = line.trim().startsWith('|') || line.trim().endsWith('|')
  const looksRow = hasEdges && cells.length >= 2
  const nextLine = lines[i + 1]
  const isDelimNext =
    nextLine !== undefined && !isCode[i + 1] && DELIM_RE.test(nextLine)
  if (looksRow && isDelimNext) {
    // Table starts here.
    const tableStart = i
    const headerCells = cells.length
    const delimCells = nextLine.split(CELL_SPLIT_RE).length
    const expected = headerCells
    if (delimCells !== expected) {
      v(i + 2, `table delimiter row has ${delimCells} cells, header has ${headerCells}`)
    }
    let j = i + 2
    const rowLines = [i + 1, i + 2]
    while (j < lines.length && !isCode[j]) {
      const l = lines[j]
      if (l.trim() === '') break
      const lc = l.split(CELL_SPLIT_RE).length
      if (lc !== expected) {
        v(j + 1, `table row has ${lc} cells, expected ${expected} (probably an unescaped \`|\` in a cell)`)
      }
      rowLines.push(j + 1)
      j++
    }
    i = j
    continue
  }
  i++
}

// ---------------------------------------------------------------------------
// 3. Blockquote continuity
// ---------------------------------------------------------------------------
// Within a contiguous blockquote run, every line including blank separators
// must begin with `>`. A blank line without `>` ends the blockquote; if the
// next non-blank line is again `>`, GitHub splits it into two <blockquote>
// elements — usually not the author's intent. We flag blank-line-breaks where
// a blockquote resumes immediately after.

for (let k = 0; k < lines.length; k++) {
  if (isCode[k]) continue
  const line = lines[k]
  if (line.trim() === '' && !line.startsWith('>')) {
    // Look forward: is the next non-blank line a blockquote?
    let m = k + 1
    while (m < lines.length && lines[m].trim() === '') m++
    if (m < lines.length && lines[m].startsWith('>')) {
      // And the previous non-blank line was a blockquote?
      let p = k - 1
      while (p >= 0 && lines[p].trim() === '') p--
      if (p >= 0 && lines[p].startsWith('>')) {
        v(k + 1, `blank line inside blockquote missing leading \`>\`; this splits the blockquote into two elements`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. ASCII / Unicode box-drawing alignment
// ---------------------------------------------------------------------------
// For each fenced block, gather lines that contain right-border characters
// (`│` U+2502, `┃` U+2503, or ASCII `|` when box-drawing peers are present).
// Within a block, every line's rightmost border column should match the modal
// right-border column for that block. Mismatch => jagged border.

const BOX_RIGHT = new Set(['│', '┃', '┐', '┘', '┤', '╗', '╝', '╡', '╣', '╜', '╢'])
const BOX_ANY = /[┌┐└┘├┤┬┴┼─━│┃║═╔╗╚╝╠╣╦╩╬╞╟╚╔╗╣╢╡╕╖╗╘╛╜]/

function rightBorderCols(blockLines) {
  // Returns array of { line, col } for each line that has a right border.
  const out = []
  for (const { text, lineNo } of blockLines) {
    if (!BOX_ANY.test(text)) continue
    // Rightmost column of any box-drawing right-border character on this line.
    let rightmost = -1
    for (let c = 0; c < text.length; c++) {
      const ch = text[c]
      if (BOX_RIGHT.has(ch) || ch === '|') {
        rightmost = c
      }
    }
    if (rightmost >= 0) out.push({ line: lineNo, col: rightmost })
  }
  return out
}

// Walk fence blocks.
{
  let j = 0
  while (j < lines.length) {
    const m = lines[j].match(FENCE_RE)
    if (!m) {
      j++
      continue
    }
    const openChar = m[2][0]
    const openCount = m[2].length
    const startLine = j
    j++
    const blockLines = []
    while (j < lines.length) {
      const m2 = lines[j].match(FENCE_RE)
      if (
        m2 &&
        m2[2][0] === openChar &&
        m2[2].length >= openCount &&
        m2[3].trim() === ''
      ) {
        break
      }
      blockLines.push({ text: lines[j], lineNo: j + 1 })
      j++
    }
    // blockLines now holds inner content. Check alignment.
    const cols = rightBorderCols(blockLines)
    if (cols.length >= 2) {
      // Mode of columns.
      const freq = new Map()
      for (const c of cols) freq.set(c.col, (freq.get(c.col) || 0) + 1)
      let modeCol = -1
      let modeCount = 0
      for (const [col, n] of freq) {
        if (n > modeCount) {
          modeCount = n
          modeCol = col
        }
      }
      for (const c of cols) {
        if (c.col !== modeCol) {
          v(
            c.line,
            `ASCII/box right border at column ${c.col + 1}; expected column ${modeCol + 1} (jagged border — re-pad inner text)`
          )
        }
      }
    }
    j++
  }
}

// ---------------------------------------------------------------------------
// 5. Hard line break intent
// ---------------------------------------------------------------------------
// Two heuristics, both guarding against single-\n lines that fuse into one
// rendered paragraph:
//
// (a) ERROR — stacked bold-label lines. Two consecutive non-code,
//     non-indented lines BOTH matching `**Label:** value` shape. This is the
//     classic version/status/author metadata block; author intent is always
//     one rendered line per entry. High confidence, near-zero false
//     positives (bullet items start with a marker, table rows with `|`,
//     headings with `#` — none match).
//
// (b) WARNING — line ends with `:`/`;` and the next starts with a lowercase
//     letter: a common LLM hard-wrap that fuses into one sentence. Weaker
//     signal (may be deliberate prose continuation), so warning only.

const LABEL_LINE_RE = /^\*\*[^*]+\*\*:?\s+\S/

for (let k = 0; k < lines.length - 1; k++) {
  if (isCode[k]) continue
  const a = lines[k]
  const b = lines[k + 1]
  if (!a || isCode[k + 1]) continue
  if (a.endsWith('  ') || a.endsWith('\t')) continue
  if (b.trim() === '') continue
  if (b.startsWith(' ') || b.startsWith('\t')) continue // continuation of list etc.

  if (LABEL_LINE_RE.test(a) && LABEL_LINE_RE.test(b)) {
    v(
      k + 1,
      `stacked label lines ("**Label:** value") fuse into one paragraph; end this line with two trailing spaces or a backslash to force a hard break`
    )
    continue
  }

  if (/[:;]\s*$/.test(a) && /^[a-z]/.test(b.trim())) {
    w(k + 1, `line ends without trailing two spaces; if this is meant to be a hard line break, append two spaces`)
  }
}

// ---------------------------------------------------------------------------
// 6. Mermaid diagrams — static syntax lint
// ---------------------------------------------------------------------------
// For every ```mermaid fenced block:
//   a. The first non-empty line must declare a known diagram type (warn if not
//      — the keyword list may lag new mermaid types).
//   b. Shape delimiters must pair exactly: `[/` closes with `/]`, `[\\` with
//      `\\]`, `[[` with `]]`, `([` with `])`, `[(` with `)]`, `((` with `))`,
//      `{{` with `}}`; bare `[` `(` `{` with `]` `)` `}`. A mismatch (e.g.
//      `A[/text]`) is a fatal lexical error in mermaid's parser.
//   c. Double quotes must balance on every line; quoted label contents are
//      masked out of all delimiter checks.

const MERMAID_TYPE_RE = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|mindmap|timeline|sankey-beta|xychart-beta|block-beta|info|pin)\b/

const MERMAID_SHAPE_PAIRS = [
  ['[[', ']]'],
  ['([', '])'],
  ['[(', ')]'],
  ['[/', '/]'],
  ['[\\', '\\]'],
  ['((', '))'],
  ['{{', '}}'],
]

function stripQuoted(s) {
  return s
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => ' '.repeat(m.length))
}

function checkMermaidLine(text, lineNo) {
  if (text.trim().startsWith('%%')) return // mermaid comment line
  // c. Quote balance on the raw line.
  const dq = (text.match(/(?<!\\)"/g) || []).length
  if (dq % 2 !== 0) {
    v(lineNo, `mermaid: unbalanced double quotes (odd count) — quote the whole label: A["label"]`)
  }
  // b. Shape delimiter pairing on the quote-masked line.
  const stripped = stripQuoted(text)
  let work = stripped
  for (const [open, close] of MERMAID_SHAPE_PAIRS) {
    let count = (s, t) => s.split(t).length - 1
    const oi = count(work, open)
    const ci = count(work, close)
    if (oi !== ci) {
      v(
        lineNo,
        `mermaid: shape opener \`${open}\` occurs ${oi}x but closer \`${close}\` occurs ${ci}x — shapes must pair (A[/text] closes as A[/text/]) or quote the label: A["text"]`
      )
    }
    // Mask matched tokens so single-char checks don't double-count their chars.
    work = work.split(open).join('\u0001'.repeat(open.length))
    work = work.split(close).join('\u0001'.repeat(close.length))
  }
  // Single-char delimiters must balance after multi-char tokens are masked.
  for (const [open, close] of [['[', ']'], ['(', ')'], ['{', '}']]) {
    const o = work.split(open).length - 1
    const c = work.split(close).length - 1
    if (o !== c) {
      v(lineNo, `mermaid: unbalanced \`${open}\`…\`${close}\` (${o} openers vs ${c} closers) — quote the label: A["label"]`)
    }
  }
}

// Walk fences (same walk as check 4) and lint mermaid blocks. Also collect
// them for the optional mmdc render pass.
const mermaidBlocks = []
{
  let j = 0
  while (j < lines.length) {
    const m = lines[j].match(FENCE_RE)
    if (!m) {
      j++
      continue
    }
    const openChar = m[2][0]
    const openCount = m[2].length
    const isMermaid = openChar === '`' && m[3].trim().toLowerCase() === 'mermaid'
    j++
    const body = []
    while (j < lines.length) {
      const m2 = lines[j].match(FENCE_RE)
      if (m2 && m2[2][0] === openChar && m2[2].length >= openCount && m2[3].trim() === '') break
      if (isMermaid) body.push({ text: lines[j], lineNo: j + 1 })
      j++
    }
    if (isMermaid && body.length > 0) {
      const before = violations.length
      // a. Diagram-type declaration on the first non-empty line.
      const first = body.find((b) => b.text.trim() !== '')
      if (first && !MERMAID_TYPE_RE.test(first.text.trim())) {
        w(first.lineNo, `mermaid block does not start with a known diagram type (flowchart, sequenceDiagram, …)`)
      }
      for (const b of body) checkMermaidLine(b.text, b.lineNo)
      mermaidBlocks.push({ body, hadViolations: violations.length > before })
    }
    j++
  }
}

// Full render tier: render every mermaid block with mermaid-cli (mmdc) —
// catches everything the static lint cannot (edge grammar, renderer-level
// errors). Cross-platform auto-provisioning: if mmdc is not on PATH, it is
// installed once into a per-user cache dir via npm — no sudo, no global
// state, works on Windows / Linux / macOS. Opt out with
// MD_VALIDATE_NO_INSTALL=1 (the static lint still runs).

const IS_WIN = process.platform === 'win32'
const MMD_CLI_PKG = '@mermaid-js/mermaid-cli@11'
const { spawnSync } = require('child_process')
const os = require('os')

function userCacheDir() {
  if (IS_WIN) return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches')
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
}

const mmdCacheDir = path.join(userCacheDir(), 'md-validator')
const mmdCliJs = path.join(mmdCacheDir, 'node_modules', '@mermaid-js', 'mermaid-cli', 'src', 'cli.js')

function spawnTool(cmd, args, timeout) {
  // Windows resolves .cmd shims (npm) only through a shell; args containing
  // spaces are pre-quoted for that case. Unix spawns directly — no shell.
  const finalArgs = IS_WIN
    ? args.map((a) => (/[\s"]/g.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a))
    : args
  return spawnSync(cmd, finalArgs, { timeout, shell: IS_WIN, stdio: 'pipe' })
}

function pathMmdcWorks() {
  try {
    return spawnSync('mmdc', ['--version'], { timeout: 15000, shell: IS_WIN, stdio: 'pipe' }).status === 0
  } catch {
    return false
  }
}

function ensureMermaidCli() {
  // 1. mmdc already on PATH (user's own install).
  if (pathMmdcWorks()) return { kind: 'path' }
  // 2. Our cached install.
  if (fs.existsSync(mmdCliJs)) return { kind: 'cache' }
  // 3. Auto-install (unless opted out).
  if (process.env.MD_VALIDATE_NO_INSTALL) return null
  process.stderr.write(
    `markdown-writer: mermaid-cli not found — installing into ${mmdCacheDir}\n` +
      `  (one-time: downloads a headless browser, ~2-5 min; set MD_VALIDATE_NO_INSTALL=1 to skip)\n`
  )
  try {
    fs.mkdirSync(mmdCacheDir, { recursive: true })
    const res = spawnTool(
      'npm',
      ['install', '--prefix', mmdCacheDir, MMD_CLI_PKG, '--no-audit', '--no-fund', '--loglevel=error'],
      600000
    )
    if (res.status !== 0) {
      process.stderr.write('markdown-writer: mermaid-cli install failed — falling back to static mermaid lint only\n')
      return null
    }
  } catch (err) {
    process.stderr.write(`markdown-writer: mermaid-cli install failed (${err.message}) — static lint only\n`)
    return null
  }
  return fs.existsSync(mmdCliJs) ? { kind: 'cache' } : null
}

let mermaidRenderMode = null
if (mermaidBlocks.length > 0) {
  const mmdc = ensureMermaidCli()
  if (mmdc) {
    mermaidRenderMode = 'rendered'
    // Chrome sandboxes fail in containers/CI; disable for validation runs.
    const pptrCfg = path.join(mmdCacheDir, 'puppeteer.json')
    try {
      fs.mkdirSync(mmdCacheDir, { recursive: true })
      fs.writeFileSync(pptrCfg, JSON.stringify({ args: ['--no-sandbox', '--disable-setuid-sandbox'] }))
    } catch {}
    mermaidBlocks.forEach(({ body, hadViolations }, bi) => {
      if (hadViolations) return // static lint already failed this block; don't re-flag via render
      const tmpIn = path.join(os.tmpdir(), `validate_md_mmd_${process.pid}_${bi}.mmd`)
      const tmpOut = path.join(os.tmpdir(), `validate_md_mmd_${process.pid}_${bi}.svg`)
      try {
        fs.writeFileSync(tmpIn, body.map((b) => b.text).join('\n') + '\n')
        const args = ['-i', tmpIn, '-o', tmpOut, '--quiet', '-p', pptrCfg]
        const res =
          mmdc.kind === 'path'
            ? spawnTool('mmdc', args, 120000)
            : spawnSync(process.execPath, [mmdCliJs, ...args], { timeout: 120000, stdio: 'pipe' })
        if (res.status !== 0) {
          const out = (res.stderr || res.stdout || 'render failed').toString().trim()
          const tail = out.split('\n').slice(-3).join(' | ')
          // Diagram parse errors surface through puppeteer's stack (rendering
          // happens in-browser), so "puppeteer" in the trace does NOT mean an
          // environment problem. Only an explicit browser-launch/download
          // failure is environmental — everything else fails the diagram.
          const envFailure = /could not find chrome|failed to launch the browser|browsernotdownloaded/i.test(out)
          if (envFailure) {
            w(body[0].lineNo, `mermaid render unavailable (environment): ${tail}`)
          } else {
            v(body[0].lineNo, `mermaid render failed (mmdc): ${tail}`)
          }
        }
      } catch (err) {
        w(body[0].lineNo, `mermaid render could not run: ${err.message}`)
      } finally {
        try { fs.unlinkSync(tmpIn) } catch {}
        try { fs.unlinkSync(tmpOut) } catch {}
      }
    })
  } else {
    mermaidRenderMode = 'static-only'
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let exit = 0
for (const { line, msg } of violations) {
  process.stderr.write(`${fileArg}:${line}: ERROR: ${msg}\n`)
}
for (const { line, msg } of warnings) {
  if (strictFlag) {
    process.stderr.write(`${fileArg}:${line}: ERROR (strict): ${msg}\n`)
  } else {
    process.stderr.write(`${fileArg}:${line}: WARN: ${msg}\n`)
  }
}

if (violations.length > 0) exit = 1
if (strictFlag && warnings.length > 0) exit = 1

if (exit === 0) {
  const mermaidNote =
    mermaidBlocks.length > 0 ? `, mermaid: ${mermaidRenderMode}` : ''
  process.stderr.write(
    `validate_md.js: ${fileArg} OK (${lines.length} lines checked, ${warnings.length} warnings${mermaidNote})\n`
  )
}
process.exit(exit)
