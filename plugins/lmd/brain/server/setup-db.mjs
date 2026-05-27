#!/usr/bin/env node
// One-shot migration runner for the brain database.
//
// Replaces the legacy `psql -f setup.sql` flow. Takes a superuser connection
// string and creates (idempotently):
//   - A new database
//   - The `ai_agent` login role (or updates its password if it already exists)
//   - GRANTs scoped to that one database
//   - Tables: nodes, edges, tasks, task_events with their indexes
//   - Function: find_paths(src, tgt, max_depth)
//
// Usage:
//
//   # interactive
//   node setup-db.mjs
//
//   # non-interactive (CI / scripts)
//   node setup-db.mjs --auto \
//     --admin-uri "postgresql://postgres:adminpwd@localhost:5432/postgres" \
//     --db-name brain_my_project \
//     --ai-password 'StrongPwd123!'
//
//   # env-var driven (same args, prefix with --auto to skip prompts)
//   ADMIN_URI=... DB_NAME=... AI_PASSWORD=... node setup-db.mjs --auto
//
// On success the final line of stdout is the connection string to paste into
// Claude Code's `database_uri` user_config. Use --print-uri-only to suppress
// progress logs (useful when piping into another tool).

import { randomBytes } from "node:crypto";
import readline from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { ensureDeps } from "./ensure-deps.mjs";

ensureDeps({ require: "pg" });

// Dynamic import — pg must be installed before this resolves.
const { default: pg } = await import("pg");
const { Client } = pg;

// ============================================================================
// CLI parsing
// ============================================================================

const HELP = `Usage: node setup-db.mjs [options]

Two modes — pick the one that matches your starting state.

================================================================
Mode 1 (default) — bootstrap a fresh DB + role from a superuser
================================================================
Creates database, creates ai_agent role, applies schema.

  --admin-uri <uri>       Superuser connection string
                          (e.g. postgresql://postgres:pwd@localhost:5432/postgres).
                          Env: ADMIN_URI
  --db-name <name>        New database name. Default in interactive mode:
                          brain_<cwd-folder>. Must match [a-z][a-z0-9_]*.
                          Env: DB_NAME
  --ai-password <pwd>     Password for the ai_agent role. Random if omitted in
                          --auto mode. Env: AI_PASSWORD

================================================================
Mode 2 — schema-only: add brain tables to an existing DB
================================================================
For when you already have a Postgres DB + a user with rights to create
tables in it. Skips CREATE DATABASE and CREATE ROLE.

  --schema-only           Switch to this mode.
  --target-uri <uri>      Connection string to your existing DB
                          (e.g. postgresql://my_user:pwd@host/my_db).
                          Env: TARGET_URI
  --role <name>           Role that should own the tables + receive grants.
                          Default: the user the connection authenticates as
                          (SELECT current_user). Must match
                          [A-Za-z_][A-Za-z0-9_]*. Env: ROLE

================================================================
Common
================================================================
  --auto                  Non-interactive. Requires --admin-uri (mode 1) or
                          --target-uri (mode 2). Fills sensible defaults for
                          the rest.
  --print-uri-only        On success, emit ONLY the final connection string
                          on stdout (progress goes to stderr).
  -h, --help              This help text.

Idempotent in both modes:
  - Tables use CREATE TABLE IF NOT EXISTS.
  - Function uses CREATE OR REPLACE FUNCTION.
  - Bootstrap mode: CREATE DATABASE / CREATE ROLE checked for existence; the
    password is always re-applied via ALTER ROLE.
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--admin-uri") out.adminUri = argv[++i];
    else if (a === "--db-name") out.dbName = argv[++i];
    else if (a === "--ai-password") out.aiPwd = argv[++i];
    else if (a === "--schema-only") out.schemaOnly = true;
    else if (a === "--target-uri") out.targetUri = argv[++i];
    else if (a === "--role") out.role = argv[++i];
    else if (a === "--auto") out.auto = true;
    else if (a === "--print-uri-only") out.printUriOnly = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      stderr.write(`Unknown arg: ${a}\n`);
      process.exit(2);
    }
  }
  return out;
}

// ============================================================================
// Helpers
// ============================================================================

function log(msg, opts) {
  if (opts?.silent) return;
  stderr.write(`[setup-db] ${msg}\n`);
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Dollar-quote a literal so it can be safely inlined into a SQL statement that
// does not accept parameter placeholders (CREATE ROLE / ALTER ROLE PASSWORD).
// We pick a random tag and verify the string doesn't contain it.
function dollarQuote(s) {
  for (let i = 0; i < 16; i++) {
    const tag = `lmd${randomBytes(3).toString("hex")}`;
    const marker = `$${tag}$`;
    if (!String(s).includes(marker)) {
      return `${marker}${s}${marker}`;
    }
  }
  throw new Error("could not find an unused dollar-quote tag (extremely unlikely)");
}

function validateDbName(name) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(
      `Invalid --db-name "${name}": must start with a lowercase letter, contain only [a-z0-9_], and be ≤ 63 chars.`,
    );
  }
}

function validateRoleName(name) {
  // Postgres identifiers can be quoted with " and contain almost anything,
  // but we are about to interpolate this directly into DDL like
  // `ALTER TABLE x OWNER TO <ident>` (quoted by us). We still want a safe,
  // recognizable shape — letters, digits, underscores. 63-char Postgres limit.
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw new Error(
      `Invalid role name "${name}": must start with a letter or underscore, contain only [A-Za-z0-9_], and be ≤ 63 chars.`,
    );
  }
}

function defaultDbName() {
  const folder = process.cwd().split(/[\\/]/).pop() ?? "project";
  return `brain_${folder.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "project"}`;
}

function generatePassword() {
  // 22-char base64url (~128 bits of entropy). No special chars that need
  // URL-encoding in a Postgres URI.
  return randomBytes(16).toString("base64url");
}

// ============================================================================
// Schema (inlined — kept in sync with brain/sql/setup.sql by hand)
// ============================================================================

function buildSchemaSql(dbName, roleName = "ai_agent") {
  const dbIdent = quoteIdent(dbName);
  const role = quoteIdent(roleName);
  return `
