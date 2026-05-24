---
name: qa
description: Run tester against the current diff or a specific task. Verifies acceptance criteria, walks brain for expected flows, notes any edges the diff implies but brain doesn't yet know. Use this for ad-hoc verification outside the brief→autopilot workflow.
allowed-tools: Read, Write, Glob, Grep, Bash, mcp__brain__query, mcp__brain__find_paths, mcp__brain__get_settings, mcp__brain__upsert_edge
user-invocable: true
---

# qa

> *"Check my work before I push."*

Thin wrapper around the `tester` agent. Lets the user invoke QA standalone without going through the full workflow.

## When useful

- Dev manually made changes and wants a quick verification before committing.
- A previous `autopilot` session crashed and the user wants to re-verify the latest diff.
- CI hook: run QA as a check on a branch.

## Workflow

1. **Parse args** from `$ARGUMENTS`:
   - `--task <id>` — verify against the task's acceptance criteria. If omitted, pick the most recent task where `claimed_by = me` AND `status IN ('active', 'claimed')`. If none → exit "no active task to verify".
   - `--diff <ref>` — verify a specific diff (default: working tree vs `HEAD`).
   - `--no-save-gaps` — skip auto-persisting discovered edges (default behavior persists them).
2. **Prepare ad-hoc artifacts** to fit the file-based agent contract:
   - Ensure `.lmd/autopilot/scouter/` and `.lmd/autopilot/developer/` exist (`mkdir -p`).
   - If `.lmd/autopilot/scouter/<task_id>.md` already exists for the resolved task, reuse it. Otherwise write a minimal one with just task context (no recon) at that path.
   - Pick `adhoc_iter` as a large integer that won't collide with autopilot's normal counters — use the current unix timestamp (e.g. `1748102400`). Iter values must be numeric so `tester`'s file path stays parseable by autopilot's `extract_iter` helper if recovery is ever needed.
   - Write a synthetic "ad-hoc dev report" at `.lmd/autopilot/developer/<task_id>-<adhoc_iter>.md` summarizing the diff (`git diff --stat` + a 2-line summary). This stands in for a real developer iteration.
3. **Spawn `tester` agent** with `task_id`, `iter: <adhoc_iter>`, `scout_file`, `dev_file` pointing at the artifacts above. Acceptance criteria are pulled from brain (natural-language bullets, matches `tester` agent expectations).
4. **Relay the agent's verdict** back to the user by reading the returned test report file:
   - `pass` + summary
   - `fail` + issue list + suggested fixes
5. **Pending edges** in the report are flushed by the tester agent automatically. Pass `--no-save-gaps` to suppress (the wrapper strips them from the agent payload).

## Args

```
/lmd:qa                         # verify working tree, heuristic context
/lmd:qa --task <id>             # verify against a specific task
/lmd:qa --diff main..HEAD       # verify a diff range
/lmd:qa --no-save-gaps          # only report, don't persist new edges
```

## Output

- Verdict (`pass` / `fail`).
- Per-criterion result.
- Pending edges (with suggested upsert) — saved automatically unless `--no-save-gaps`.
