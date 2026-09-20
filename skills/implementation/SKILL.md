---
name: implementation
description: Method for the IMPLEMENT phase of a build run (milestone 2.3). Load before writing any product code. Covers the full-mandate coding rules, failure-path testing, subagent dispatch execution, fix-round discipline, and the impl-delta report. Mandatory before calling submit_impl_delta.
---

# Implementation (build phase 2.3)

Now build. Work through the tasks (in dependency order; dispatched subagents for
the disjoint heavyweights per the task-breakdown policy). When ALL tasks are done
— every acceptance criterion satisfied, lint and tests green — report via
`submit_impl_delta`.

## Rules (binding)

- Implement the task FULLY — every artifact the task, the spec's acceptance
  criteria, and the injected rules require. No stubs, no TODOs, no placeholder
  logic, no "left as an exercise" scaffolding.
- TypeScript strict where applicable; no `any`.
- Cover failure paths, not just happy paths: tests that degrade each external
  dependency and assert error shapes catch what green-path tests never will.
- Run lint and tests for what you changed BEFORE reporting; fix what they
  surface. If no test setup exists, create the minimum honest one the testing
  rules demand.
- Stay inside the task's assigned files. Another task (or a dispatched sibling)
  owns the rest. If a task genuinely cannot complete without touching a foreign
  file, do it, but call it out in the impl-delta notes.
- If a command needs something unavailable, surface it honestly instead of
  pretending success.
- Keep docs in sync with code in the same change: README claims, .env.example,
  documented commands — write only what is true.
- When dispatching (`dispatch_coder`): one call per task; the subagent gets the
  task brief and the contract — verify its `files_written` and notes on return,
  and lint/test its output before considering the task done. You own what your
  subagents produce.

## Fix rounds (feedback turns)

When a feedback turn arrives from verification:

- Fix ONLY the cited gaps; do not refactor unrelated code that already passes.
- The feedback names owning tasks where derivable — the fix usually belongs
  there.
- After fixing, call `submit_impl_delta` AGAIN with the updated `files_written`
  and notes describing what changed and why.

## Session discipline (long builds)

Your context may be compacted on long builds. The feedback turn re-states the
plan, tasks, and spec — re-read the key files you are about to edit before
editing, and re-check the task's acceptance criteria rather than trusting
memory.

## The impl-delta report

Call `submit_impl_delta` exactly once per round with:

- `summary` — what was built (features delivered, commands to see them work)
- `files_written` — every file created/modified this round (project-relative)
- `notes` — decisions made, deviations from the plan and why, anything the
  verifier should know (impl-delta: the difference between planned and built)
- `task_completion` — per task: `done | partial | skipped` + a line of status

Honesty is the point: a partial task marked `done` buys you a failing verify
round later at double cost.
