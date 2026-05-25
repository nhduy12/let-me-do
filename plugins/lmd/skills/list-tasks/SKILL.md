---
name: list-tasks
description: List open tasks the user can pick up — defaults to tasks assigned to the current git user OR sitting in the unassigned pool, status not done. Use when the user asks "what's on my plate", "what tasks are left", "what should I work on today". Output is a numbered list ready for the user to pick by index ("start the second one") or by id.
allowed-tools: Bash, mcp__brain__query, mcp__brain__get_settings
user-invocable: true
---

# list-tasks

Morning standup helper. Combines tasks assigned to me with the open pool, filters out done/cancelled, presents a numbered picklist.

## Default behavior (zero-arg)

When invoked with no args (or user just asks "what tasks are left?"):

1. Resolve current user: `git config user.email`.
2. Query brain — **pass the email via `params` ($1), never string-concatenate**:
   ```
   mcp__brain__query({
     sql: `SELECT id, title, status, current_step, assigned_to, claimed_by, summary, updated_at
           FROM tasks
           WHERE status NOT IN ('done','cancelled')
             AND (assigned_to = $1 OR claimed_by = $1
                  OR (assigned_to IS NULL AND status = 'pending'))
           ORDER BY
             CASE status WHEN 'active' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END,
             updated_at DESC
           LIMIT 20`,
     params: [user_email]
   })
   ```
   Limit fixed at 20 — refine with `--search` or other filters for more. Same pattern for `--search`, `--by`, etc.: keep all user-supplied values in `params`.
3. Parse `Priority:` / `Deadline:` lines from each `summary` for sorting hints.
4. Render a 1-indexed numbered list, plain text. Priority as `[high]` / `[medium]` / `[low]`, deadline as `due <YYYY-MM-DD>`.

```
Open tasks (3):

  [1] 20260523-001-[lms-auth]-add-settings-page    active · step=qa     mine
      [high] · due 2026-06-01
      Add settings page with delete-account modal

  [2] 20260524-003-[lms-backend]-fix-payment-redirect  pending           unassigned
      [medium]
      Fix payment redirect after expired session

  [3] 20260522-007-[docs]-update-readme           claimed              mine
      [low]
      Update README to reflect new install flow

Next: say "start 1" / "claim 2" / "status 3" — or pass the task id.
```

Format friendly to natural-language pickup: the main agent maps "start the first one" → `claim-task 20260523-001-[lms-auth]-add-settings-page`.

## Filtered modes

```
/lmd:list-tasks                    # default — mine + open pool, not done (recommended)
/lmd:list-tasks --unassigned       # ONLY the open pool
/lmd:list-tasks --mine             # only mine (assigned or claimed by me)
/lmd:list-tasks --all              # everything including done
/lmd:list-tasks --status active    # filter by status
/lmd:list-tasks --by alice@example.com   # tasks created by alice
/lmd:list-tasks --search "login"   # full-text search title + summary
/lmd:list-tasks --priority high    # parses "Priority: high" convention line
/lmd:list-tasks --due-before 2026-06-01  # parses "Deadline:" line
```

Scope is intentionally not a filter — scopes are flexible labels (not a fixed taxonomy), and the visible `[scope]` tag in the id is enough for eyeballing. Override sort via `--sort priority` or `--sort deadline`.

## Sorting

Active > Claimed > Pending. Within each group, `updated_at DESC` (freshest top). `updated_at` shown per row so freshness is eyeball-able — no separate stale-highlighting.

## Output

- 1-indexed numbered list (primary UX).
- Per item: status, current step, ownership, title, priority/deadline.
- Count summary at top.
- Next-action hint at bottom.
