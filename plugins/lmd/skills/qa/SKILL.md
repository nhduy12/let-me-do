---
name: qa
description: Run tester against the current diff or a specific task. Verifies acceptance criteria, walks brain for expected flows, notes any edges the diff implies but brain doesn't yet know. Use this for ad-hoc verification outside the brief→autopilot workflow.
allowed-tools: Read, Write, Glob, Grep, Bash, mcp__brain__query, mcp__brain__find_paths, mcp__brain__get_settings, mcp__brain__upsert_edge
user-invocable: true
---

# qa

Thin wrapper around the `tester` agent for standalone verification (no autopilot pipeline).

**When useful**: manual changes before commit; re-verify after an autopilot crash; CI gate.

## Workflow

1. Parse args from `$ARGUMENTS`:
   - `--task <id>` — verify against the task's acceptance criteria. Default: most recent task where `claimed_by = me` AND `status IN ('active','claimed')`. None → exit "no active task to verify".
   - `--diff <ref>` — verify a specific diff range (default: working tree vs `HEAD`).
   - `--no-save-gaps` — don't auto-persist discovered edges.
2. Prepare ad-hoc artifacts to satisfy tester's file-based contract:
   - `mkdir -p .lmd/autopilot/scouter .lmd/autopilot/developer`.
   - If `.lmd/autopilot/scouter/<task_id>.md` exists, reuse; else write a minimal placeholder.
   - Pick `adhoc_iter` as a unix timestamp (numeric, won't collide with autopilot counters).
   - Write a synthetic dev report at `.lmd/autopilot/developer/<task_id>-<adhoc_iter>.md` from `git diff --stat` + a 2-line summary.
3. Spawn `tester` with `task_id`, `iter: <adhoc_iter>`, `scout_file`, `dev_file`. Acceptance criteria pulled from brain.
4. Relay verdict by reading the returned test report file:
   - `pass` + summary.
   - `fail` + issue list + suggested fixes.
5. Pending edges are flushed automatically by tester. `--no-save-gaps` strips them from the agent payload before flush.

## Args

```
/lmd:qa                         # working tree, heuristic context
/lmd:qa --task <id>             # specific task
/lmd:qa --diff main..HEAD       # diff range
/lmd:qa --no-save-gaps          # report only
```

## Output

- Verdict (pass / fail).
- Per-criterion result.
- Pending edges (saved unless `--no-save-gaps`).
