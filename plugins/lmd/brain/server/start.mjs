#!/usr/bin/env node
// Launcher for the brain MCP server.
//
// Why a wrapper: Claude Code plugins ship as a checked-out folder; there is no
// post-install hook that runs `npm install` for nested server folders. Without
// this script, the first `node index.mjs` invocation crashes on
// `Cannot find module '@modelcontextprotocol/sdk/...'`. Here we detect the
// missing `node_modules` and install once, then hand off to the real server.
//
// On every subsequent run the `existsSync` check short-circuits in <1 ms.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const nodeModules = resolve(here, "node_modules");
const sdkMarker = resolve(nodeModules, "@modelcontextprotocol", "sdk", "package.json");
const pgMarker = resolve(nodeModules, "pg", "package.json");

function log(msg) {
  // stderr only — stdout is the MCP transport.
  process.stderr.write(`[let-me-do/brain] ${msg}\n`);
}

function ensureDeps() {
  if (existsSync(sdkMarker) && existsSync(pgMarker)) return;

  log("dependencies missing; running `npm install` (one-time, ~30s)...");

  // CRITICAL: MCP stdio transport owns this process's stdout — any byte from
  // npm on fd 1 would corrupt the JSON-RPC frame the parent client expects.
  // Redirect npm's stdout to OUR stderr (fd 2) so install logs stay visible
  // in Claude Code's MCP debug log without polluting the protocol channel.
  //
  // On Windows, `npm` is `npm.cmd` (a batch script). `spawnSync` won't resolve
  // .cmd extensions without a shell, so we set `shell: true` cross-platform —
  // the npm CLI is trusted and the args are constant.
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
    log("`npm` not found on PATH. Install Node.js (>=20) so MCP can bootstrap its deps.");
    process.exit(1);
  }
  if (r.status !== 0) {
    const code = r.status === null ? "killed (signal=" + r.signal + ")" : r.status;
    log(`npm install failed with exit ${code}; aborting. Run \`npm install --omit=dev\` in ${here} manually.`);
    process.exit(1);
  }
  if (!existsSync(sdkMarker) || !existsSync(pgMarker)) {
    log("npm install reported success but expected modules still missing; aborting.");
    process.exit(1);
  }
  log("dependencies installed.");
}

ensureDeps();
await import(pathToFileURL(resolve(here, "index.mjs")).href);
