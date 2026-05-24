# Shared context-scan procedure (Step 0)

Every workflow agent (`scouter`, `code-planner`, `plan-reviewer`, `developer`, `tester`, `reviewer`, `committer`) runs this procedure at the **start** of every invocation, before doing any agent-specific work. It loads the project's rules and the task itself so subsequent decisions are grounded in documented conventions rather than guesses.

Agents reference this file from their own Step 0. Any agent-specific additions are listed in that agent's own file as an addendum *after* the steps below — never instead of.

## Steps (do in order)

1. **Always read** `<repo-root>/CLAUDE.md`. If absent, note that fact and continue — many repos don't have one.
2. **Always read** every file under `<repo-root>/.claude/rules/*.md` if the folder exists. These are layered conventions the project owner has chosen to enforce on all agent work.
3. **Read the task** from brain via `mcp__brain__query`:
   ```sql
   SELECT id, title, summary, acceptance_criteria, related_node_ids, type
   FROM tasks WHERE id = $1;
   ```
4. **Derive scope(s)** from the task's `summary` field. The first line follows the convention `Scope: <value>`. The value may be a single scope (e.g. `lms-auth`) or multiple scopes joined by ` + ` with literal spaces (e.g. `lms-auth + crm-auth`). Split on ` + ` to get the list of constituent scopes.
   - If `Scope:` line is missing or malformed → the agent should treat scope as unknown and proceed cautiously (or block, depending on its own policy).
   - Forbidden values (`multi`, `all`, `everything`, `*`) are rejected at creation time, so they should never appear here. If one does, treat as malformed.
5. **Walk nested `CLAUDE.md`** in each scope's folder. For each scope, find the folder it points to (typically `apps/<scope>/` or `apps/<parent>/<sub>/` for `parent-sub` scopes — see scope-derivation rules in `create-task/SKILL.md`). Read every `CLAUDE.md` along the path from repo root down to that folder. These carry the agent-relevant per-area conventions: tech stack, naming, forbidden patterns, testing rules, commit message style.

## Conflict resolution

When two `CLAUDE.md` files disagree (vd root says "prefer X", nested says "use Y in this folder"):

- **More specific wins.** Nested `CLAUDE.md` overrides root `CLAUDE.md` for the code inside that folder.
- **Documented convention wins over personal preference.** When an agent's instinct conflicts with a written rule, the rule is correct.
- **If two equally-specific files contradict each other** (e.g. two sibling scopes in a multi-scope task each forbidding the other's pattern), surface the conflict to the user — don't silently pick one side.

## Tooling preview

The user can preview what an agent will load with:

```
/lmd:scan-context --scope <scope>
```

Run this manually before claiming an unfamiliar task to see what context will be in play.

## Per-agent addenda (cheat sheet)

Each agent file states its addendum after referencing this procedure. The common ones:

| Agent | Addendum |
|---|---|
| `scouter` | none (just the 5 steps) |
| `code-planner` | After step 5: query brain for ~3-5 nodes per scope (`WHERE app = <scope> LIMIT 5`) to absorb naming + structure patterns. |
| `plan-reviewer` | After step 5: note that documented convention always wins over personal preference; personal preference goes in `info`, not `fail`. |
| `developer` | After step 5: per scope, look for `<repo-root>/.claude/agents/<scope>-*-dev.md`. If a matching specialist exists AND the change is complex, prefer delegation. |
| `tester` | In step 1: also look for `## Test Server` and `## Test Auth` sections in `CLAUDE.md` (dev URL + credentials for runtime Playwright verification). |
| `reviewer` | After step 5: same as plan-reviewer — convention wins, preference goes in `info`. |
| `committer` | In step 1: pay special attention to commit-message conventions, `Co-Authored-By` policy, hook bypass policy. |
