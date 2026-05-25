#!/usr/bin/env node
// Launcher for the brain MCP server.
//
// Why a wrapper: Claude Code plugins ship as a checked-out folder; there is no
// post-install hook that runs `npm install` for nested server folders. Without
// this script, the first `node index.mjs` invocation crashes on
// `Cannot find module '@modelcontextprotocol/sdk/...'`. Here we detect the
// missing `node_modules` and install once, then hand off to the real server.
//
// On every subsequent run the `existsSync` check inside ensureDeps short-
// circuits in <1 ms.

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureDeps } from "./ensure-deps.mjs";

const here = dirname(fileURLToPath(import.meta.url));

ensureDeps({ require: "all" });
await import(pathToFileURL(resolve(here, "index.mjs")).href);
