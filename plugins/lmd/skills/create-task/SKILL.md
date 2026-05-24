---
name: create-task
description: Create a structured task record in the brain `tasks` table. Probes the creator thoroughly for scope, acceptance criteria, related nodes, and constraints — but never for implementation details. Downstream agents (developer, scouter) figure out HOW.
allowed-tools: Bash, Read, Glob, Grep, mcp__brain__query, mcp__brain__find_paths, mcp__brain__create_task
user-invocable: true
---

# create-task

User-facing entrypoint. Always probes WHY/WHAT thoroughly. **Never probes HOW** (implementation, root cause, file paths) — that's `developer` + `scouter`'s job.

Roles: creator knows WHY/WHAT; executor (whoever claims) knows HOW. The creator may be offline when the executor picks up, so capture intent richly without forcing speculation about implementation.

## Args & flags

```
/lmd:create-task [<raw request>]
   [--scope <value>]    # bypass scope inference; required when --no-clarify
   [--assign <email>]   # assign to a teammate (default: self)
   [--pool]             # open pool, anyone can claim
   [--type <feature|fix|refactor|chore|docs>]    # default: inferred
   [--start]            # claim for self + spawn autopilot after writing
   [--no-clarify]       # skip ALL probes & confirmations (batch / autopilot mode)
```

## Policy

**One call = exactly one task.** If the raw request describes multiple sub-jobs, they become bullets in the same task's `acceptance_criteria`. Run the skill again for separate tasks.

## `--no-clarify` mode (batch / autopilot)

Never asks the user a question. Produces a valid task from the raw request + flags or refuses. Per-phase behavior:

| Phase | Behavior |
|---|---|
| Title | Raw request verbatim, truncated to 80 chars. |
| Scope | `--scope` required; refuse if missing. |
| Done criteria | Single bullet: `"<title> works as described"`. |
| Related nodes / Constraints / Priority / Deadline | Skip (empty / defaults). |
| Type | `--type` flag, else `feature`. |
| Assignment | Respect `--assign` / `--pool` / default self. No unknown-email warning. |
| Preview | **Skipped.** Write immediately. |
| Output | One-line summary. |

`--no-clarify` without `--scope` → refuse with `"--scope is required when --no-clarify"`.

## Workflow (full probe mode)

### Phase 0 — Bootstrap

- Resolve creator: `git config user.email` (cache for session).
- Read the raw request (from `$ARGUMENTS` or one open prompt).

### Phase 1 — Title

Paraphrase into a sharp one-line title (≤80 chars, imperative). Don't ask the user to confirm here — final edit happens in Phase 7 preview.

### Phase 2 — Scope

Scope = folder name(s). No taxonomy, no brain lookup. Encoded twice: in the id as `[scope]` (cosmetic) and as the canonical `Scope: <value>` line in `summary` (what agents parse).

Examples:
- `apps/crm/` → `crm`
- `apps/lms/src/modules/auth/` → `lms-auth` (parent + module joined with `-`)
- `apps/lms/backend/` → `lms-backend`
- `packages/ui-kit/` → `ui-kit`
- `services/api/` → `api`
- Cross-cutting: `docs`, `infra`, `ops`
- Multi-scope: ` + `-joined (literal spaces): `crm + lms-auth`, `lms-backend + crm-backend`

Style: lowercase kebab-case, mirror folder names.

Procedure:

1. Scan repo for likely scope roots: `apps/*`, `packages/*`, `services/*`, `modules/*`. Filesystem-only.
2. Infer scope from request via keyword match against folder names.
3. Module-level: request mentions a sub-area ("auth") → look for `apps/<app>/**/auth/`. Found → propose `<app>-<module>`.
4. Multi-scope: request mentions distinct areas → propose ` + `-joined.
5. Confirm with user: `Inferred scope: <value> (matched <folder>). Confirm, edit, or type another.`

**Forbidden values**: `multi` / `all` / `everything` / `*` are rejected — agents need explicit constituents to know which folders' nested `CLAUDE.md` to read. Ask for specifics and rebuild.

### Phase 3 — Done criteria

Draft from the title. If the raw request mentions several sub-jobs, propose ≥1 bullet per sub-job. No upper bound. User edits.

