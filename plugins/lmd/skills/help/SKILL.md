---
name: help
description: Guide to the lmd (let-me-do) plugin — what it is, how the brain + agents + autopilot fit together, first-time setup, the full slash-command reference, the autopilot pipeline, runtime QA setup, and troubleshooting. Use when the user asks how to use let-me-do / lmd, what a command or agent does, how to get started, how autopilot works, why a task is blocked, or "help" with anything lmd-related. Accepts an optional topic arg (setup | tasks | autopilot | qa | brain | commands | troubleshoot) to focus the answer.
allowed-tools: Read, Bash, Glob
user-invocable: true
---

# help

Explain the **lmd (let-me-do)** plugin to the user and get them productive fast. This skill is documentation-driven: answer from the structured guide below, and pull deeper detail from the full plugin README when a topic needs it.

## How to respond

1. Read the optional topic arg. Map it to a section:
   - `setup` → **First-time setup**
   - `tasks` → **The conversational workflow** + task-id format
   - `autopilot` → **The autopilot pipeline**
   - `qa` → **Runtime QA**
   - `brain` → **Brain**
   - `commands` → **Slash-command reference**
   - `troubleshoot` → **Troubleshooting**
   - no arg (or a free-form question) → give the **Overview** first, then the one or two sections that fit the question.
2. For anything beyond what's captured here, read the full README at `${CLAUDE_PLUGIN_ROOT}/README.md` and answer from it — don't guess. If `${CLAUDE_PLUGIN_ROOT}` isn't set, `Glob` for `**/plugins/lmd/README.md` or `**/cache/**/lmd/**/README.md`.
3. Keep it conversational and short. Show the exact command the user should run next; don't dump the whole reference unless they asked for `commands`.
4. Never invent flags, tools, or agents. The reference below and the README are the source of truth.

## Overview — what lmd is

lmd hands a single coding task to a pipeline of specialist agents that carry it **from intake to commit** with minimal micro-management. Three pieces:

- **brain** — a Postgres graph + task store, shared across sessions. It holds tasks, a screen-flow graph (nodes = screens, edges = navigation), and an append-only task-event log. Agents read/write it through **typed MCP tools** (`create_task`, `claim_task`, `upsert_node`, …), so writes are idempotent and race-safe. It is the single source of truth — context survives across sessions because it lives here, not in chat.
- **agents** — seven narrow specialists: `scouter` (read-only recon) → `code-planner` → `plan-reviewer` → `developer` → `tester` → `reviewer` → `committer`.
- **autopilot** — the orchestrator that drives a claimed task through those agents, with bounded retry loops. Agent-to-agent context flows through files under `.lmd/autopilot/`; the main session only carries short status payloads.

You mostly talk to it in plain language ("what's on my plate?", "start the first one") — the slash commands are there when you want to be explicit.

## First-time setup

Do these once per project, in order. `/lmd:check-system` verifies all of it and prints the exact fix for anything missing — run it first and after each step.

