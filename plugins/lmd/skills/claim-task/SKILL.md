---
name: claim-task
description: Claim ownership of a task and (by default) immediately kick off the autopilot. Accepts a full task id, a unique prefix, or a 1-indexed position from the most recent `list-tasks` output ("start 1", "claim 2"). Use this when the user picks a task to work on.
allowed-tools: Bash, mcp__brain__query, mcp__brain__get_settings, mcp__brain__claim_task
user-invocable: true
---

# claim-task

> *"I'll take this one."*

Claims a task into the current user's queue. Identity from `git config user.email`. Race-safe via conditional `UPDATE` at the MCP layer.

## Identifier resolution

The skill accepts any of these as the task reference:

1. **Full id**: `20260523-001-[lms-auth]-add-settings-page` (quote if your shell interprets `[...]`)
2. **Unique prefix**: `20260523-001` — resolved if exactly one task matches (NNN is unique per day so this is usually enough). If a prefix matches multiple tasks, auto-pick the one with the highest NNN (most recent that day).
3. **List index**: `1`, `2`, `3` — resolved against the most recent `list-tasks` output in the session context. If no recent `list-tasks` context exists, ask the user to clarify.

## Workflow

1. **Resolve current user**: `git config user.email`.
2. **Parse args**:
   - Positional: `<task-ref>` (required) — id / prefix / index
   - `--no-start` — only claim, don't auto-spawn autopilot.
   - `--force` — claim even if someone else already claimed (transfer ownership). The MCP tool appends a `transfer` row to `task_events` (carries the prior owner in `payload`). Anyone can transfer (no role check).
3. **Resolve task-ref to a full id** (see "Identifier resolution" above).
4. **Atomic claim** — call `mcp__brain__claim_task({ id, claimer, force })`. The MCP tool runs a race-safe `UPDATE` with `WHERE (claimed_by IS NULL OR claimed_by = $claimer)`. Pass `force=true` to transfer ownership from another user.
5. **Check result**:
   - Row affected → success
   - 0 rows → someone else owns it; report current owner and suggest `--force` or wait.
6. **Hand off to `autopilot`** unless `--no-start`. The main agent invokes the `autopilot` skill via the Skill tool (`Skill({ skill: 'autopilot', args: '<task_id>' })`). Autopilot's preflight loads context and runs the scout → plan ⇄ plan-review → dev ⇄ test → review ⇄ dev → commit pipeline.

Re-claim of `blocked` or `cancelled` tasks is allowed: status resets to `claimed`, `current_step` and the `task_events` audit log are preserved for inspection.

## Args / examples

```
/lmd:claim-task 1                                              # by list index (most common)
/lmd:claim-task 20260523-001                                   # by prefix
/lmd:claim-task '20260523-001-[lms-auth]-add-settings-page'     # by full id (quote for [])
/lmd:claim-task 1 --no-start                                   # claim now, work later
/lmd:claim-task 20260523-001 --force                           # transfer ownership
```

## Natural-language pickup

This skill is designed to be auto-invoked when the user says things like:
- "Start the first one"
- "Claim task 2"
- "I'll take 20260523-001"
- "Pick up the login redirect task"

The main agent maps the phrase to the resolver and calls this skill.

## Output

- Success: confirmation + claimed_at + autopilot kickoff message (or "ready to work" if `--no-start`).
- Conflict: who currently owns it, when, and a suggestion (wait / contact owner / `--force` to transfer).
