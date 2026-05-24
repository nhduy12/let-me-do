---
name: claim-task
description: Claim ownership of a task and (by default) immediately kick off the autopilot. Accepts a full task id, a unique prefix, or a 1-indexed position from the most recent `list-tasks` output ("start 1", "claim 2"). Use this when the user picks a task to work on.
allowed-tools: Bash, mcp__brain__query, mcp__brain__get_settings, mcp__brain__claim_task
user-invocable: true
---

# claim-task

Claims a task into the current user's queue. Identity from `git config user.email`. Race-safe via conditional `UPDATE` at the MCP layer.

## Identifier resolution

The skill accepts any of:

1. **Full id**: `20260523-001-[lms-auth]-add-settings-page` (quote if your shell interprets `[...]`).
2. **Unique prefix**: `20260523-001` — resolved if exactly one task matches. Multiple matches → auto-pick the highest NNN (most recent that day).
3. **List index**: `1`, `2`, `3` — resolved against the most recent `/lmd:list-tasks` output in session context. No recent output → ask the user to clarify.

## Workflow

1. Resolve current user: `git config user.email`.
2. Parse args:
   - Positional `<task-ref>` (required).
   - `--no-start` — claim only, don't auto-spawn autopilot.
   - `--force` — transfer ownership. MCP appends a `transfer` row to `task_events` (prior owner in `payload`). Anyone can transfer (no role check).
3. Resolve task-ref to a full id.
4. `mcp__brain__claim_task({ id, claimer, force })`. The MCP runs a race-safe `UPDATE` with `WHERE (claimed_by IS NULL OR claimed_by = $claimer)`. `force=true` skips the guard.
5. Result:
   - Row affected → success.
   - 0 rows → someone else owns it; report current owner; suggest `--force` or wait.
6. Hand off to autopilot unless `--no-start`: `Skill({ skill: 'autopilot', args: '<task_id>' })`. Autopilot's preflight does the rest.

Re-claim of `blocked` or `cancelled` tasks is allowed: status resets to `claimed`; `current_step` and `task_events` audit log preserved.

## Args & examples

```
/lmd:claim-task 1                                            # by list index (most common)
/lmd:claim-task 20260523-001                                 # by prefix
/lmd:claim-task '20260523-001-[lms-auth]-add-settings-page'  # full id (quote for [])
/lmd:claim-task 1 --no-start                                 # claim now, work later
/lmd:claim-task 20260523-001 --force                         # transfer ownership
```

## Natural-language pickup

Auto-invoked when the user says:
- "Start the first one" / "Claim task 2" / "I'll take 20260523-001" / "Pick up the login redirect task"

The main agent maps the phrase to the resolver and calls this skill.

## Output

- Success: confirmation + `claimed_at` + autopilot kickoff message (or "ready to work" with `--no-start`).
- Conflict: current owner + when + suggestion (wait / contact / `--force`).
