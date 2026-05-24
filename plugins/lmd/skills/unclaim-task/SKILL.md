---
name: unclaim-task
description: Release a task back to the open pool. Only the current claimer can unclaim (no force here). Useful when the user realizes they can't finish or wants to hand off.
allowed-tools: Bash, mcp__brain__query, mcp__brain__get_settings, mcp__brain__unclaim_task
user-invocable: true
---

# unclaim-task

Releases ownership. Sets `claimed_by = NULL`, `claimed_at = NULL`, status → `pending`. `current_step` is preserved so the next claimer resumes from there.

## Workflow

1. Resolve current user: `git config user.email`.
2. Parse args:
   - Positional `<task-id>` (required).
   - `--reason <text>` — optional note saved with the `unclaim` event.
3. Validate: task exists; `claimed_by == me` (can't unclaim someone else's — use `/lmd:claim-task <id> --force` to transfer).
4. `mcp__brain__unclaim_task({ id, claimer, reason })`. MCP runs `UPDATE ... WHERE claimed_by = $claimer` and appends an `unclaim` row to `task_events`.
5. 0 rows affected → either task doesn't exist or `claimed_by ≠ me`. Report.

Status always resets to `pending` (no soft-block). Use `--reason` for audit notes. Truly blocked tasks already have `status = 'blocked'` from autopilot. In-flight autopilot doesn't stop on unclaim — it detects the status change on next iteration and exits cleanly per cancellation rules.

## Args

```
/lmd:unclaim-task 20260523-001
/lmd:unclaim-task 20260523-001 --reason "blocked on auth refactor"
```

## Output

- Success: confirmation + task now in pool.
- Failure: reason (not yours, doesn't exist).
