---
name: status
description: Show detailed status of one task — current step, iteration, event timeline, blockers, related nodes. Read-only.
allowed-tools: Bash, mcp__brain__query, mcp__brain__find_paths, mcp__brain__get_settings
user-invocable: true
---

# status

> *"How's it going?"*

Pretty-print one task in detail. Read-only — no mutation.

## Workflow

1. **Parse args**:
   - Positional: `<task-id>` (required, supports prefix match if unique)
2. **Fetch task** via `mcp__brain__query`:
   ```sql
   SELECT * FROM tasks WHERE id = $1 OR id LIKE $1 || '%' LIMIT 2;
   ```
3. **If ambiguous prefix** → list candidates and exit.
4. **Fetch event timeline** via `mcp__brain__query` against `task_events`:
   ```sql
   SELECT kind, step, iter, agent, outcome, signature, report_ref,
          actor, reason, payload, created_at
   FROM task_events
   WHERE task_id = $1
   ORDER BY created_at ASC;
   ```
5. **Render task detail**:
   - Header: id, title, type, status, current_step, iteration.
   - People: created_by, assigned_to, claimed_by, claimed_at.
   - Timing: created_at, updated_at, completed_at.
   - Acceptance criteria (formatted checklist).
   - Related nodes (id list — use `/lmd:explore` for graph traversal, not rendered here).
   - Event timeline as a compact list, one entry per line: `<kind> <step?> iter@<time> <agent?>: <outcome?>` (or `<kind> @<time> by <actor>` for claim/unclaim/transfer/cancel rows).
   - Blockers (if any, highlighted).
   - **Working-tree diff stat** appended when `status = 'active'` AND `claimed_by = me` — run `git diff --stat` and include the summary.
6. **Suggest next action** based on state:
   - `pending` & unassigned → "use `/lmd:claim-task <id>`".
   - `claimed` / `active` (autopilot stopped mid-task) → "resume with `/lmd:autopilot <id>`".
   - `blocked` → "inspect blockers + `.lmd/autopilot/<agent>/<id>*` artifacts, then `/lmd:autopilot <id>` to retry".
   - `done` → show commit hash if available.

## Args

```
/lmd:status 20260523-001-add-settings-page
/lmd:status 20260523-001            # prefix OK if unique
/lmd:status --short 20260523-001    # one-line summary
```

## Output

- Multi-section detail view (markdown rendered).
- Or one-line summary with `--short`.
