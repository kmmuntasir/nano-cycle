# Known issues and deliberate limits

What is still open or intentionally not done, most important first. How the
system is meant to work: [ARCHITECTURE.md](ARCHITECTURE.md). Line anchors are
function or marker names in `host/` (line numbers drift).

## Open

### 1. Security-override gate is not re-presented after a restart

The `security-override` gate (`engine.mjs`, `runGates`, the `openGate` call
with `type: "security-override"`) keeps no pending stash, unlike the answers gate
(`pendingQuestions`) and plan/divergence gates (`pendingPlanGate`). If the
server restarts while the owner is deciding, Resume re-enters the security step
and re-runs the scan and triage instead of showing the same findings, which
costs tokens and may produce different findings.

### 2. Rebase re-verify skips the security scan

When the base moved and the rebased tree differs from the verified one,
`execute()` re-runs only `verifyLoop` (`REBASE_REVERIFY_MAX`,
`REBASE_FIX_ROUNDS`). Code merged in from the new base, or changed by a rebase
fix round, is never re-scanned. The security-fix path has the same shape
(re-verify, then re-scan) so the pieces exist; the rebase path just does not
call the security step.

### 3. Gitignored non-`.env` files are not carried into worktrees

`git.mjs` (`linkNodeModules`, `copyEnvFiles`) shares only `node_modules`
(symlink) and `.env` / `.env.*` (copy). `dist/`, `.venv`, caches, local DBs and
other ignored inputs are absent, so a build or test that needs them fails or
rebuilds inside the worktree. Gitignored files the agent creates there are
discarded with the worktree. Related sharp edges:

- `npm install` run by the agent writes through the symlink into the owner's
  real `node_modules`.
- `ensureExcluded` appends to the repo's shared `info/exclude`, so the
  anchored `/node_modules` lines also appear for the main checkout (harmless,
  but not cleaned up).

### 4. `git branch -d` on run delete can keep a merged branch

`engine.removeWorktree` deletes the run branch with `-d` so unmerged commits are
never destroyed. `-d` judges "merged" against the checked-out branch (or the
upstream), not the run's base branch, so a branch that was merged into the base
may be reported as `keptBranch` when the owner's checkout is on another branch.
The safe direction was chosen on purpose; the cost is leftover
`nano-cycle/<runId>` branches to delete by hand.

### 5. Mechanical checks produce self-referential findings on this repo

Running the check suite against nano-cycle itself reports findings that come
from the repo's own docs, fixtures and prompts rather than real defects. Do not
use a self-run as evidence either way.
`checks.mjs` has fixture tests for known false-positive shapes
(`tests/checks.test.mjs`); extend them for each new one, and demote a noisy
check with `NANO_CHECKS_ADVISORY`.

### 6. No live end-to-end validation of the worktree and auth changes

Worktree isolation, rebase re-verify, env-file copy, and the bearer/cookie/Origin
layer are covered by `tests/worktree.test.mjs`, `tests/auth.test.mjs` and the
engine harness, but the harness replaces pi with scripted fakes (abort and
close are no-ops; `prompt()` calls tools directly). Not yet exercised live:

- a full queue run (wave, release, sequential delivery, flip) on worktrees;
- cancel and resume racing a real provider stream;
- restart at each state (mid-build, at each gate, mid-merge);
- the proxy-deployed login flow (`NANO_TRUST_PROXY`, `Secure` cookie).

Treat the first real runs after an engine change as the validation.

### 7. Security triage has no memory

Every run re-triages the same findings from scratch; there is no fingerprint
dedupe and no remembered "accepted risk". Historically the same gitignored token
file was rated low four times and "high, unfixable" once, which stalled a ticket
for six hours at the override gate.

### 8. Gate value is unproven

Past real runs ran only on one model class (`glm-5.3-flash`). The audit step
never produced a blocking finding in ten ticket runs and verify caught one
functional defect. No cost in currency is recorded, only tokens. Do not assume
every step earns its latency; measure before adding steps.

### 9. Rebase conflicts fail the run

`landBranch` aborts a conflicting rebase and fails the run with the branch and
worktree kept. There is no in-product conflict resolution; resolve on the base
branch and Resume to retry the merge.

### 10. Frontend items from the post-mortem not re-audited

`TicketRow` copying props into local state (Save can overwrite newer server
data), the chat model-storage key across projects, and the per-token array copy
in console grouping were reported and not re-checked after the later web
commits. Look in `web/src/components/TicketsView.tsx`, `ChatView`, `App.tsx`.

## Deliberate non-goals

- **Pi only.** No other agent backends (Claude Code, Codex, opencode, ACP).
  The engine imports the pi SDK directly (`runner.mjs`); there is no adapter
  layer. Per-step model choice exists, per-step agent choice does not.
- **Agents run in the server process.** A restart or crash kills live sessions
  and gates; recovery re-attaches from disk (`resumeFromDisk`) but loses the
  in-flight turn. Avoid restarting mid-run. Gates block inside tool calls by
  design, so each gate has a live path and a restart re-presentation path
  (`pendingQuestions`, `pendingPlanGate`) that must be kept in step.
- **JSON files, not SQLite.** `runs/`, `tickets/`, `projects.json` with atomic
  writes and corruption guards. Fine for one owner; there are no cross-file
  transactions, so ticket and run state are reconciled at boot rather than
  updated atomically.
- **Sequential delivery.** One tree-holding run per project; no parallel
  tickets. Worktrees make parallelism safe in principle, but dev-server ports,
  compose project names and the merge order would need work first.
- **Single owner, single token.** No users or roles.
- **Repo-local skills ignored.** Only bundled skills load.
- **CI watch is GitHub Actions only** (`ci.mjs`).
