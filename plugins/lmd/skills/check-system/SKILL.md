---
name: check-system
description: Pre-flight diagnostic for the lmd toolchain. Verifies git, brain DB reachability + schema, and optional QA prerequisites (Playwright, .lmd/test-env.md). Reports pass / fail per check with copy-paste fix instructions. Run this before claiming a task for the first time on a project, or whenever autopilot is failing in setup-related ways. Autopilot itself invokes this skill with `--check-only` at the start of every fresh run and bails early on blocking failures.
allowed-tools: Bash, PowerShell, Read, Glob, Grep, mcp__brain__query, mcp__brain__get_settings
user-invocable: true
---

# check-system

Layered diagnostic of everything autopilot, tester, and explore depend on.

| Tier | Meaning | Autopilot effect |
|---|---|---|
| **Blocking** | autopilot cannot run | preflight bails |
| **Recommended** | works but degraded | autopilot proceeds; surfaces in final report |
| **Optional** | needed only for runtime QA / `/lmd:explore` | autopilot proceeds; feature degrades |

## Args

```
/lmd:check-system                    # full report
/lmd:check-system --check-only       # minimal output + RESULT line (autopilot uses this)
/lmd:check-system --tier blocking    # blocking tier only (fastest)
```

## Output contract

The **last line** is always one of:

```
RESULT: PASS (blocking=4/4, recommended=2/2, optional=2/2)
RESULT: FAIL (blocking=3/4 — git user.email not set)
```

Callers parse only this line. The rest is human-readable.

## Checks

Per check: record `pass`/`fail`, one-line note, one-line fix on failure.

### Tier 1 — Blocking

**1. Git repo** — `git rev-parse --is-inside-work-tree` exits 0 with `true`.
Fix: cd into a git repo, or `git init` here.

**2. Git user.email** — `git config user.email` returns non-empty.
Fix: `git config user.email "you@example.com"` — used as `created_by` / `claimed_by`.

**3. Brain MCP reachable** — `mcp__brain__get_settings` returns a payload.
Fix: brain MCP failed to start. Causes (in likelihood order):
- **Brain server deps not installed yet** — the launcher (`brain/server/start.mjs`) auto-runs `npm install` on first start. If that failed (no network / `npm` not on PATH), check Claude Code logs and run `npm install --omit=dev` inside `<plugin-root>/brain/server/` manually, then `/reload-plugins`.
- Plugin not installed → `claude plugin install lmd@let-me-do --scope project`.
- `database_uri` user_config missing / wrong format. Expected `postgresql://ai_agent:<pwd>@<host>:5432/<db>`. Reinstall or edit `.claude/settings.local.json`.
- Postgres unreachable — verify the DB is running and `ai_agent` can connect.
- Node.js < 20 — server requires ES modules + top-level await.
After fixing, restart the session (or `/reload-plugins`) and re-run check-system.

**4. Brain schema** — `mcp__brain__query`:
```sql
SELECT count(*) AS n FROM information_schema.tables
WHERE table_schema='public' AND table_name IN ('tasks','task_events','nodes','edges');
```
Pass when `n == 4`. Fix: schema not initialized. Run `node <plugin-root>/brain/server/setup-db.mjs` (recommended, one-command Node runner) or `psql ... -f <plugin-root>/brain/sql/setup.sql` (legacy). See plugin README "Set up the brain database".

### Tier 2 — Recommended

**5. `<repo-root>/CLAUDE.md`** — `Glob` matches. Fix: create CLAUDE.md with project tech stack + conventions + forbidden patterns. Agents read it on every invocation; without it they work blind.

**6. `.gitignore` covers `.lmd/`** — read `.gitignore`, any line is `.lmd/` or `/.lmd/`. Fix: `echo '.lmd/' >> .gitignore`. To keep `.lmd/test-env.md` committable, also add `!.lmd/test-env.md` on the next line.

### Tier 3 — Optional

**7. Playwright** _(runtime QA + `/lmd:explore`)_ — `npx --no-install playwright --version` exits 0.
- Bash: `npx --no-install playwright --version >/dev/null 2>&1`
- PowerShell: `try { & npx --no-install playwright --version 2>$null | Out-Null; $LASTEXITCODE -eq 0 } catch { $false }`

Fix: `npm i -D @playwright/test && npx playwright install`. Skip if not using runtime QA — tester falls back to static-only.

**8. `<repo-root>/.lmd/test-env.md`** _(runtime QA + `/lmd:explore`)_ — `Read` succeeds.
Fix: run `/lmd:init --test-env-only` to scaffold a pre-filled draft from the codebase (confirm its `# TODO` fields), or manually `mkdir -p .lmd && cp <plugin-root>/templates/test-env.md.example .lmd/test-env.md` then edit. See `agents/tester.md` → "Test-env file".

## Render the report

```
Blocking
  ✓ 1. Git repository                       (D:/path/to/project)
  ✓ 2. Git user.email                       (you@example.com)
  ✓ 3. Brain MCP reachable                  (timeout=5000ms, max_rows=500)
  ✓ 4. Brain schema present                 (4/4 tables)

Recommended
  ✓ 5. CLAUDE.md at repo root
  ✗ 6. .gitignore has .lmd/ rule            fix: echo '.lmd/' >> .gitignore

Optional
  ✗ 7. Playwright installed                 fix: npm i -D @playwright/test && npx playwright install
  ✗ 8. .lmd/test-env.md exists              fix: /lmd:init --test-env-only  (or cp <plugin-root>/templates/test-env.md.example .lmd/test-env.md)

RESULT: PASS (blocking=4/4, recommended=1/2, optional=0/2)
```

`--check-only`: suppress `✓` lines; print only failures + `RESULT`.
`--tier blocking`: run blocking only; `RESULT` counts only the blocking tier.

## How autopilot uses this

Autopilot's preflight invokes:

```
Skill({ skill: 'check-system', args: '--check-only --tier blocking' })
```

`RESULT: FAIL` → autopilot exits immediately with the same message; no claim, no directory creation. Recommended/optional failures never block autopilot — they show up in the final report when relevant (e.g. tester logs `## Runtime prerequisites: Playwright missing`).

## Forbidden actions

- Write any file (skill is diagnostic only).
- Auto-fix anything (gitignore policy, file ownership, creds are user decisions). Print the fix line and let the user run it.
- Call `mcp__brain__execute` (no writes needed).
- Run the `Start command` from `.lmd/test-env.md` — long-lived processes are out of scope.
