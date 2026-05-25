// Shared dep bootstrapping for the brain server.
//
// The plugin ships as a checked-out folder with no install hook, so the first
// process that wants to `import 'pg'` or '@modelcontextprotocol/sdk' has to
// install them itself. Both `start.mjs` (runtime MCP server) and `setup-db.mjs`
// (one-shot DB migration) need this — keep the logic in one place so the
// behaviour stays consistent.
//
// The shape that matters to MCP callers (stdio JSON-RPC on fd 1) is preserved
// by `start.mjs` itself; this module just writes to stderr.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const sdkMarker = resolve(here, "node_modules", "@modelcontextprotocol", "sdk", "package.json");
const pgMarker = resolve(here, "node_modules", "pg", "package.json");

function log(msg) {
  process.stderr.write(`[let-me-do/brain] ${msg}\n`);
}

/**
 * Ensure the npm deps required by the brain server are installed.
 *
 * @param {{ require?: 'pg' | 'all' }} opts
 *   `require:'pg'`  — only pg is needed (used by setup-db.mjs).
 *   `require:'all'` — pg + @modelcontextprotocol/sdk are both needed
 *                     (used by start.mjs / the MCP server).
 *   Default: 'all'.
 */
export function ensureDeps(opts = {}) {
  const need = opts.require ?? "all";
  const haveAll = existsSync(sdkMarker) && existsSync(pgMarker);
  const havePg = existsSync(pgMarker);

  if (need === "all" && haveAll) return;
  if (need === "pg" && havePg) return;

  log("dependencies missing; running `npm install` (one-time, ~30s)...");

  const r = spawnSync(
    "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"],
    {
      cwd: here,
      stdio: ["ignore", process.stderr, process.stderr],
      shell: true,
    },
  );

  if (r.error && r.error.code === "ENOENT") {
    log("`npm` not found on PATH. Install Node.js (>=20) so deps can bootstrap.");
    process.exit(1);
  }
  if (r.status !== 0) {
    const code = r.status === null ? `killed (signal=${r.signal})` : r.status;
    log(`npm install failed with exit ${code}; aborting. Run \`npm install --omit=dev\` in ${here} manually.`);
    process.exit(1);
  }

  const okNow = need === "pg" ? existsSync(pgMarker) : (existsSync(sdkMarker) && existsSync(pgMarker));
  if (!okNow) {
    log("npm install reported success but expected modules still missing; aborting.");
    process.exit(1);
  }
  log("dependencies installed.");
}
