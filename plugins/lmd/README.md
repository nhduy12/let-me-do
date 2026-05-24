# let-me-do

> *"Hand it to me — I've got this."*

A toolkit of Claude Code agents that self-assign tasks and share memory through **brain** (a Postgres graph store). Every agent is a narrow specialist; brain is the shared substrate the agents read from and write to so context survives across sessions.

## Philosophy

- **Agents take ownership.** Each agent picks up a kind of task and runs it end-to-end without the main session having to micro-manage.
- **Brain is the single source of truth.** Anything an agent learns or produces (screen flows, tasks, plans, observations) gets distilled into structured records in brain. Future agents — or you — query it instead of re-deriving the context.
- **Safe writes via typed tools.** The brain MCP server exposes typed, parameterized tools (`upsert_node`, `upsert_edge`, `create_task`, `claim_task`, …). Idempotency, race-safety, and audit fields are enforced at the server, not at the agent layer. Raw `execute` exists only as an escape hatch.

## Components

```
let-me-do/
├── agents/                       ← workflow agents (autopilot, dev, qa, review, committer)
├── skills/                       ← user-invokable slash skills
│   ├── create-task/SKILL.md
│   ├── claim-task/SKILL.md
│   ├── list-tasks/SKILL.md
│   ├── status/SKILL.md
│   ├── unclaim-task/SKILL.md
│   ├── qa/SKILL.md
│   ├── review/SKILL.md
│   ├── commit/SKILL.md
│   ├── explore/SKILL.md
│   └── init-brain/SKILL.md
├── brain/                        ← foundation
│   ├── server/                  ← MCP server (Node, stdio) exposing typed tools
│   │   ├── package.json
│   │   └── index.mjs
│   └── sql/
│       └── setup.sql            ← parameterized schema (one DB per project)
└── .mcp.json                     ← MCP server config (`brain`)
```

### Agent roadmap

| Agent | Status | Purpose |
|---|---|---|
| `autopilot` (skill) | DRAFT | Orchestrates scout → plan ⇄ plan-review → dev ⇄ test → review ⇄ dev → commit pipeline for a task. |
| `scouter` | DRAFT | Read-only codebase recon. Step 0 of every autopilot pipeline; writes scout report file. |
| `code-planner` | DRAFT | Produces an implementation plan from scout + task. Never edits code. |
| `plan-reviewer` | DRAFT | Reviews the plan before any code is written. Pass → dev; fail → re-plan. |
| `developer` | DRAFT | Executes an approved plan. Upserts node/edge updates via typed brain tools. |
| `tester` | DRAFT | Verifies a diff against task acceptance criteria + flushes newly-found edges. |
| `reviewer` | DRAFT | Reviews code style, conventions, security, brain consistency. |
| `committer` | DRAFT | Composes commit message from task + final dev report, stages, commits (no push). |
| `flow-mapper` | TODO | Reads the frontend source, auto-detects screen flows. |
| `dead-screen-detector` | TODO | Finds graph nodes with no matching code and proposes removal. |

## Install

The repo is both a **marketplace** and a **plugin** — `.claude-plugin/marketplace.json` declares one plugin (`lmd`) whose source is the same repo root.

### From GitHub (recommended)

```bash
# 1. Add the marketplace (replace <github-user> with the repo owner)
claude plugin marketplace add <github-user>/let-me-do

# 2. Install the plugin
claude plugin install lmd@let-me-do --scope project
```

After install Claude Code prompts for the three user-config values from `plugin.json`:

- `database_uri` (sensitive) — Postgres connection string for the brain DB. Format: `postgresql://ai_agent:<pwd>@<host>:5432/<db_name>`
- `statement_timeout_ms` (default `5000`)
- `max_rows` (default `500`)

Bootstrap the brain DB (one time per project) per the section below before claiming any task.

### Local dev (inside this repo)

```bash
# Point Claude Code at the local plugin folder
claude --plugin-dir ./
# After editing the plugin during a session
/reload-plugins
```

### Updating after a marketplace bump

```bash
claude plugin marketplace update let-me-do
claude plugin install lmd@let-me-do --scope project --upgrade
```

> The plugin folder ships as `let-me-do` but the registered name is `lmd` (shorter namespace — slash invocations look like `/lmd:create-task`, `/lmd:autopilot`).

## Typical day

The plugin is built for a conversational, low-ceremony workflow. No need to memorize slash commands.

