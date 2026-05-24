---
name: scan-context
description: Preview the project rule files (CLAUDE.md tree, .claude/rules/, nested CLAUDE.md inside <scope> folder) that every lmd agent will load at Step 0. Use for verification / debugging / token-budget estimation before running heavy workflows.
allowed-tools: Read, Glob, Grep, Bash, mcp__brain__query, mcp__brain__get_settings
user-invocable: true
---

# scan-context

Lists and previews every rule / context file an lmd agent will read at its Step 0. Read-only; re-scans live (no cache).

Use it to: verify all expected rule files are in place; estimate token cost per spawn; spot missing / stale rules; audit which CLAUDE.md sections affect a given scope.

Specialist agents under `.claude/agents/*` are out of scope (this skill lists context only).

## Workflow

1. Parse args:
   - `--scope <app>` — filter to one app (e.g. `web`). Default: all scopes detected in repo.
   - `--detail` — print first ~30 lines of each file (default: just paths + sizes).
2. Resolve scope(s): if `--scope` is ` + `-joined multi (e.g. `lms + crm`), split and treat each separately. Per scope, find the app folder via `package.json` / monorepo workspace patterns, or query brain for `nodes.app` values matching the label.
3. Enumerate files in agent Step 0 load order:
   - `<root>/CLAUDE.md`
   - `<root>/.claude/rules/*.md`
   - Nested `**/CLAUDE.md` inside each scope's folder.
4. Print tree with paths, sizes, and rough token estimates (`char_count / 4` heuristic):

```
context files for scope=web (estimated total: ~3.4k tokens)

  ✓ CLAUDE.md                                          2,140 tokens
  ⚠ .claude/rules/                                     (folder empty)
  ✓ apps/web/CLAUDE.md                                   850 tokens
  ✓ apps/web/src/auth/CLAUDE.md                          420 tokens
```

5. `--detail`: also print first ~30 lines of each file.
6. Warn when a scope has no nested `CLAUDE.md` — agents will only see root rules.

## Args

```
/lmd:scan-context                              # all scopes, summary
/lmd:scan-context --scope web
/lmd:scan-context --scope 'lms + crm'          # quote for spaces
/lmd:scan-context --scope lms-backend --detail # with file previews
```

## Output

- Tree per scope with sizes + token estimates.
- Total estimated context overhead per spawn.
- Missing required files.
- Suggested actions (e.g. "no nested CLAUDE.md in apps/web/ — consider adding").
