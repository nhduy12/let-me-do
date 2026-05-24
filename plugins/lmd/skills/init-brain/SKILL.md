---
name: init-brain
description: Bootstrap the brain database from the current codebase. Scans routers, page components, and docs to seed initial nodes and edges (confidence=low). User-invoked via /let-me-do:init-brain.
allowed-tools: Read, Grep, Glob, Bash, mcp__brain__query, mcp__brain__get_settings, mcp__brain__upsert_node, mcp__brain__upsert_edge
user-invocable: true
---

# init-brain

One-shot setup: agent starts blind, this command gives the brain a skeleton graph extracted from the codebase. Run once per project after installing the plugin.

## What it does

1. **Detect frontend framework** — React / Next / Vue / etc. by scanning `package.json` + entry files.
2. **Resolve app boundary**: top-level folders under `apps/`, `packages/`, or `services/` are each one app. If none of those exist, treat the repo as single-app and use the repo folder name as `app`.
3. **Find router config** — `<Route path="...">`, file-system router (`pages/`, `app/`), nested layouts.
4. **Map page components** → propose `nodes`. Id is always `<app>:<slug>` even in single-app repos (future multi-app migration stays painless). Dynamic routes become a single node with the placeholder preserved — `crm:student-detail` for `/student/[id]`, with `url` stored as `/student/:id`.
5. **Scan navigation calls** in each page component:
   - `<Link to="…">`, `<NavLink>`
   - `navigate("…")`, `useNavigate()`, `useRouter().push(…)`
   - Form `action="…"` redirects
   - `<a href="…">` to internal routes
6. **Propose edges** with `source`=`'init'`, `confidence`=`'low'`, `action`=`'click'` (best guess).
7. **Upsert candidates** via `mcp__brain__upsert_node` and `mcp__brain__upsert_edge` for each proposal.
8. **Print summary** — N nodes, M edges proposed; flagged ambiguities.

Scan output goes only to the report and to `nodes` / `edges` — no separate metadata tracking. Later channels (`developer`, `tester`, `explore` skill) upgrade the `confidence=low` seeds as they verify them.

## Inputs

- (optional) `--app <name>` — scope to one frontend app inside a monorepo. Default: scan all apps detected.
- (optional) `--dry-run` — print proposed changes, don't call any write tools.

## Outputs

- A report listing proposed nodes / edges grouped by app.
- Edges marked `confidence=low`.
