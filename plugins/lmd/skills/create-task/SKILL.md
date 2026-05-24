---
name: create-task
description: Create a structured task record in the brain `tasks` table. Probes the creator thoroughly for scope, acceptance criteria, related nodes, and constraints — but never for implementation details. Downstream agents (developer, scouter) figure out HOW.
allowed-tools: Bash, Read, Glob, Grep, mcp__brain__query, mcp__brain__find_paths, mcp__brain__create_task
user-invocable: true
---

# create-task

User-facing entrypoint. Creates a task record in the brain `tasks` table. Always probes WHY/WHAT thoroughly. **Never probes HOW** (implementation, root cause, file paths) — that is `developer` + `scouter`'s job.

## Roles

- **Creator (you, the user)**: knows the WHY and WHAT.
- **Executor (whoever claims later)**: knows the HOW. Will use `scouter` to find root cause and decide on files.

The creator may be offline when the executor picks up the task. So this skill captures the intent richly — at the cost of a slightly longer intake — without forcing the creator to speculate about implementation.

## Args & flags

```
/lmd:create-task [<raw request>]
   [--scope <value>]         # bypass scope inference; required when --no-clarify
   [--assign <email>]        # assign to a teammate (default: self)
   [--pool]                  # open pool, anyone can claim
   [--type <feature|fix|refactor|chore|docs>]    # default: inferred from request
   [--start]                 # convenience: also claim for self + spawn autopilot
   [--no-clarify]            # skip ALL probes & confirmations, write minimal task (batch / autopilot)
```

## `--no-clarify` mode (batch / autopilot use)

When `--no-clarify` is set, the skill **never asks the user any question** — it must produce a valid task using only what's in the raw request + flags, or refuse with a clear error. This mode is for batch creation (e.g., main agent creating 50 tasks from a design system).

Per-phase behavior in `--no-clarify`:

| Phase | Behavior |
|---|---|
| 1. Title | Use raw request verbatim as title (truncated to 80 chars). No paraphrase confirm. |
| 2. Scope | `--scope` flag is **required** in this mode. Refuse if missing. No inference, no confirmation. |
| 3. Done criteria | Single bullet derived from title (`"<title> works as described"`). No expansion. |
| 4. Related nodes | Skip — write empty `related_node_ids`. |
| 5. Constraints | Skip. |
| 5b. Priority / deadline | Skip (default `medium`, no deadline). |
| 6a. Type | Use `--type` flag, else default `feature`. No confirm. |
| 6b. Assignment | Respect `--assign` / `--pool` / default self. No warning prompt for unknown email. |
| 7. Preview | **Skip entirely.** Write immediately. |
| 8. Write | Same. |
| 9. Output | Same one-line summary. |

If `--no-clarify` is used but `--scope` is missing → refuse with `"--scope is required when --no-clarify"`.

## Workflow (full probe mode)

### Phase 0 — Bootstrap

1. Resolve current user: `git config user.email` (cache for session).
2. Read the raw request (from `$ARGUMENTS` or ask the user one open prompt).

> **Policy**: one `create-task` call always produces **exactly one task**, never splits. If the raw request describes multiple sub-jobs, they all become bullets in the same task's `acceptance_criteria`. The user wanting separate tasks must run `/lmd:create-task` again per task.

### Phase 1 — Title

Paraphrase the request into a sharp one-line title (≤ 80 chars, imperative form). **Don't ask the user to confirm** — proceed silently. The user gets a final chance to edit the title (and everything else) in Phase 7 preview.

### Phase 2 — Scope

Scope is a short label (or set of labels) identifying what folder(s) of the codebase the task targets. It's encoded **twice**: visible inside the id as `[scope]` (cosmetic), and as the canonical `Scope:` line in `summary` (what agents parse).

**Scope derivation rule: scope = folder name(s) — no fancy taxonomy, no brain lookup.**

- `apps/crm/` → `crm`
- `apps/lms/` → `lms`
- `apps/lms/src/modules/auth/` → `lms-auth` (parent + module joined with `-`)
- `apps/lms/backend/` → `lms-backend` (parent + sub-folder)
- `packages/ui-kit/` → `ui-kit`
- `services/api/` → `api`
- Cross-cutting (docs / infra / ops): `docs`, `infra`, `ops` (no folder needed)
- Multi-scope: join folder-derived scopes with `+`, e.g. `crm + lms-auth`, `lms-backend + crm-backend`