```
You:    "What tasks are left for me today?"
Claude: [auto-invokes list-tasks]
        Open tasks (3):
          [1] 20260523-001-[lms-auth]-add-settings-page   active · step=qa     mine
          [2] 20260524-003-[lms-backend]-fix-payment-redirect pending              unassigned
          [3] 20260522-007-[Docs]-update-readme          claimed              mine

You:    "Start the first one."
Claude: [auto-invokes claim-task with task #1]
        Claimed 20260523-001-[lms-auth]-add-settings-page. Handing off to autopilot…
        [autopilot runs scouter → code-planner ⇄ plan-reviewer → developer ⇄ tester → reviewer ⇄ developer → committer]
```

Task id format: `<YYYYMMDD>-<NNN>-[<scope>]-<slug>`
- `<scope>` examples (single): `lms` (whole app), `lms-backend` (one layer), `lms-auth` (one module in a single-app repo), `docs`, `infra`.
- `<scope>` for **multi-scope tasks** (real-world: one task touches several areas): join with ` + ` (spaces around the plus), vd `[lms + exam-frontend]`, `[lms-backend + crm-backend]`, `[lms-auth + backend-auth]`.
- `<scope>` is canonical in the `summary` field's `Scope:` line — the brackets in the id are a visual aid for humans scanning lists.
- For multi-scope tasks, agents read the nested `CLAUDE.md` files inside **every constituent's folder** at Step 0; conflicting rules are surfaced to the user.

For richer intent, explicit slash skills are always available:

```
/lmd:create-task "..."          — file a new task
/lmd:list-tasks                  — list mine + open pool
/lmd:status <id>                 — task detail
/lmd:claim-task <id|index>       — claim & start autopilot
/lmd:unclaim-task <id>           — release back to pool
/lmd:autopilot <id>              — resume a claimed/active task (also kicked off by claim-task)
/lmd:qa | /lmd:review | /lmd:commit   — ad-hoc tester / reviewer / committer wrappers (outside the autopilot pipeline)
/lmd:explore <seed-url>          — Playwright UI walk
/lmd:scan-context                — preview context files agents will load
/lmd:init-brain                  — one-time bootstrap
```

> Task dependencies are intentionally not modeled. If task A must precede task B, claim and finish A first — the workflow stays simple.

## `.lmdignore`

Drop a `.lmdignore` file at the repo root (same syntax as `.gitignore`) to mark paths that the `reviewer` and `committer` agents must leave alone:

- `reviewer` never runs convention / smell / security / type checks against matched paths.
- `committer` never stages or commits matched paths. They stay in the working tree after the autopilot session — the user owns follow-up.

Other agents (`scouter`, `code-planner`, `plan-reviewer`, `developer`, `tester`) are unaffected — they can still read, plan, write, and test those files. `.lmdignore` controls only the **review/commit boundary**.

Example:

```gitignore
# Vendored / generated — keep out of reviewer + committer
**/generated/**
*.bundle.js
dist/
prisma/migrations/**

# Large fixtures we update by hand
test/fixtures/large-data/

# Re-include one specific file from an excluded folder
!dist/runtime-config.json
```

Patterns evaluate in declaration order; the last matching pattern wins (gitignore precedence). When `.lmdignore` is absent, no filtering applies.

## Runtime UI verification (`tester` agent)

The `tester` agent classifies each acceptance criterion as **static** (verifiable by reading code + walking brain) or **runtime** (requires the live UI). Runtime criteria are verified with Playwright against a dev server.

For runtime verification to work, two prerequisites must exist:

1. **Playwright installed** in the project:
   ```bash
   npm i -D @playwright/test
   npx playwright install
   ```
2. **A dev server reachable** when autopilot runs. Tester does NOT boot the server itself — start it manually before claiming a runtime-heavy task.

Two optional CLAUDE.md sections tell tester where to look:

```markdown
## Test Server

Dev server: http://localhost:5173
Start command: npm run dev

## Test Auth

Login URL: http://localhost:5173/login
Test users:
  - default: test@example.com / testpass
  - admin: admin@example.com / adminpass
Throwaway destroyable user (for delete-account tests):
  - throwaway-pool: see scripts/seed-throwaway.ts
```

If neither section exists, tester probes `localhost:5173`, `localhost:3000`, `localhost:8080` and requires no auth — fine for public-only flows. Criteria that need login but find no `## Test Auth` fail with a clear instruction.