GRANT CONNECT ON DATABASE ${dbIdent} TO ${role};
GRANT USAGE, CREATE ON SCHEMA public TO ${role};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${role};

BEGIN;

CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  app           TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'page',
  url           TEXT,
  mounted_on    TEXT,
  label         TEXT NOT NULL,
  grp           TEXT,
  description   TEXT,
  actions       JSONB NOT NULL DEFAULT '[]',
  access        JSONB,
  preconditions JSONB NOT NULL DEFAULT '[]',
  assertions    JSONB NOT NULL DEFAULT '[]',
  note          TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id        TEXT PRIMARY KEY,
  source    TEXT NOT NULL,
  target    TEXT NOT NULL,
  action    TEXT NOT NULL,
  label     TEXT,
  steps     TEXT NOT NULL,
  condition TEXT,
  note      TEXT
);

CREATE INDEX IF NOT EXISTS nodes_actions_gin ON nodes USING GIN (actions);
CREATE INDEX IF NOT EXISTS nodes_fts ON nodes USING GIN (
  to_tsvector('simple', label || ' ' || COALESCE(description, ''))
);
CREATE INDEX IF NOT EXISTS nodes_app ON nodes (app);
CREATE INDEX IF NOT EXISTS nodes_grp ON nodes (grp);
CREATE INDEX IF NOT EXISTS edges_src ON edges (source);
CREATE INDEX IF NOT EXISTS edges_tgt ON edges (target);

ALTER TABLE nodes OWNER TO ${role};
ALTER TABLE edges OWNER TO ${role};

COMMIT;

CREATE OR REPLACE FUNCTION find_paths(
  src       TEXT,
  tgt       TEXT,
  max_depth INT DEFAULT 4
) RETURNS TABLE(path TEXT[], steps TEXT[], depth INT)
LANGUAGE sql STABLE AS $func$
  WITH RECURSIVE walk AS (
    SELECT
      e.target,
      ARRAY[e.source, e.target]::TEXT[] AS path,
      ARRAY[e.steps]::TEXT[]            AS steps,
      1                                 AS depth
    FROM edges e
    WHERE e.source = src

    UNION ALL

    SELECT
      e.target,
      w.path  || e.target,
      w.steps || e.steps,
      w.depth + 1
    FROM edges e
    JOIN walk w ON e.source = w.target
    WHERE NOT e.target = ANY(w.path)
      AND w.depth < max_depth
  )
  SELECT path, steps, depth
  FROM walk
  WHERE target = tgt
  ORDER BY depth
  LIMIT 20;
$func$;

ALTER FUNCTION find_paths(TEXT, TEXT, INT) OWNER TO ${role};
GRANT EXECUTE ON FUNCTION find_paths(TEXT, TEXT, INT) TO ${role};

BEGIN;

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  summary             TEXT,
  type                TEXT,
  status              TEXT NOT NULL DEFAULT 'pending',

  created_by          TEXT NOT NULL,
  assigned_to         TEXT,
  claimed_by          TEXT,
  claimed_at          TIMESTAMPTZ,

  current_step        TEXT,
  iteration           INT NOT NULL DEFAULT 0,

  acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  related_node_ids    JSONB NOT NULL DEFAULT '[]',
  blockers            JSONB NOT NULL DEFAULT '[]',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);
