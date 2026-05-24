---
name: status
description: Show detailed status of one task — current step, iteration, event timeline, blockers, related nodes. Read-only.
allowed-tools: Bash, mcp__brain__query, mcp__brain__find_paths, mcp__brain__get_settings
user-invocable: true
---

# status

Pretty-print one task in detail. Read-only.

## Workflow

1. Parse args: positional `<task-id>` (required; prefix match if unique).
2. Fetch task:
   ```sql
   SELECT * FROM tasks WHERE id = $1 OR id LIKE $1 || '%' LIMIT 2;
   ```
3. Ambiguous prefix → list candidates and exit.
4. Fetch event timeline:
   ```sql
   SELECT kind, step, iter, agent, outcome, signature, report_ref,
          actor, reason, payload, created_at
   FROM task_events WHERE task_id = $1 ORDER BY created_at ASC;
   ```
5. Render:
   - Header: id, title, type, status, current_step, iteration.
   - People: created_by, assigned_to, claimed_by, claimed_at.
   - Timing: created_at, updated_at, completed_at.
   - Acceptance criteria (formatted checklist).
   - Related nodes (id list — use `/lmd:explore` for graph traversal).
   - Event timeline, one per line: `<kind> <step?> iter@<time> <agent?>: <outcome?>` (or `<kind> @<time> by <actor>` for claim/unclaim/transfer/cancel).
   - Blockers (if any, highlighted).
   - **Working-tree diff stat** when `status = 'active'` AND `claimed_by = me` — append `git diff --stat`.
6. Suggest next action:
   - `pending` + unassigned → `/lmd:claim-task <id>`.
   - `claimed` / `active` (autopilot stopped mid-task) → `/lmd:autopilot <id>` to resume.
   - `blocked` → inspect blockers + `.lmd/autopilot/<agent>/<id>*` artifacts, then `/lmd:autopilot <id>` to retry.
   - `done` → show commit hash if available.

## Args

```
/lmd:status 20260523-001-add-settings-page
/lmd:status 20260523-001            # prefix OK if unique
/lmd:status --short 20260523-001    # one-line summary
```

## Output

- Multi-section detail view (markdown).
- Or one-line summary with `--short`.
