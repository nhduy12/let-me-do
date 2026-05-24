---
name: scan-context
description: Preview the project rule files (CLAUDE.md tree, .claude/rules/, nested CLAUDE.md inside <scope> folder) that every lmd agent will load at Step 0. Use for verification / debugging / token-budget estimation before running heavy workflows.
allowed-tools: Read, Glob, Grep, Bash, mcp__brain__query, mcp__brain__get_settings
user-invocable: true
---

# scan-context

User-facing utility. Lists and previews every rule / context file an lmd agent will read at its mandatory Step 0. Read-only — does not modify anything and re-scans live on each invocation (no cache).

## Why this exists

`let-me-do` agents (autopilot, developer, tester, reviewer, committer) always scan project context files at spawn time. This skill lets the user **see what those agents will see**, so they can:

- Verify all expected rule files are in place before running a workflow.
- Estimate token cost per spawn.
- Spot missing or stale rule files.
- Audit which CLAUDE.md sections affect a given scope.

The skill enumerates context files only — project specialist agents (`.claude/agents/*`) are out of scope.

## Workflow

1. **Parse args**:
   - `--scope <app>` — filter to one app (e.g. `web`). Default: all.
   - `--detail` — show full file contents (default: just paths + sizes).

2. **Resolve scope(s)**: if `--scope` is a ` + `-joined multi (vd `lms + crm`), split and treat each separately. For each, find the app folder by scanning `package.json` / monorepo workspace patterns, or querying brain for `nodes.app` values matching the scope label.

3. **Enumerate context files** in load order (matches agent Step 0):
   - `<root>/CLAUDE.md`
   - `<root>/.claude/rules/*.md`
   - All nested `**/CLAUDE.md` inside each scope's folder (vd `apps/<scope>/CLAUDE.md`, `apps/<scope>/**/CLAUDE.md`)

4. **Print a tree** with file paths, sizes, and rough token estimates (using a fast `char_count / 4` heuristic — good enough for budget previews):

```
context files for scope=web (estimated total: ~3.4k tokens)

  ✓ CLAUDE.md                                          2,140 tokens
  ⚠ .claude/rules/                                     (folder empty)
  ✓ apps/web/CLAUDE.md                                   850 tokens
  ✓ apps/web/src/auth/CLAUDE.md                          420 tokens
```

5. **If `--detail`**: also print first ~30 lines of each file.

6. **Health check**: warn when a scope has no nested `CLAUDE.md` in its folder — agents will work with only root rules, which may be insufficient.

## Args

```
/lmd:scan-context                       # all scopes, summary
/lmd:scan-context --scope web              # single scope
/lmd:scan-context --scope 'lms + crm'      # multi-scope: scan both (quote because of spaces)
/lmd:scan-context --scope lms-backend --detail  # with file previews
```

## Output

- Tree of context files with sizes + token estimates per scope.
- Total estimated context overhead per spawn.
- List of missing required files.
- Suggested actions (e.g., "no nested CLAUDE.md in apps/web/ — consider adding one with app-specific rules").