Tester writes a Playwright spec on the fly at `.lmd/autopilot/tester/<id>-<iter>-runtime.spec.js`, runs it headless, and stores failure screenshots flat at `.lmd/autopilot/tester/<id>-<iter>-screen-<slug>.png`. All artifacts share the `<id>-*` prefix so Step 6 cleanup picks them up on `done`.

Hard limits per tester invocation: 30s/criterion timeout, 5 minute wall-clock total, headless chromium, destructive selectors skipped by default unless the criterion explicitly tests destruction.

## `.lmd/` directory

Artifacts produced during an autopilot session land in `<repo-root>/.lmd/autopilot/<agent>/`. By default they're auto-deleted by Step 6 of autopilot when a task reaches `done`. Files for `blocked` / `cancelled` runs stay on disk for postmortem.

Recommendation: add `.lmd/` to `.gitignore` so per-task artifacts never accidentally end up in commits. The plugin's commit pipeline never stages files under `.lmd/`, but a manual `git add` could.

## Set up the brain database (one-time per project)

You need a Postgres cluster and a superuser. Use a dedicated DB per project so they stay isolated (`brain_my_project`, `brain_team_b`, ...).

```bash
psql -U <superuser> -h <host> \
  -v db_name=brain_my_project \
  -v ai_pwd='<SET_PASSWORD>' \
  -f brain/sql/setup.sql
```

The script creates:

- Database `brain_my_project` (idempotent)
- Role `ai_agent` (login, not superuser, owns no DBs beyond its own tables)
- Tables `nodes`, `edges`, `tasks`, `task_events` with GIN + B-tree indexes
- Function `find_paths(src, tgt, max_depth)` for path traversal
- Full GRANTs for `ai_agent` **only in this DB**

Verify isolation:

```sql
\c <some_other_team_db> ai_agent
SELECT * FROM <some_other_team_table>;  -- ERROR: permission denied
\c brain_my_project ai_agent
SELECT count(*) FROM nodes;             -- OK
```

## Brain MCP tools

| Tool | Purpose | Guards |
|---|---|---|
| `mcp__brain__query` | Read-only `SELECT` / `WITH … SELECT` | Must start with `SELECT`/`WITH`; rejects DDL and write keywords; single statement; row cap |
| `mcp__brain__execute` | Raw `INSERT` / `UPDATE` / `DELETE` / writable `WITH` (escape hatch) | Must start with one of those; rejects DDL; single statement. Prefer the typed tools below. |
| `mcp__brain__upsert_node` | Idempotent node upsert | Parameterized; required: id, app, label |
| `mcp__brain__upsert_edge` | Idempotent edge upsert | Parameterized; required: id, source, target, action, steps |
| `mcp__brain__delete_node` / `delete_edge` | Remove graph records | `delete_node` cascades to dependent edges by default |
| `mcp__brain__create_task` | Insert task; auto-generates id `YYYYMMDD-NNN-[scope]-slug` | Parameterized; `scope` required when id is auto |
| `mcp__brain__claim_task` | Race-safe claim | Sets `claimed_by`, `claimed_at`, status; appends a `claim` (or `transfer`) row to `task_events`; `force` to transfer |
| `mcp__brain__unclaim_task` | Release task back to pool | Only current claimer (or `force`); appends an `unclaim` row to `task_events` |
| `mcp__brain__update_task_step` | Autopilot step transitions (scout / plan / plan-review / dev / test / review / commit / done) | Appends a `step` row to `task_events`; `signature` + `iter` persisted so stuck-loop windows survive resume; bumps `tasks.iteration` only on the dev step's **completion** call (so a crash between entry and completion does not skip an iter) |
| `mcp__brain__complete_task` | Mark task done | Sets `completed_at`, appends a `complete` row to `task_events` |
| `mcp__brain__cancel_task` | Mark task cancelled (user interrupt) | Sets `status='cancelled'`, appends a `cancel` row to `task_events`; no-op if task is already `done`/`cancelled` |
| `mcp__brain__find_paths` | Path traversal A → B (1..max_depth hops) | Parameterized, calls the `find_paths` SQL function |
| `mcp__brain__get_settings` | Returns runtime settings (timeouts, row cap) | None — purely informational |

### Statement blacklist (all tools)

`DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, `REVOKE`, `VACUUM`, `REINDEX`, `CLUSTER`, `COPY`, `SECURITY`, `SET ROLE`, `RESET ROLE`, `LISTEN`, `NOTIFY`, `LOAD`, `DO`, `CALL`.

## Brain schema

### `nodes` — screens / overlays

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT PK | `<appId>:<slug>`, e.g. `web:dashboard` |
| `app` | TEXT | Frontend app name |
| `type` | TEXT | `page` / `modal` / `drawer` / `sheet` |
| `url` | TEXT | Route path |
| `mounted_on` | TEXT FK | Parent page (for overlays) |
| `label` | TEXT | Human-readable label |
| `grp` | TEXT | Functional group |
| `description` | TEXT | What the screen is for |
| `actions` | JSONB | Actions the user can take (agents search by intent) |
| `access` | JSONB | `{auth, roles, note}` |
| `preconditions` | JSONB | Data that must exist before reaching this screen |
| `assertions` | JSONB | What QA should verify on this screen |
| `note` | TEXT | Edge cases |

### `edges` — navigation steps

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT PK | `<source>→<target>` |
| `source` | TEXT | Source node |
| `target` | TEXT | Target node |
| `action` | TEXT | `click` / `submit` / `redirect` / `back` / `deeplink` / `close` |
| `label` | TEXT | React Flow edge label |
| `steps` | TEXT | QA steps |
| `condition` | TEXT | Predicate under which the edge fires |
| `note` | TEXT | Notes |

### `task_events` — append-only audit log for tasks

Every task mutation that's worth replaying lands here. Autopilot resume reads from this table; `tasks` row updates never carry per-event payloads, so long-running tasks stay cheap to update.

| Column | Type | Meaning |
|---|---|---|
| `id` | BIGSERIAL PK | Auto-incrementing event id |
| `task_id` | TEXT FK | References `tasks(id)`; cascades on delete |
| `kind` | TEXT | `step` / `claim` / `unclaim` / `transfer` / `complete` / `cancel` |
| `step` | TEXT | Workflow step (when `kind='step'`): `scout` / `plan` / `plan-review` / `dev` / `test` / `review` / `commit` / `done` |
| `iter` | INT | `plan_iter` or `dev_iter` (when `kind='step'`) |
| `agent` | TEXT | Which agent caused the transition |
| `outcome` | TEXT | `NULL` on entry; verdict on completion (e.g. `complete` / `pass` / `fail` / `approve` / `request-changes` / `blocked`) |
| `signature` | TEXT | 16-hex short signature (only on step-completion events) |
| `report_ref` | TEXT | Artifact path under `.lmd/autopilot/<agent>/` |
| `actor` | TEXT | `git user.email` (when `kind` in `claim`/`unclaim`/`transfer`) |
| `reason` | TEXT | Free-text (mainly for `unclaim`/`cancel`) |
| `payload` | JSONB | Catch-all for kind-specific extras |
| `created_at` | TIMESTAMPTZ | Insert time (NOT NULL DEFAULT now()) |

## Defense-in-depth (3 layers)

| Layer | Mechanism | What it protects against |
|---|---|---|
| MCP server | Regex statement-type whitelist, single-statement, row cap, query timeout | DDL injection, runaway queries, multi-statement attacks |
| DB role `ai_agent` | GRANT-only on one DB; zero privileges on every other DB in the cluster | Lateral movement |
| Typed tool design | Every write tool is parameterized, idempotent, and race-safe at the server level. Raw `execute` is opt-in only. | Bad SQL composed by an agent; race conditions on `claim_task`; non-idempotent upserts |

**Worst case** (all three layers fail): corrupted graph data for one project. Recovery = re-seed from fixtures / backup. No PII, financial, or production app data lives in brain.

## Developing

Adding a new agent:

1. Drop a new file under `agents/<new-agent>.md` with proper frontmatter (`name`, `description`, `tools`, `model`).
2. If the agent needs to write to brain → use a typed tool (`upsert_node`, `upsert_edge`, `create_task`, …). Avoid raw `mcp__brain__execute` unless the case isn't covered by a typed tool.
3. Run `/reload-plugins` in your Claude Code session so the new agent is picked up.
4. Bump `version` in `.claude-plugin/plugin.json` when releasing.

## Known limitations

- Claude Code has no native "only subagent X may call MCP tool Y" mechanism. We rely on convention + the per-call user prompt for `execute`.
- `pg_database` still lists every DB in the cluster (Postgres limitation). Harmless — `ai_agent` cannot read any of them.
- Node ≥ 20 required because the bundled MCP server uses ES modules.