CREATE INDEX IF NOT EXISTS tasks_assigned_idx ON tasks (assigned_to)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_claimed_idx ON tasks (claimed_by)
  WHERE claimed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks (created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_fts ON tasks USING GIN (
  to_tsvector('simple', title || ' ' || COALESCE(summary, ''))
);

ALTER TABLE tasks OWNER TO ${role};

COMMIT;

BEGIN;

CREATE TABLE IF NOT EXISTS task_events (
  id          BIGSERIAL PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  step        TEXT,
  iter        INT,
  agent       TEXT,
  outcome     TEXT,
  signature   TEXT,
  report_ref  TEXT,
  actor       TEXT,
  reason      TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_events_task_idx
  ON task_events (task_id, created_at);

CREATE INDEX IF NOT EXISTS task_events_step_completion_idx
  ON task_events (task_id, step, iter)
  WHERE kind = 'step' AND outcome IS NOT NULL;

CREATE INDEX IF NOT EXISTS task_events_step_signature_idx
  ON task_events (task_id, step, created_at DESC)
  WHERE kind = 'step' AND signature IS NOT NULL;

ALTER TABLE task_events OWNER TO ${role};
GRANT USAGE, SELECT ON SEQUENCE task_events_id_seq TO ${role};

COMMIT;
`;
}

// ============================================================================
// Steps
// ============================================================================

async function ensureDatabase(adminClient, dbName, opts) {
  const dbIdent = quoteIdent(dbName);
  try {
    await adminClient.query(`CREATE DATABASE ${dbIdent}`);
    log(`created database ${dbName}`, opts);
  } catch (e) {
    if (e.code === "42P04") {
      log(`database ${dbName} already exists — skipping CREATE`, opts);
    } else {
      throw e;
    }
  }
}

async function ensureRole(adminClient, password, opts) {
  const exists = await adminClient.query(
    "SELECT 1 FROM pg_roles WHERE rolname = 'ai_agent'",
  );
  const pwLit = dollarQuote(password);
  if (exists.rowCount > 0) {
    await adminClient.query(`ALTER ROLE ai_agent WITH PASSWORD ${pwLit}`);
    log("updated ai_agent password", opts);
  } else {
    await adminClient.query(`CREATE ROLE ai_agent WITH LOGIN PASSWORD ${pwLit}`);
    log("created role ai_agent", opts);
  }
}

async function applySchema(client, dbName, roleName, opts) {
  await client.query(buildSchemaSql(dbName, roleName));
  log(`applied schema (tables, indexes, function, grants → role ${roleName})`, opts);
}

function buildAgentUri(adminUri, dbName, aiPwd) {
  // Strip trailing path + query of the admin URI, then append our DB + creds.
  const u = new URL(adminUri);
  u.username = "ai_agent";
  u.password = encodeURIComponent(aiPwd);
  u.pathname = `/${dbName}`;
  // pg's URL handling double-encodes %; build manually to keep it readable.
  const port = u.port ? `:${u.port}` : "";
  return `postgresql://ai_agent:${encodeURIComponent(aiPwd)}@${u.hostname}${port}/${dbName}`;
}

// ============================================================================
// Main
// ============================================================================

async function runSchemaOnly(args, opts) {
  let targetUri = args.targetUri ?? process.env.TARGET_URI;
  let roleName = args.role ?? process.env.ROLE;

  if (!args.auto) {
    const rl = readline.createInterface({ input: stdin, output: stderr });
    if (!targetUri) {
      targetUri = (
        await rl.question(
          "Target Postgres URI (postgresql://<user>:<pwd>@<host>:<port>/<db>): ",
        )
      ).trim();
    }
    if (!roleName) {
      const ans = (
        await rl.question(
          "Role to own tables / receive grants [press enter to use the connecting user]: ",
        )
      ).trim();
      if (ans) roleName = ans;
    }
    rl.close();
  } else {
    if (!targetUri) {
      stderr.write("--auto --schema-only: --target-uri / TARGET_URI is required.\n");
      process.exit(2);
    }
  }

  if (!targetUri.startsWith("postgres://") && !targetUri.startsWith("postgresql://")) {
    stderr.write(`Invalid --target-uri: must start with postgres:// or postgresql://\n`);
    process.exit(2);
  }

  // Derive DB name from the URI path for the GRANT CONNECT statement.
  const dbName = (() => {
    const p = new URL(targetUri).pathname.replace(/^\//, "");
    if (!p) throw new Error("--target-uri must include the database name in the path");
    return p;
  })();
  validateDbName(dbName);

  const target = new Client({ connectionString: targetUri });
  try {
    await target.connect();
  } catch (e) {
    stderr.write(`Cannot connect to target URI: ${e.message}\n`);
    process.exit(1);
  }

  try {
    if (!roleName) {
      const r = await target.query("SELECT current_user AS u");
      roleName = r.rows[0].u;
      log(`role not specified; using connecting user "${roleName}"`, opts);
    }
    validateRoleName(roleName);

    log(`schema-only mode: target db=${dbName}, role=${roleName}`, opts);
    await applySchema(target, dbName, roleName, opts);
  } finally {
    await target.end();
  }

  if (args.printUriOnly) {
    // User already has the URI — echo it back so this still works in pipelines.
    stdout.write(`${targetUri}\n`);
  } else {
    log("done.", opts);
    stdout.write("\n");
    stdout.write("Brain tables installed in your existing DB. Paste this into\n");
    stdout.write("Claude Code's `database_uri` user_config:\n");
    stdout.write(`\n  ${targetUri}\n\n`);
    stdout.write("Then `/reload-plugins` and run `/lmd:check-system` to verify.\n");
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    stdout.write(HELP);
    return;
  }

  const opts = { silent: !!args.printUriOnly };

  if (args.schemaOnly) {
    return runSchemaOnly(args, opts);
  }

  let adminUri = args.adminUri ?? process.env.ADMIN_URI;
  let dbName = args.dbName ?? process.env.DB_NAME;
  let aiPwd = args.aiPwd ?? process.env.AI_PASSWORD;

  if (!args.auto) {
    const rl = readline.createInterface({ input: stdin, output: stderr });
    if (!adminUri) {
      adminUri = (
        await rl.question(
          "Superuser Postgres URI [postgresql://postgres:<pwd>@localhost:5432/postgres]: ",
        )
      ).trim();
    }
    if (!dbName) {
      const def = defaultDbName();
      dbName = (await rl.question(`New DB name [${def}]: `)).trim() || def;
    }
    if (!aiPwd) {
      const def = generatePassword();
      const ans = (
        await rl.question(`ai_agent password [press enter for random ${def}]: `)
      ).trim();
      aiPwd = ans || def;
    }
    rl.close();
  } else {
    if (!adminUri) {
      stderr.write("--auto: --admin-uri / ADMIN_URI is required.\n");
      process.exit(2);
    }
    if (!dbName) dbName = defaultDbName();
    if (!aiPwd) aiPwd = generatePassword();
  }

  validateDbName(dbName);
  if (!adminUri.startsWith("postgres://") && !adminUri.startsWith("postgresql://")) {
    stderr.write(`Invalid admin URI: must start with postgres:// or postgresql://\n`);
    process.exit(2);
  }

  log(`target: db=${dbName}, role=ai_agent`, opts);

  // -- Phase 1: admin connection — CREATE DATABASE + role
  const admin = new Client({ connectionString: adminUri });
  try {
    await admin.connect();
  } catch (e) {
    stderr.write(`Cannot connect to admin URI: ${e.message}\n`);
    process.exit(1);
  }
  try {
    await ensureDatabase(admin, dbName, opts);
    await ensureRole(admin, aiPwd, opts);
  } finally {
    await admin.end();
  }

  // -- Phase 2: connect to the new DB as superuser, apply schema
  const newDbUri = (() => {
    const u = new URL(adminUri);
    u.pathname = `/${dbName}`;
    return u.toString();
  })();

  const target = new Client({ connectionString: newDbUri });
  try {
    await target.connect();
    await applySchema(target, dbName, "ai_agent", opts);
  } finally {
    await target.end();
  }

  const finalUri = buildAgentUri(adminUri, dbName, aiPwd);

  if (args.printUriOnly) {
    stdout.write(`${finalUri}\n`);
  } else {
    log("done.", opts);
    stdout.write("\n");
    stdout.write("Paste this into Claude Code's `database_uri` user_config:\n");
    stdout.write(`\n  ${finalUri}\n\n`);
    stdout.write("Then `/reload-plugins` and run `/lmd:check-system` to verify.\n");
  }
}

main().catch((e) => {
  stderr.write(`\n[setup-db] FAILED: ${e.message}\n`);
  if (e.code) stderr.write(`  Postgres error code: ${e.code}\n`);
  if (e.detail) stderr.write(`  ${e.detail}\n`);
  process.exit(1);
});