Naming style: **lowercase, kebab-case**, mirror the folder names directly. Don't invent CamelCase or capital prefixes.

**Procedure:**

1. **Scan the repo** for likely scope roots — top-level `apps/*`, `packages/*`, `services/*`, `modules/*` folders. This is filesystem-only; no brain query.
2. **Infer scope** from the user request by keyword matching against discovered folder names.
3. **For module-level scopes**: if the request mentions a sub-area (e.g. "auth"), look for matching nested folders like `apps/<app>/**/auth/`. If found, propose `<app>-<module>`.
4. **Detect multi-scope**: if the request mentions distinct folders/areas, propose ` + `-joined scope.
5. Confirm with user:

> Inferred scope from folders: **`lms-auth`** (matched `apps/lms/src/modules/auth/`).
> Confirm, edit, or type another (use ` + ` (with spaces) to combine, e.g. `crm + lms-auth`).

> **Forbidden values**: never accept `multi` (or `all` / `everything` / `*`). Those tell agents nothing — they wouldn't know which folder's `CLAUDE.md` files to read. If the user types one of these, ask which folders specifically and rebuild the value.

> **Convention storage:**
> - **Inside the id** as `[<scope>]` between NNN and slug — purely visual aid.
> - **As the first line of `summary`** in the form `Scope: <value>` — agents parse this at Step 0 to know which folders' nested `CLAUDE.md` files to scan. For multi-scope, value is the ` + `-joined string (e.g. `Scope: lms-auth + crm-auth`).

### Phase 3 — Done criteria

Skill proposes a draft based on the title. **If the raw request mentioned several sub-jobs, propose at least one bullet per sub-job** so nothing is lost. There is no upper bound on bullets — a wide task can have 10+ criteria. User edits.

Each bullet **must be**:

- **Behavioral** — describes what the user sees / does, not how code is structured. ✅ "Modal opens on Delete click" ❌ "Modal component is mounted in `src/components/Settings.tsx`".
- **Atomic** — one check per bullet.
- **Verifiable** — `tester` can confirm pass/fail without ambiguity.

Avoid leaking implementation: don't reference specific routes, endpoints, libraries, or files. State the user-observable outcome.

Draft example for "add settings page with delete-account modal":
```
- [ ] Settings page is reachable from the main nav and renders without auth error
- [ ] "Delete account" action is visible on the settings page
- [ ] Clicking it opens a confirmation modal
- [ ] Modal requires email re-entry before the destructive button activates
- [ ] Confirming completes account deletion and the user is signed out to the public area
```

User can edit each line, add new ones, or remove.

### Phase 4 — Related nodes (link to brain flow graph)

1. Full-text search brain using the existing GIN index:
   ```sql
   SELECT id, label
   FROM nodes
   WHERE to_tsvector('simple', label || ' ' || COALESCE(description, ''))
         @@ plainto_tsquery('simple', :keywords)
     AND app = :scope
   ORDER BY ts_rank(...) DESC
   LIMIT 5;
   ```
2. For richer cross-references (similar screens by intent, not just keyword), optionally spawn the `scouter` agent:
   > "Find existing screens that resemble what the user described in scope=<app>"
3. Surface top 5 candidates (ranked by `ts_rank`). If more matches exist, show count:

> Top 5 candidates from brain (5 of 23 shown — refine title or use `--search-broader`):
> - `web:settings`
> - `web:account-overview`
> - ...
>
> Mark which are relevant, or add new node ids in the form `<scope>:<slug>`.

Result is stored in `related_node_ids` JSONB array. **Don't create new node entries here** — `developer` upserts them via `mcp__brain__upsert_node` when work actually happens.

### Phase 5 — Constraints / edge cases

Free-form prompt with category hints:

> Any constraints or edge cases the executor should know? Categories to consider:
> - **Auth**: must work for guests / specific roles
> - **Performance**: slow-network handling, large datasets
> - **Compliance**: GDPR / right-to-erasure / audit logging
> - **Accessibility**: keyboard navigation, screen readers, contrast
> - **Browser / device support**: older browsers, mobile-only
> - **Backward compatibility**: existing data, deprecated endpoints
>
> Type "none" to skip, or enter free-form notes.

