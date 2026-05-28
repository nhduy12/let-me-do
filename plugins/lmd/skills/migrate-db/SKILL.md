---
name: migrate-db
description: Apply the plugin's current brain schema to your existing brain DB. Idempotent — adds new tables / indexes / function definitions shipped in a plugin update without touching existing rows. Run this after `claude plugin install lmd@let-me-do --upgrade` introduces a schema change, or whenever `/lmd:check-system` flags brain schema mismatch.
allowed-tools: Bash, Read, Glob, mcp__brain__get_settings
user-invocable: true
---

# migrate-db

Thin Claude Code wrapper around `brain/server/setup-db.mjs --schema-only`. Lets you migrate the brain schema without dropping to a terminal.

## When to run

- A plugin release added new tables / indexes / function to the brain schema.
- `/lmd:check-system` reports `Brain schema present (3/4)` or similar.
- You initially added brain tables via the schema-only path and want to re-sync to the plugin's current shape.

## When NOT to run

- First-time brain setup with a fresh DB + new `ai_agent` role — that's the bootstrap path, run `node <plugin>/brain/server/setup-db.mjs` from a terminal so it can prompt for superuser creds. This skill never does CREATE DATABASE / CREATE ROLE.
- After a breaking schema change (column rename / drop / type change) — the plugin's release notes will document the manual migration command for that version; this skill only handles additive changes.

## Args

```
/lmd:migrate-db                                    # interactive — asks for the URI
/lmd:migrate-db --uri "postgresql://..."           # explicit target URI
/lmd:migrate-db --uri "..." --role <name>          # override owner role
                                                   # (default: connecting user)
/lmd:migrate-db --uri "..." --dry-run              # preview only — print the command, don't execute
```

## Workflow

### 1. Resolve target URI

Parse `$ARGUMENTS` for `--uri <value>`. If absent:

- Try `mcp__brain__get_settings` first — if it succeeds, brain MCP is already configured against a URI. Ask the user "use the URI currently configured for brain MCP? (y/n)". On yes, reuse it (the user will paste it back — Claude Code does NOT expose user_config values to skill env, see "Limitation" below).
- Otherwise, prompt the user: `"Paste the connection string of the brain DB to migrate (postgresql://...): "`.

Validate the URI starts with `postgres://` or `postgresql://`. Refuse anything else.

### 2. Locate `setup-db.mjs`

```bash
# Preferred — env var set by Claude Code when running plugin scripts
test -n "$CLAUDE_PLUGIN_ROOT" && SCRIPT="$CLAUDE_PLUGIN_ROOT/brain/server/setup-db.mjs"
```

If `$CLAUDE_PLUGIN_ROOT` is unset (some Claude Code versions / contexts), fall back to the `Glob` tool with pattern `**/plugins/lmd/brain/server/setup-db.mjs` — there should be exactly one match.

### 3. Sanity check

```bash
test -f "$SCRIPT" || exit "setup-db.mjs not found at $SCRIPT"
node --version | grep -qE 'v(2[0-9]|[3-9][0-9])' || exit "Node >= 20 required"
```

### 4. Run the migration

Echo a masked form of the URI first so the user sees what's about to happen without their password appearing in the chat:

```
masked = uri.replace(/:[^:@/]+@/, ':***@')
echo "→ migrating $masked"
```

Then:

```bash
node "$SCRIPT" --schema-only --auto \
  --target-uri "$URI" \
  [--role "$ROLE"]
```

`--dry-run`: stop after the echo. Don't actually invoke the script.

### 5. Report

- **Success** (exit 0): relay setup-db.mjs's last 3 lines (the "applied schema..." + "done" lines). Suggest `/lmd:check-system` to verify.
- **Failure** (non-zero exit): surface the script's stderr verbatim. Common causes:
  - `permission denied for schema public` — connecting role lacks `CREATE` privilege; ask the user to GRANT, or rerun bootstrapped with a superuser.
  - `role "X" does not exist` — `--role` set to a name that isn't a real Postgres role.
  - `connection refused` / `password authentication failed` — URI wrong.
  - `must be owner of table tasks` — table was created by a different role; either set `--role` to that role, or run as superuser.

## Limitation

Claude Code does not expose plugin `user_config` values (including `database_uri`) to skill / agent shell environments — they live only in the MCP server's env. The skill therefore cannot auto-read your configured `database_uri`; the user has to provide it once per invocation. The MCP server itself stays decoupled — it doesn't restart when this skill runs, so any schema change takes effect on the next brain MCP call.

## Forbidden actions

- Run the bootstrap path (CREATE DATABASE / CREATE ROLE). Refer the user to the README "Path A" terminal flow.
- Persist the URI anywhere (no logs, no temp file). It stays in the Bash command line for that one call only.
- Run the script without `--auto` — would hang on readline prompts because Bash tool can't proxy stdin to the child.
- Edit setup-db.mjs or any SQL file.