1. **Prerequisites**: Node ≥ 20 + npm on PATH; Postgres ≥ 13 reachable; `git init` done with `git config user.email` set (brain uses the email as the task owner — claim refuses without it); a `<repo-root>/CLAUDE.md` describing project conventions (every agent reads it — keep it under ~5k tokens, it's loaded ~7× per task).
2. **Bootstrap the brain DB** (one-time): from `<plugin-root>/brain/server`, run `node setup-db.mjs` (interactive — creates the DB, the `ai_agent` role, tables, indexes, and prints the connection string). Use a dedicated DB per project. Paths B (schema-only) and C (legacy psql) exist for existing DBs — see the README.
3. **Set the plugin config**: after install, Claude Code prompts for `database_uri` (the string setup-db printed), `statement_timeout_ms` (default 5000), `max_rows` (default 500).
4. **Seed the graph** (optional but recommended for UI-heavy repos): `/lmd:init-brain` scans routes + page components and seeds low-confidence nodes/edges.
5. **Runtime QA** (optional — only if tasks need live-UI verification): install Playwright in the project and create `<repo-root>/.lmd/test-env.md`. See **Runtime QA** below.
6. **Recommended hygiene**: add `.lmd/` to `.gitignore` (per-task artifacts); optionally a `.lmdignore` to keep generated/vendored paths out of the reviewer + committer.
7. **Verify**: `/lmd:check-system` should end with `RESULT: PASS`.

## The conversational workflow (typical day)

```
You:    "What tasks are left for me today?"     → list-tasks
You:    "Start the first one."                  → claim-task #1 → autopilot runs the whole pipeline
```

- **Task id format**: `<YYYYMMDD>-<NNN>-[<scope>]-<slug>`. Scope is a free label: `lms`, `lms-backend`, `docs`, `infra`; multi-scope tasks join with ` + ` (e.g. `[lms-backend + crm-backend]`). Only the `developer` reads nested `CLAUDE.md` for every constituent scope; other agents read root only.
- Task **dependencies aren't modeled** by design — if A must precede B, finish A first.
- Natural-language pickup works: "start the second one" / "status 3" map onto the last `list-tasks` output.

## Slash-command reference

```
/lmd:help [topic]            — this guide (topic: setup|tasks|autopilot|qa|brain|commands|troubleshoot)
/lmd:check-system            — diagnose setup (git, brain DB, optional QA prereqs); run this first
/lmd:init-brain              — one-time graph bootstrap (scan routes → seed nodes/edges)
/lmd:migrate-db              — apply additive brain schema migrations after a plugin upgrade

/lmd:create-task "..."       — file a new task (probes scope + acceptance criteria, never the "how")
/lmd:list-tasks              — list mine + open pool (not done); --unassigned|--mine|--all|--search|--status|--priority
/lmd:status <id>             — one task's detail: step, iteration, event timeline, blockers
/lmd:claim-task <id|index>   — claim a task and auto-start autopilot
/lmd:unclaim-task <id>       — release a task back to the pool
/lmd:autopilot <id>          — resume a claimed/active task (also kicked off by claim-task)

/lmd:qa      [id]            — ad-hoc tester on the current diff / a task (outside the pipeline)
/lmd:review                 — ad-hoc reviewer on the current diff
/lmd:commit  [id]           — ad-hoc commit from task + diff (no push, no PR)
/lmd:explore <seed-url>     — Playwright UI walk; upserts discovered nodes/edges into brain
```

## The autopilot pipeline

A claimed task flows: **check-system (blocking tier) → claim → scouter → code-planner ⇄ plan-reviewer → developer ⇄ tester → reviewer ⇄ developer → committer → done**. Solid steps advance on a verdict; `⇄` are bounded retry loops.

- **Default caps (v0.2.0)**: plan = 2, dev = 3, review = 2, committer = 1, file-not-found recovery = 3 per missing file. Override with `--plan-cap` / `--dev-cap` / `--review-cap` / `--no-cap`.
- `dev_cap` is scoped to the whole task, not reset when the reviewer requests changes — a review⇄dev ping-pong can't run dev unbounded.
- **`--no-test`** drops the tester (developer → reviewer directly). Behavior is then unverified — use only for throwaway spikes / pure-docs edits. Per-invocation flag; re-pass on resume.
- **Stuck-loop bail**: each sub-agent returns a 16-hex signature; autopilot keeps the last 3 per loop and bails `stuck_<loop>_loop` when all three match (independent of the cap counter).
- **Terminal blocked states**: `scout_blocked`, `plan_unresolved`, `test_unresolved`, `review_unresolved`, `commit_failed`. Artifacts for blocked/cancelled runs stay under `.lmd/autopilot/<agent>/` for postmortem; `done` runs are cleaned up (Step 6) unless `--keep-artifacts`.
- **Resume is free**: every transition writes a `task_events` row; `/lmd:autopilot <id>` rehydrates all state from that log.
- **Token budget**: happy path ~40–60k tokens; defaults keep worst-case under ~150k.

## Runtime QA

The `tester` classifies each acceptance criterion as **static** (code + brain) or **runtime** (live UI). Runtime needs three things, or those criteria fail with a clear "create test-env.md / install Playwright" message (static tasks still complete):

1. Playwright in the project: `npm i -D @playwright/test && npx playwright install` (tester never installs it — won't touch your lockfile).
2. A dev server already running — tester does NOT boot it.
3. `<repo-root>/.lmd/test-env.md` with the dev server URL(s) + test users. Template at `${CLAUDE_PLUGIN_ROOT}/templates/test-env.md.example`.

**SSO / external IdP** apps can't use inline email/password — use `Method: storageState` with a saved Playwright session (`npx playwright codegen --save-storage=.lmd/auth/default.json <url>`). State files hold live tokens: keep them under `.lmd/auth/` and never commit them.

## Brain

What it stores: `nodes` (screens/overlays), `edges` (navigation steps), `tasks`, `task_events` (append-only audit). Agents write via typed tools — `query` (read-only SELECT/WITH, row-capped), `execute` (raw write escape hatch, parameterized), `upsert_node` / `upsert_edge`, `create_task` / `claim_task` / `unclaim_task` / `update_task_step` / `complete_task` / `cancel_task`, `find_paths`, `get_settings`. A statement blacklist (DROP/ALTER/CREATE/GRANT/…) plus a single-DB `ai_agent` role plus per-tool parameterization form three defense layers — worst case is corrupted graph data for one project (no PII/production data lives in brain). After a plugin upgrade that adds schema, run `/lmd:migrate-db` (idempotent, additive).

## Troubleshooting

- **`claim_task` refuses** → `git config user.email` is unset. Set it.
- **Brain unreachable / schema mismatch** → run `/lmd:check-system`; it points at the exact fix. Schema drift after an upgrade → `/lmd:migrate-db`.
- **Every runtime criterion fails** → missing Playwright or `.lmd/test-env.md`, or the dev server isn't running. Static tasks are unaffected.
- **`storageState expired`** → re-capture the SSO session file; this is a prerequisite failure, not a code bug, so it won't loop the developer.
- **Task blocked** → `/lmd:status <id>` shows the terminal reason + the artifact path under `.lmd/autopilot/` to read for the postmortem. Bump the relevant cap and re-run `/lmd:autopilot <id>`, or fix the underlying issue.
- **A command / agent isn't what I described** → read `${CLAUDE_PLUGIN_ROOT}/README.md` (authoritative) and correct course; never fabricate behavior.

## Deeper reference

Full docs: `${CLAUDE_PLUGIN_ROOT}/README.md`. It covers brain DB setup paths A/B/C, the `.lmdignore` semantics, the full brain schema and MCP tool guards, the defense-in-depth model, and known limitations.
