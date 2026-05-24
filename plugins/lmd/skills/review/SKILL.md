---
name: review
description: Run reviewer against the current diff. Reviews code style, conventions, security, and brain consistency. Returns approve or request-changes with structured feedback. Use this for standalone review outside the brief→autopilot workflow.
allowed-tools: Read, Write, Glob, Grep, Bash, mcp__brain__query, mcp__brain__find_paths, mcp__brain__get_settings
user-invocable: true
---

# review

> *"Eyes on this before I commit."*

Thin wrapper around the `reviewer` agent. Lets the user invoke a structured code review standalone.

## When useful

- Dev finished a chunk of work, wants another opinion before commit / PR.
- Pre-PR sanity check, complementing human review.
- CI hook: run review as an automated gate.

## Workflow

1. **Parse args** from `$ARGUMENTS`:
   - `--diff <ref>` — review a specific diff range. Default: working tree against `HEAD` (most recent uncommitted changes).
   - `--task <id>` — pull task context from brain so reviewer knows intended scope.
   - `--strict` — flip style nits from `info` to `warn` (still doesn't block by itself; only substantive issues block).
2. **Prepare ad-hoc artifacts** to fit the file-based agent contract:
   - Ensure `.lmd/autopilot/scouter/`, `.lmd/autopilot/developer/`, `.lmd/autopilot/tester/` exist (`mkdir -p`).
   - Reuse `.lmd/autopilot/scouter/<task_id>.md` if present, else write a minimal placeholder.
   - Pick `adhoc_iter` as a numeric unix timestamp (e.g. `1748102400`) so file names parse cleanly.
   - Write a synthetic "ad-hoc dev report" at `.lmd/autopilot/developer/<task_id>-<adhoc_iter>.md` from `git diff --stat` + a 2-line summary.
   - Write a pseudo "test passed" file at `.lmd/autopilot/tester/<task_id>-<adhoc_iter>.md` (reviewer otherwise refuses when test verdict is missing). Acknowledge in the file that no real QA was run.
3. **Spawn `reviewer` agent** with `task_id`, `iter: <adhoc_iter>`, `scout_file`, `dev_file`, `test_file` pointing at the artifacts above. Convention sources are auto-detected by the agent: root `CLAUDE.md` + nested `CLAUDE.md` in each affected folder + `.claude/rules/*.md`.
4. **Relay verdict** to user by reading the returned review report file:
   - `approve` + brief comment.
   - `request-changes` + structured issue list (file:line + suggestion). Block-grade issues are security, correctness, convention violations from CLAUDE.md, and brain inconsistency. Style nits never block.
5. **Optionally write feedback to brain** (`--save-feedback`) so the task record carries review history (path of the review file).

Personal disagreement with a project convention surfaces as an `info` note. Project convention wins.

## Args

```
/lmd:review                       # review working tree
/lmd:review --diff HEAD~3..HEAD   # review last 3 commits
/lmd:review --task <id> --strict
/lmd:review --save-feedback       # persist feedback in the task record
```

## What review skill does NOT do

- Doesn't verify behavior (that's `/lmd:qa`).
- Doesn't change code (the user / dev applies fixes).
- Doesn't commit or push.

## Output

- Verdict (`approve` / `request-changes`).
- List of issues with severity (info / warn / block).
- Brain consistency report (any orphan edges or missing nodes the diff implies).