Appended to `summary` as a "Constraints:" block.

### Phase 5b — Priority & deadline (optional metadata)

Ask:

> Priority? (low / medium / high / critical) — default `medium`. Press enter to keep default.
> Deadline? (ISO date `YYYY-MM-DD`, or skip)

These are **stored in `summary`** as additional convention lines after `Scope:`:

```
Scope: web
Priority: high
Deadline: 2026-06-01

[free-form description...]
```

`list-tasks` and `status` skills can parse these lines for filtering / sorting. Skip both if user has no preference (`list-tasks` defaults to no priority filter).

### Phase 6a — Type

If `--type` not provided, infer from keywords (`fix`/`bug` → `fix`; `add`/`new` → `feature`; `clean up`/`rewrite` → `refactor`; `update docs`/`README` → `docs`; etc.).

> Inferred type: **`fix`**. Confirm or change to one of: feature / fix / refactor / chore / docs.

### Phase 6b — Assignment

1. `--assign <email>`:
   - Validate email format (RFC-like).
   - Check whether the email has commit history: `git log --format='%ae' | sort -u | grep -F '<email>'`.
   - If no history → **warn but proceed** (don't hard-block; new contributors are valid). Show the warning along with up to 5 known git authors as suggestions in case of typo:
     > ⚠ Unknown email `unknown@example.com`. Known authors in this repo: alice@.., bob@.., ... Proceed anyway? (y/n)
2. `--pool`: leave `assigned_to = NULL`.
3. Otherwise default `assigned_to = current user`.

> Assign this task to: **`bob@example.com`** (open pool / yourself / specific teammate)?

### Phase 7 — Task draft preview

Render the full draft for the user:

```
ID:           (auto-generated as 20260523-NNN-[lms-auth]-add-settings-page)
Title:        Add settings page with delete-account modal
Type:         feature
Created by:   duy@example.com
Assigned to:  bob@example.com

Summary:
  Scope: lms-auth
  Priority: high
  Deadline: 2026-06-01

  User-friendly settings page including a confirmation modal for delete account.

  Constraints:
  - Must require email re-entry (compliance, right-to-erasure).
  - Must work post-auth only.

Acceptance criteria:
  [ ] Settings page is reachable from the main nav and renders without auth error
  [ ] "Delete account" action is visible on the settings page
  [ ] Clicking it opens a confirmation modal
  [ ] Modal requires email re-entry before the destructive button activates
  [ ] Confirming completes account deletion and the user is signed out to the public area

Related nodes:
  - web:settings
  - web:account-overview
```

Ask: **"Looks right? `y` to write, or tell me what to change."**

Loop until user confirms (unlimited rounds).

### Phase 8 — Write task

Call `mcp__brain__create_task` with `scope`, `title`, `summary`, `type`, `created_by`, `assigned_to`, `acceptance_criteria`, `related_node_ids`. The MCP tool auto-generates the id as `<YYYYMMDD>-<NNN>-[<scope>]-<slug>` and returns the inserted row.

### Phase 9 — Output + optional start

Print summary:

```
✓ Created task 20260523-001-[lms-auth]-add-settings-page
  Status: pending
  Assigned to: bob@example.com
  Bob can run: /lmd:list-tasks
                /lmd:claim-task 20260523-001
```

If `--start` was passed AND `assigned_to = current user`:
- The main agent invokes the `claim-task` skill via the Skill tool with the new id (`Skill({ skill: 'claim-task', args: '<task_id>' })`). That skill claims + hands off to `autopilot`.

## Examples

```
/lmd:create-task "add settings page with delete-account modal"
  → full probe, default type, default scope (asked), default assignee (self)

/lmd:create-task "fix login redirect after expired session" --type fix --assign bob@example.com
  → full probe but skips type confirmation; assigns to Bob

/lmd:create-task "rewrite reports module" --type refactor --pool
  → full probe, into pool for anyone to grab

/lmd:create-task "quick docs typo fix in footer" --type docs --no-clarify
  → no probe; minimal task using raw request as title + summary

/lmd:create-task "explore new onboarding flow" --start
  → probe + assign to self + immediately spawn autopilot
```

## Output

Always shows:
- Task id (returned from `create_task` MCP tool)
- Assignee + claim status
- Next-action hint per assignment

