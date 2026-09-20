---
name: task-breakdown
description: Method for the TASK BREAKDOWN phase of a build run (milestone 2.2). Load before splitting the approved plan into tasks. Covers decomposition rules, per-task acceptance criteria, dependency and file-overlap constraints, and when to dispatch parallel coder subagents. Mandatory before calling submit_tasks.
---

# Task breakdown (build phase 2.2)

The plan is approved. Now decompose it into TASKS — the units of implementation,
verification bookkeeping, and (when warranted) parallel dispatch. Submit via the
`submit_tasks` milestone tool.

## Decomposition rules

- Emit 2–8 tasks (a trivial feature may be a single task). Fewer, bigger slices
  beat many tiny ones; a task is "a coherent, independently checkable piece of the
  plan", not a file-type bucket.
- Every task gets:
  - `id` — short unique slug (e.g. `auth-endpoints`, `i18n-catalogs`)
  - `title` + `description` — what done looks like for this slice
  - `files` — the subset of the plan's files this task owns (≥1 file per task;
    a file may appear in two tasks ONLY if one depends on the other)
  - `acceptance_criteria` — task-level checks, runnable and specific ("GET
    /health returns 200 with JSON body when DB is up"), not restatements of the
    plan's whole-task criteria
  - `dependsOn` — task ids that must complete first (real build-order only:
    shared files, generated artifacts, API contracts consumed; never cosmetic
    ordering)
  - `size` — S (≤3 files, one concern) / M / L (multi-concern, own wiring)
- The union of task files must cover the plan's file list. A plan file nobody
  owns is work that silently never happens.

## The file-overlap rule (hard)

If two tasks touch the same file, one MUST `dependsOn` the other — the driver
rejects the breakdown otherwise. Shared files are sequential by definition;
file-disjoint tasks are the only candidates for parallel dispatch.

## Dispatch policy — subagents, only when necessary

You implement tasks in THIS session by default. Consider `dispatch_coder(task_id)`
(a fresh builder subagent for one task) only when BOTH hold:

1. The task is file-disjoint from every other in-flight task, AND
2. The task is substantial (size M/L) enough to justify a fresh context
   (re-reading the repo, re-learning conventions).

Anti-patterns: dispatching S tasks (coordination costs more than the task);
dispatching many tasks that all depend on each other (serialize them yourself);
dispatching to "parallelize" tasks that share a file (forbidden by the overlap
rule anyway). A clean default: implement sequentially in-context, dispatch only
genuinely independent heavyweights — typically 0–2 dispatches per run.

Fix rounds later: gaps arrive with owning-task hints — fix in-context unless the
fix clearly belongs to a dispatched task you never held context for.

## Submit

Call `submit_tasks` exactly once. If the driver REJECTS it (unknown dep, cycle,
overlap without dependency, empty task), the tool result names the problem —
fix and resubmit.
