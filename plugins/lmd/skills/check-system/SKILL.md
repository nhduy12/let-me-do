---
name: check-system
description: Pre-flight diagnostic for the lmd toolchain. Verifies git, brain DB reachability + schema, and optional QA prerequisites (Playwright, .lmd/test-env.md). Reports pass / fail per check with copy-paste fix instructions. Run this before claiming a task for the first time on a project, or whenever autopilot is failing in setup-related ways. Autopilot itself invokes this skill with `--check-only` at the start of every fresh run and bails early on blocking failures.
allowed-tools: Bash, PowerShell, Read, Glob, Grep, mcp__brain__query, mcp__brain__get_settings
user-invocable: true
---

# check-system

Layered diagnostic of everything autopilot and the tester / explore skills depend on.

## Tiers

| Tier | What it means | Effect on autopilot |
|---|---|---|
| **Blocking** | autopilot cannot run if any of these fail | preflight bails immediately |
| **Recommended** | works but degraded (e.g. no `CLAUDE.md` = agents have less context) | autopilot proceeds; surfaces in final report |
| **Optional** | only needed for specific features (runtime QA, `/lmd:explore`) | autopilot proceeds; relevant feature degrades |

## Args

```
/lmd:check-system                    # full report (default)
/lmd:check-system --check-only       # minimal output + machine-readable RESULT line; used by autopilot preflight
/lmd:check-system --tier blocking    # run only the blocking tier (fastest)
```

## Output contract

The **last line** of every invocation is one of:

```
RESULT: PASS (blocking=4/4, recommended=2/2, optional=2/2)
RESULT: FAIL (blocking=3/4 — git user.email not set)
```

Callers (autopilot, scripts) parse only this line. The rest of the output is human-readable and may evolve.

## Workflow

For every check below, record `status: pass | fail`, `note` (one-line context), and `fix` (one-line remediation when failed). At the end, print grouped by tier with `✓` / `✗` glyphs.

### Tier 1 — Blocking

**1. Git repository present**

Run `git rev-parse --is-inside-work-tree` via `Bash` or `PowerShell`. Pass when exit code is 0 and output is `true`.

- Fix: "cd into a git repo, or run `git init` here. lmd assumes a git working tree for committer + audit identity."

**2. Git user.email configured**

Run `git config user.email`. Pass when output is non-empty.

- Fix: ``git config user.email "you@example.com"`` — used as `created_by` / `claimed_by` on every task.

**3. Brain MCP server reachable**

Call `mcp__brain__get_settings` (no args). Pass when it returns a payload like `{statement_timeout_ms, max_rows}`.

- Fix: the brain MCP server failed to start. Common causes:
  - Plugin not installed: run `claude plugin install lmd@let-me-do --scope project`.
  - `database_uri` user_config missing or wrong format. Expected `postgresql://ai_agent:<pwd>@<host>:5432/<db_name>`. Reinstall to re-enter, or edit `.claude/settings.local.json`.
  - Postgres not reachable on that host/port. Verify the DB is running.
  After fixing, restart the Claude Code session (or `/reload-plugins`) and re-run `/lmd:check-system`.

**4. Brain schema present**

Call `mcp__brain__query` with:
```sql
SELECT count(*) AS n FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('tasks', 'task_events', 'nodes', 'edges');
```
Pass when `rows[0].n == 4`.

- Fix: brain DB exists but schema is not initialized. Run the setup SQL once per project DB:
  ```
  psql -U <superuser> -h <host> -v db_name=<your_db> -v ai_pwd='<pwd>' \
    -f <plugin-root>/brain/sql/setup.sql
  ```
  See `plugins/lmd/README.md` → "Set up the brain database".

### Tier 2 — Recommended

**5. `<repo-root>/CLAUDE.md` exists**

Use the `Glob` tool with pattern `CLAUDE.md` at repo root. Pass when at least one match.

- Fix: create a `CLAUDE.md` describing your project's tech stack, conventions, and forbidden patterns. Every agent reads it on every invocation; without it agents work blind.

**6. `.gitignore` has a rule for `.lmd/`**

Read `<repo-root>/.gitignore` (if present). Pass when any line matches `.lmd/` or `/.lmd/` (ignoring whitespace + leading `!` is not present without a re-include). If `.gitignore` is missing entirely, this fails.

- Fix: add `.lmd/` to `.gitignore` so per-task artifacts never accidentally end up in commits. To keep `.lmd/test-env.md` committable, also add `!.lmd/test-env.md` on the next line.

### Tier 3 — Optional

Each optional check announces what feature it gates so the user knows whether to care.

**7. Playwright installed** _(needed for tester runtime QA + `/lmd:explore`)_

Probe `npx playwright --version` without triggering install:

- Bash: `npx --no-install playwright --version >/dev/null 2>&1`
- PowerShell: `try { & npx --no-install playwright --version 2>$null | Out-Null; $LASTEXITCODE -eq 0 } catch { $false }`

Pass when the command succeeds.

- Fix: `npm i -D @playwright/test && npx playwright install`. Skip entirely if you don't intend to use runtime QA — tester will fall back to static-only verification.

**8. `<repo-root>/.lmd/test-env.md` exists** _(needed for tester runtime QA + `/lmd:explore`)_

`Read` the file. Pass on success; fail on `ENOENT`.

- Fix: `mkdir -p .lmd && cp <plugin-root>/templates/test-env.md.example .lmd/test-env.md`, then edit to put in your dev server URL(s) and test users. See `agents/tester.md` → "Test-env file" for the format.

### Print the report

Group lines by tier:

```
Blocking
  ✓ 1. Git repository present              (D:/path/to/project)
  ✓ 2. Git user.email                      (you@example.com)
  ✓ 3. Brain MCP reachable                 (timeout=5000ms, max_rows=500)
  ✓ 4. Brain schema present                (4/4 tables: tasks, task_events, nodes, edges)

Recommended
  ✓ 5. CLAUDE.md at repo root
  ✗ 6. .gitignore has .lmd/ rule           fix: echo '.lmd/' >> .gitignore

Optional
  ✗ 7. Playwright installed                fix: npm i -D @playwright/test && npx playwright install
  ✗ 8. .lmd/test-env.md exists             fix: mkdir -p .lmd && cp <plugin-root>/templates/test-env.md.example .lmd/test-env.md

RESULT: PASS (blocking=4/4, recommended=1/2, optional=0/2)
```

In `--check-only` mode, suppress all `✓` lines; print only failures + the `RESULT` line. In `--tier blocking` mode, skip the entire Tier 2 + Tier 3 section but still print one `RESULT` line counting only the blocking tier.

## How autopilot uses this

Autopilot's preflight (before claiming the task) invokes:

```
Skill({ skill: 'check-system', args: '--check-only --tier blocking' })
```

The returned text's last line is parsed. If it starts with `RESULT: FAIL`, autopilot exits immediately with the same message — does not claim the task, does not create `.lmd/autopilot/` directories. This makes setup errors fail fast instead of mid-pipeline.

Recommended / optional failures never block autopilot. They surface in the final report's `blockers` field as informational notes when relevant (e.g. tester logs `## Runtime prerequisites: Playwright missing` in its test report).

## Forbidden actions

- Don't write to any file (this skill is diagnostic only).
- Don't auto-fix anything — print the fix command and let the user run it. Auto-fix would have to make decisions about gitignore policy, file ownership, and creds; better to be explicit.
- Don't call `mcp__brain__execute` (no writes).
- Don't run the `Start command` from `.lmd/test-env.md` — long-lived processes are out of scope.
