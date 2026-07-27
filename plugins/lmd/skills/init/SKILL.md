---
name: init
description: One-shot project bootstrap for lmd from the current codebase. Seeds the brain graph (nodes/edges, confidence=low) AND scaffolds a pre-filled `.lmd/test-env.md` for runtime QA (dev-server URLs, start commands, auth method, multi-app portal entry paths). The umbrella setup command — future init steps land here too. User-invoked via /lmd:init.
allowed-tools: Read, Write, Grep, Glob, Bash, mcp__brain__query, mcp__brain__get_settings, mcp__brain__upsert_node, mcp__brain__upsert_edge
user-invocable: true
---

# init

One-shot setup: agent starts blind, this command gives brain a skeleton graph extracted from the codebase **and** writes a pre-filled `.lmd/test-env.md` draft so runtime QA works with minimal hand-editing. Run once per project after installing the plugin. The same codebase scan feeds both outputs — no second pass.

This is the **umbrella init command** for lmd — as new one-time setup steps are added, gather them here (behind flags) rather than in separate `init-*` skills.

## What it does

1. **Detect frontend framework** — React / Next / Vue / etc. by scanning `package.json` + entry files.
2. **App boundary**: top-level folders under `apps/`, `packages/`, or `services/` are each one app. None of those → single-app, use repo folder name as `app`.
3. **Find router config** — `<Route path="...">`, file-system router (`pages/`, `app/`), nested layouts.
4. **Page components → nodes**. Id is always `<app>:<slug>` (single-app repos too — future multi-app migration stays painless). Dynamic routes become a single node with the placeholder preserved (`crm:student-detail` for `/student/[id]`, `url` = `/student/:id`).
5. **Navigation calls in each page**:
   - `<Link to="…">`, `<NavLink>`
   - `navigate("…")`, `useNavigate()`, `useRouter().push(…)`
   - Form `action="…"` redirects
   - `<a href="…">` to internal routes
6. **Propose edges** — `source='init'`, `confidence='low'`, `action='click'` (best guess).
7. **Upsert** via `mcp__brain__upsert_node` / `upsert_edge` per proposal.
8. **Print summary** — N nodes, M edges proposed; flagged ambiguities.

Scan output goes only to the report and to `nodes` / `edges`. Later channels (`developer`, `tester`, `/lmd:explore`) upgrade `confidence=low` seeds as they verify them.

## Also: scaffold `.lmd/test-env.md` (runtime QA)

Runs after the graph pass unless `--no-test-env`. **Reuses** the framework + app-boundary detection from steps 1–2 above — no second scan. Base shape comes from `${CLAUDE_PLUGIN_ROOT}/templates/test-env.md.example` (Read it, then fill).

**Never clobber a hand-tuned file.** Decide the destination first:

- `.lmd/test-env.md` already exists → do NOT touch it. Write the draft to `.lmd/test-env.generated.md` and tell the user to diff/merge.
- Absent → `mkdir -p .lmd` (Bash), then Write `.lmd/test-env.md`.

**Fill best-effort; mark every value you had to guess with a trailing `# TODO: …` comment** so the user sees exactly what to confirm:

1. **Servers** — one per detected app (single-app → one unnamed server). URL from, in order: Vite `server.port` / Next default / webpack `devServer.port`; a `--port` flag in the `package.json` `dev`/`start` script; `.env` `PORT=`; `docker-compose` published port. None found → `http://localhost:3000 # TODO: confirm port`.
2. **Start command** — the matching `package.json` script (`npm run dev`, or the workspace form `npm run dev --workspace=<app>` for monorepos).
3. **Auth method** — grep deps in `package.json` / lockfile:
   - `keycloak-js` · `keycloak-angular` · `@react-keycloak/*` · `oidc-client(-ts)` · `@azure/msal*` · `next-auth` · `@auth0/*` · `openid-client` · `passport-*` → external IdP ⇒ `Method: storageState` (emit the `npx playwright codegen --save-storage=… <url>` capture command as a comment; never a credential).
   - else a same-origin login route/form (`/login`, `input[type=password]`, `signIn(`) → `Method: password` with `# TODO: fill test creds`.
   - neither → omit the auth block and note "runtime auth not detected" in the summary.
4. **Multi-app portal (SSO handoff)** — if ≥2 app servers AND a portal/shell/launcher app OR cross-app URL env vars (`VITE_*_URL`, links to other origins) are detected, emit `Shared session: true` + `Applies to: all` and a `## Entry paths` stub per app. When the portal exposes an app list (a nav/menu config with label + url), pre-fill each `Steps:` (`click text="<label>"`) and `Landing:`; otherwise leave `# TODO: portal button label` + the app URL as landing.

**Forbidden in the draft**: real credentials, real tokens, and any `.lmd/auth/*.json` storage-state file — those are the user's to create (leave the codegen command + `# TODO`).

`--dry-run` prints the proposed file instead of writing it. `--test-env-only` skips the graph pass and writes just the test-env draft (fast path when brain is already seeded). `--no-test-env` does the inverse (graph only).

## Args

- `--app <name>` — scope to one frontend app in a monorepo. Default: scan all detected.
- `--dry-run` — print proposed changes (graph + test-env), don't write.
- `--no-test-env` — seed the graph only; skip the `.lmd/test-env.md` scaffold.
- `--test-env-only` — skip the graph pass; write only the `.lmd/test-env.md` draft.

## Outputs

- Report grouped by app: proposed nodes + edges. Edges marked `confidence=low`.
- `.lmd/test-env.md` (or `.lmd/test-env.generated.md` if one existed) + a summary listing each field as **filled** vs **TODO**, and the exact next steps (fill creds / run codegen / set portal button labels).
