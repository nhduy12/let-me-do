---
name: unclaim-task
description: Release a task back to the open pool. Only the current claimer can unclaim (no force here). Useful when the user realizes they can't finish or wants to hand off.
allowed-tools: Bash, mcp__brain__query, mcp__brain__get_settings, mcp__brain__unclaim_task
user-invocable: true
---

# unclaim-task

> *"Putting this back."*

Releases ownership of a task. Sets `claimed_by = NULL`, `claimed_at = NULL`, status back to `pending`. `current_step` is preserved as-is so the next claimer can resume from where it left off.

## Workflow

1. **Resolve current user**: `git config user.email`.
2. **Parse args**:
   - Positional: `<task-id>` (required)
   - `--reason <text>` — optional note recorded with the `unclaim` event in `task_events`
3. **Validate**:
   - Task exists.
   - `claimed_by = me` — cannot unclaim someone else's task. That's transfer, use `/lmd:claim-task <id> --force`.
4. **Unclaim** — call `mcp__brain__unclaim_task({ id, claimer, reason })`. The MCP tool runs the `UPDATE` with `WHERE claimed_by = $claimer` and appends an `unclaim` row to `task_events`.
5. **If 0 rows affected** → either task doesn't exist or claimed_by ≠ me. Report.

Status is always set to `pending` (no soft-block mode). Use `--reason` to leave an audit note; if the task is truly blocked, autopilot would have already set `status = 'blocked'`.

Any in-flight autopilot is not stopped by unclaim — it will detect the status change on its next iteration and exit cleanly (per autopilot's cancellation rules).

## Args

```
/lmd:unclaim-task 20260523-001
/lmd:unclaim-task 20260523-001 --reason "blocked on auth refactor"
```

## Output

- Success: confirmation + task now in pool.
- Failure: reason (not yours, doesn't exist).
