---
name: status
description: Show detailed status of one task — current step, iteration, history, blockers, related nodes. Read-only.
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
4. **Render task detail**:
   - Header: id, title, type, status, current_step, iteration.
   - People: created_by, assigned_to, claimed_by, claimed_at.
   - Timing: created_at, updated_at, completed_at.
   - Acceptance criteria (formatted checklist).
   - Related nodes (id list — use `/lmd:explore` for graph traversal, not rendered here).
   - History as a compact timeline, one entry per line: `<step> iter@<time> <agent>: <outcome>`.
   - Blockers (if any, highlighted).
   - **Working-tree diff stat** appended when `status = 'active'` AND `claimed_by = me` — run `git diff --stat` and include the summary.
5. **Suggest next action** based on state:
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