Each bullet must be:
- **Behavioral** — user-observable, not code structure. ✅ "Modal opens on Delete click" ❌ "Modal component mounted in `src/components/Settings.tsx`".
- **Atomic** — one check per bullet.
- **Verifiable** — `tester` can confirm pass/fail without ambiguity.

Avoid leaking implementation (specific routes, endpoints, libraries, files).

Example draft for "add settings page with delete-account modal":

```
- [ ] Settings page is reachable from the main nav and renders without auth error
- [ ] "Delete account" action is visible on the settings page
- [ ] Clicking it opens a confirmation modal
- [ ] Modal requires email re-entry before the destructive button activates
- [ ] Confirming completes account deletion and the user is signed out to the public area
```

### Phase 4 — Related nodes

Full-text search brain (GIN index):

```sql
SELECT id, label FROM nodes
WHERE to_tsvector('simple', label || ' ' || COALESCE(description, ''))
      @@ plainto_tsquery('simple', :keywords)
  AND app = :scope
ORDER BY ts_rank(...) DESC LIMIT 5;
```

Optionally spawn `scouter` for intent-based matches beyond keywords.

Surface top 5 candidates ranked by `ts_rank`. Show count if more matches exist. User marks relevant ones or adds new ids as `<scope>:<slug>`. Stored in `related_node_ids` JSONB. **Don't create node entries here** — `developer` upserts them when work happens.

### Phase 5 — Constraints / edge cases

Free-form prompt with category hints (auth, performance, compliance, accessibility, browser/device, backward compat). User types "none" or free-form notes. Appended to `summary` as a `Constraints:` block.

### Phase 5b — Priority & deadline

Ask priority (low / medium / high / critical, default `medium`) and deadline (ISO `YYYY-MM-DD`, or skip). Stored in `summary` after `Scope:`:

```
Scope: web
Priority: high
Deadline: 2026-06-01

[free-form description]
```

`list-tasks` and `status` parse these for filtering / sorting.

### Phase 6a — Type

If `--type` not provided, infer from keywords (`fix`/`bug` → fix; `add`/`new` → feature; `clean up`/`rewrite` → refactor; `docs` → docs; else chore). Confirm.

### Phase 6b — Assignment

- `--assign <email>`: validate format; check `git log --format='%ae' | sort -u` for history. No history → warn (don't block; new contributors are valid) and list up to 5 known authors as typo suggestions; user proceeds or aborts.
- `--pool`: `assigned_to = NULL`.
- Default: `assigned_to = current user`.

### Phase 7 — Preview

Render the full draft:

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

  <free-form description>

  Constraints:
  - Must require email re-entry (compliance, right-to-erasure).

Acceptance criteria:
  [ ] Settings page reachable from main nav, renders without auth error
  [ ] "Delete account" visible on the settings page
  [ ] Clicking opens confirmation modal
  ...

Related nodes:
  - web:settings
  - web:account-overview
```

Ask: `"Looks right? y to write, or tell me what to change."` Loop until confirmed.

### Phase 8 — Write

Call `mcp__brain__create_task` with `scope`, `title`, `summary`, `type`, `created_by`, `assigned_to`, `acceptance_criteria`, `related_node_ids`. MCP auto-generates the id as `<YYYYMMDD>-<NNN>-[<scope>]-<slug>` and returns the inserted row.

### Phase 9 — Output + optional start

```
✓ Created task 20260523-001-[lms-auth]-add-settings-page
  Status: pending
  Assigned to: bob@example.com
  Bob can run: /lmd:claim-task 20260523-001
```

If `--start` AND `assigned_to == current user` → invoke `Skill({ skill: 'claim-task', args: '<task_id>' })` to claim + hand off to autopilot.

## Examples

```
/lmd:create-task "add settings page with delete-account modal"
  → full probe, default type, scope asked, default assignee (self)

/lmd:create-task "fix login redirect after expired session" --type fix --assign bob@example.com
  → full probe but skips type confirmation; assigns to Bob

/lmd:create-task "rewrite reports module" --type refactor --pool
  → full probe, into pool

/lmd:create-task "quick docs typo fix in footer" --type docs --no-clarify
  → no probe; minimal task

/lmd:create-task "explore new onboarding flow" --start
  → probe + self-assign + immediate autopilot
```
