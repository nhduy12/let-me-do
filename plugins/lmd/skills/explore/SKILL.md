---
name: explore
description: Drive a real browser (Playwright) to walk reachable UI from a seed (URL or node_id), capture verified transitions, and upsert new node/edge candidates directly via the brain MCP. User-invoked when brain needs UI-grounded enrichment.
allowed-tools: Read, Glob, Grep, Bash, mcp__brain__query, mcp__brain__find_paths, mcp__brain__get_settings, mcp__brain__upsert_node, mcp__brain__upsert_edge
user-invocable: true
---

# explore

UI-driven graph enrichment. Invoke with `/lmd:explore <seed>` where seed is a URL or an existing node id. The walk is one logical operation — may take 5–15 minutes of browser driving — but it's a single user intent, so it's a skill, not an agent.

## Workflow

1. **Parse seed** from `$ARGUMENTS`:
   - URL: `/lmd:explore http://localhost:5173/login`
   - Node: `/lmd:explore web:login` → look up URL in brain.
   - Empty: ask the user.
2. **Resolve auth** by reading `<repo-root>/.lmd/test-env.md` (same convention as `tester` — only source of test-env config). Missing file or missing relevant section → refuse with "create / fix `.lmd/test-env.md`" (see `plugins/lmd/templates/test-env.md.example`). Honour the `Method:` of the resolved profile:
   - `password` → drive the same-origin login form as before.
   - `storageState` → load the saved session JSON (`Storage states:` path for the `--auth` profile) into the browser context; **do NOT visit the IdP**. This is the only auth that works for SSO apps (see step 3 + the Forbidden note on external origins). Missing state file → refuse with the `npx playwright codegen --save-storage=<path> <url>` capture command. If the walk immediately bounces off-origin or to a login route, the session is expired → stop and tell the user to refresh that file.
3. **Launch Playwright** via `Bash` — `npx playwright codegen <url>` or a bundled walk script. For the `storageState` method, pass the saved session so the walk starts authenticated: `npx playwright codegen --load-storage=<path> <url>` (or `browser.newContext({ storageState: <path> })` in the walk script). Playwright is BYO (consumer installs). Default mode is headed (visible browser) so the user can observe; `--headless` switches to no-window. Either way, append `--slow-mo=<slow_mo_ms>` (default 300) when headed so clicks are watchable; the flag is a no-op in headless. Headed without a display fails fast with a Playwright error mentioning DISPLAY / xvfb — surface it; do NOT silently fall back.
4. **Walk loop** per page, sequentially. Every page visit MUST follow the wait-for-render sequence below — SPAs that hydrate client-side return a near-empty DOM at the `load` event, and reading state before hydration yields ghost graphs (empty `actions` arrays, missed overlays).
   - After every navigation (initial `page.goto` and after every action that changes URL):
     ```js
     await page.waitForLoadState('domcontentloaded');
     await page.waitForLoadState('networkidle');         // 500ms quiet net
     // Optionally also: await page.waitForSelector('<known stable mount>', { state: 'visible' })
     ```
   - Then capture URL, title, and key text content.
   - Enumerate clickable / submittable elements (selectors, labels).
   - Skip destructive selectors by default — `[data-destructive]`, `[data-danger]`, or labels `Delete` / `Remove` / `Destroy`. `--include-destructive` to opt in.
   - Hypothesize each target (from `href` / handler / on-click navigate), click, **wait for `networkidle` again**, observe URL / DOM change, confirm or correct.
5. **Detect overlays**: DOM mutation without URL change → overlay node `mounted_on` current page. Wait `networkidle` after the trigger click before enumerating the overlay's content, same reason as above.
6. **Stop** on: max depth (default 5, `--depth N`); revisits exceed threshold (graph saturated); auth wall; user interrupt; per-page wait-for-render timeout exceeded (default 15s per page).
7. **Upsert** candidates via `mcp__brain__upsert_node` / `upsert_edge`. Empty states are valid paths to record (mark `confidence: low`).
8. **Print summary**: pages visited, edges discovered, edges confirmed, flagged ambiguities.

## Confidence layering

Edges from `/lmd:explore` are UI-verified — outrank `init` (static) and `dev` (code-inferred). `upsert_edge` ON CONFLICT overwrites content from less-confident sources; re-upserting confirmed edges is the intended flow. Brain stays text-only — no visual snapshots stored.

## Args & flags

```
/lmd:explore <seed>                          # defaults
/lmd:explore <seed> --depth 3                # cap depth
/lmd:explore <seed> --no-overlays            # skip modal/drawer detection
/lmd:explore <seed> --auth admin             # named auth profile (or <server>.<profile> for multi-server)
/lmd:explore <seed> --dry-run                # print candidates, don't write
/lmd:explore <seed> --include-destructive    # walk Delete/Remove buttons
/lmd:explore <seed> --headless               # default is headed (visible browser) since the
                                             # walk is user-supervised; --headless skips the
                                             # window when running in CI or over SSH
/lmd:explore <seed> --slow-mo 500            # ms between Playwright actions (default 300)
```

Default mode is **headed** — the walk is user-watched (5–15 min). Pass `--headless` only when you have no display or you're piping the walk into a script.

## Forbidden

- Modify code.
- Commit anything.
- Navigate to external URLs (stay on target origin). For SSO apps this is exactly why the `storageState` auth method exists — load a saved session instead of walking the external IdP.
- Submit destructive forms (DELETE, payment, etc.) without `--include-destructive`.

## Output

- Node/edge candidates with confidence + source.
- Page-by-page visit log.
- Ambiguities for human review.
