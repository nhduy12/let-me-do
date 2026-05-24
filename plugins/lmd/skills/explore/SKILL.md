---
name: explore
description: Drive a real browser (Playwright) to walk reachable UI from a seed (URL or node_id), capture verified transitions, and upsert new node/edge candidates directly via the brain MCP. User-invoked when brain needs UI-grounded enrichment.
allowed-tools: Read, Glob, Grep, Bash, mcp__brain__query, mcp__brain__find_paths, mcp__brain__get_settings, mcp__brain__upsert_node, mcp__brain__upsert_edge
user-invocable: true
---

# explore

> *"Let me poke around and see what's actually there."*

User-facing skill for UI-driven graph enrichment. Invoke with `/lmd:explore <seed>` where seed is a URL or an existing node id.

## Why a skill, not an agent

The walk is **one logical operation** the user triggers — even if it takes 5–15 minutes of browser driving, it's a single intent. Skills are the right shape for user-initiated, on-demand work.

## Workflow

1. **Parse seed** from `$ARGUMENTS`:
   - URL form: `/lmd:explore http://localhost:5173/login`
   - Node form: `/lmd:explore web:login` → look up URL in brain
   - Empty: ask the user.
2. **Resolve auth state**: project provides a pre-seeded test user, with path / credentials documented in the project's `CLAUDE.md` under `Test Auth` (or similar). If not documented, the skill refuses with that instruction.
3. **Launch Playwright** via `Bash`:
   ```bash
   npx playwright codegen <url>          # or a bundled walk script
   ```
   Playwright is BYO — consumer installs it themselves; the plugin assumes `npx playwright` is available.
4. **Walk loop** for each visited page, sequentially (one page at a time):
   - Capture URL, title, key text.
   - Enumerate clickable / submittable elements (selectors, labels).
   - Skip destructive selectors by default — `[data-destructive]`, `[data-danger]`, or visible labels `Delete` / `Remove` / `Destroy`. Pass `--include-destructive` to opt in.
   - Hypothesize each target (best guess from `href` / handler / on-click navigate).
   - Click → observe URL / DOM change → confirm or correct.
5. **Detect overlays** (modal, drawer, sheet) — DOM mutation without URL change → record as overlay node `mounted_on` current page.
6. **Stop conditions**:
   - Max depth reached (default 5, override via `--depth N`).
   - Revisits exceed threshold (graph saturated).
   - Auth wall (login redirect).
   - User interrupts the session.
7. **Upsert candidates** via `mcp__brain__upsert_node` and `mcp__brain__upsert_edge`. Walk against whatever state the dev DB has — empty states are valid paths to record (marked `confidence: low`).
8. **Print summary**: pages visited, edges discovered, edges already-in-brain confirmed, flagged ambiguities.

## Confidence layering

Edges produced by `lmd:explore` are UI-verified — they outrank `init` (static) and `dev` (code-inferred). `upsert_edge`'s ON CONFLICT semantics will overwrite content from less-confident sources; explore re-upserts any pre-existing edge it confirms.

Brain stays text-only — no visual snapshots are stored.

## Args & flags

```
/lmd:explore <seed>                # walk from seed with defaults
/lmd:explore <seed> --depth 3      # cap depth
/lmd:explore <seed> --no-overlays  # skip modal/drawer detection
/lmd:explore <seed> --auth admin   # use a named auth profile
/lmd:explore <seed> --dry-run      # print candidates, don't write
/lmd:explore <seed> --include-destructive   # walk Delete/Remove buttons too
```

## Forbidden actions

- Don't modify code.
- Don't commit anything.
- Don't navigate to external URLs (stay on the target origin).
- Don't submit destructive forms (DELETE, payment, etc.) without `--include-destructive`.

## Output

- List of node/edge candidates with confidence + source.
- Page-by-page visit log.
- Ambiguities for human review.
