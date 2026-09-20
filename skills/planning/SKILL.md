---
name: planning
description: Method for the PLAN phase of a build run (milestone 2.1). Load before producing the implementation plan. Covers investigation-first planning, task-shaped file assignments, acceptance-criteria carry-through, and the divergence protocol. Mandatory before calling submit_plan.
---

# Planning (build phase 2.1)

You are the BUILDER of this run, starting its first phase: produce an implementation
plan for the locked spec, then submit it via the `submit_plan` milestone tool. You
never write product code in this phase — planning only. After approval you will
continue (task breakdown → implementation) in this same session.

## Before you plan — investigate

A plan written against an imagined repo is worthless. First:

1. Read the REQUIREMENTS SPEC and the SOURCE REQUIREMENT DOCUMENTS in your prompt
   completely. The doc's requirements OUTRANK the spec's wording.
2. Survey the workspace: entrypoints, module layout, existing conventions, the
   stack actually installed (manifests AND lockfiles), test setup, CI, i18n/state/
   styling mechanisms already in place.
3. Read the injected project governance files (AGENTS.md / CLAUDE.md, rules files)
   — locked decisions there are requirements, not suggestions.

Codebase facts beat assumptions; where the spec and the repo contradict each other,
that is either an owner question (out of scope here — the spec is locked) or a
divergence (below).

## What the plan must contain

- `task_summary` — one paragraph restating WHAT will be built (not how).
- `approach` — the key technical decisions: architecture shape, data flow, which
  existing mechanisms you reuse vs create, migration/test strategy. Concrete enough
  that a reviewer can veto a wrong direction from this alone.
- `files` — every file you intend to create or modify, each with a `purpose` and
  the `task` slug it belongs to (tasks are named in the next phase; assign
  preliminarily now — every file to exactly one task). File lists are commitments:
  real paths, real purposes, no "etc."
- `acceptance_criteria` — verifiable, runnable/checkable criteria for the WHOLE
  task. Carry EVERY spec acceptance criterion VERBATIM (you may add sharper
  implementation-level criteria). Dropping or softening a spec criterion here
  poisons the whole run — the verifier gates on the spec regardless.
- `divergence` — ONLY if the task cannot be done as specified: explain precisely
  why (contradiction, missing prerequisite, impossible constraint) and stop.

## Plan quality rules

- Right-size the plan: 3–15 files covers most features; a plan listing 40 files or
  1 file for a multi-concern feature is equally wrong.
- Infra, CI workflows, compose files, Dockerfiles, .env.example, README and docs
  are files like any other — assign them to tasks; "infra is implied" is how
  substrate goes missing.
- Prefer reusing the repo's existing mechanisms (its error envelope, its i18n
  layer, its test harness) over inventing parallel ones.
- Name version pins and locked decisions explicitly in `approach` when the
  governance files demand them.

## Spec freshness (ticket-queue runs)

In queue mode your spec was clarified BEFORE earlier tickets were built. The
working tree may have moved since. During investigation, watch for
contradictions between the spec and the CURRENT tree: modules, APIs, or
features the spec references that don't exist anymore, or whose shape changed.
If you find one, that is a **staleness divergence** — do not silently adapt:
fill `divergence` with `"spec appears stale: <what changed and which ticket
likely caused it>"` so the owner can decide (re-clarify or approve as-is).

## Submit

Call `submit_plan` exactly once with the structured plan. If the driver or the
owner REJECTS it (the tool result tells you which and why), revise and resubmit —
do not argue, do not abandon the phase.
