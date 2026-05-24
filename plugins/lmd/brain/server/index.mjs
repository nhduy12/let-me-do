#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";

const DATABASE_URI = process.env.DATABASE_URI;
if (!DATABASE_URI) {
  console.error("[let-me-do/brain] DATABASE_URI env var is required");
  process.exit(1);
}

const STATEMENT_TIMEOUT_MS = Number(process.env.STATEMENT_TIMEOUT_MS ?? 5000);
const MAX_ROWS = Number(process.env.MAX_ROWS ?? 500);

const pool = new pg.Pool({
  connectionString: DATABASE_URI,
  statement_timeout: STATEMENT_TIMEOUT_MS,
  max: 4,
});

const FORBIDDEN_RE =
  /\b(DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER|COPY|SECURITY|SET\s+ROLE|RESET\s+ROLE|LISTEN|NOTIFY|LOAD|DO|CALL)\b/i;
const SELECT_START_RE = /^\s*(SELECT|WITH)\b/i;
const WRITE_START_RE = /^\s*(INSERT|UPDATE|DELETE|WITH)\b/i;

function ensureSingleStatement(sql) {
  const trimmed = sql.replace(/;\s*$/, "").trim();
  if (trimmed.includes(";")) {
    throw new Error("Only a single SQL statement per call is allowed");
  }
  return trimmed;
}

function asText(payload) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

const server = new Server(
  { name: "let-me-do-brain", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "query",
      description:
        "Run a read-only SELECT (or WITH ... SELECT) on the brain database. Returns rows as JSON. Max rows capped by MAX_ROWS env.",
      inputSchema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "A single SELECT (or read-only WITH) statement.",
          },
        },
        required: ["sql"],
      },
    },
    {
      name: "execute",
      description:
        "Escape hatch for raw INSERT / UPDATE / DELETE on the brain database. DDL forbidden. Single statement per call. Prefer the typed tools (upsert_node, upsert_edge, create_task, claim_task, etc.) when they fit — they are parameterized and idempotent. Use this only for ad-hoc writes the typed tools don't cover.",
      inputSchema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description:
              "A single INSERT, UPDATE, DELETE, or writable WITH statement.",
          },
        },
        required: ["sql"],
      },
    },
    {
      name: "find_paths",
      description:
        "Find paths between two node ids in the screen-flow graph (1..max_depth hops). Returns ordered list of paths and steps.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source node id, e.g. web:home" },
          target: { type: "string", description: "Target node id, e.g. web:home-detail" },
          max_depth: { type: "number", default: 4, minimum: 1, maximum: 8 },
        },
        required: ["source", "target"],
      },
    },
    {
      name: "get_settings",
      description:
        "Return runtime settings configured for this brain instance: statement timeout, max row cap.",
      inputSchema: { type: "object", properties: {} },
    },

    // ====== Typed flow tools ======

    {
      name: "upsert_node",
      description:
        "Insert or update a node (screen / overlay) in the screen-flow graph. Idempotent via ON CONFLICT on `id`. Use this instead of raw INSERT.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Node id, e.g. web:home" },
          app: { type: "string" },
          type: { type: "string", enum: ["page", "modal", "drawer", "sheet"], default: "page" },
          url: { type: "string" },
          mounted_on: { type: "string", description: "Parent page id for overlays" },
          label: { type: "string" },
          grp: { type: "string", description: "Functional group" },
          description: { type: "string" },
          actions: { type: "array", items: { type: "string" }, description: "Intent labels the user can do here" },
          access: { type: "object", description: "{ auth, roles, note }" },
          preconditions: { type: "array", items: { type: "string" } },
          assertions: { type: "array", items: { type: "string" } },
          note: { type: "string" },
        },
        required: ["id", "app", "label"],
      },
    },
    {
      name: "upsert_edge",
      description:
        "Insert or update an edge (navigation step) in the screen-flow graph. Idempotent via ON CONFLICT on `id`. Use this instead of raw INSERT.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Convention: <source>→<target>" },
          source: { type: "string" },
          target: { type: "string" },
          action: { type: "string", enum: ["click", "submit", "redirect", "back", "deeplink", "close"] },
          label: { type: "string" },
          steps: { type: "string", description: "QA steps to reproduce this transition" },
          condition: { type: "string" },
          note: { type: "string" },
        },
        required: ["id", "source", "target", "action", "steps"],
      },
    },
    {
      name: "delete_node",
      description:
        "Delete a node. If cascade=true (default), also delete edges referencing it. Otherwise refuse if any edge references it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          cascade: { type: "boolean", default: true },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_edge",
      description: "Delete an edge by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },

    // ====== Typed task tools ======

    {
      name: "create_task",
      description:
        "Create a task record. If id is omitted, generates `YYYYMMDD-NNN-[scope]-slug` (scope is required in that case). Status defaults to 'pending'. Returns the inserted row.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Optional; auto-generated if omitted" },
          scope: { type: "string", description: "Used to build the id when id is auto-generated. Derived from folder names — lowercase kebab. Examples: 'crm' (matches apps/crm/), 'lms-auth' (matches apps/lms/.../auth/), 'lms-backend' (apps/lms/backend/), 'docs', 'infra', 'lms + crm' (joined with literal spaces for multi-folder tasks). Required when id is omitted. Placeholder values like 'multi'/'all'/'*' are rejected — agents need explicit constituents so they know which folders' CLAUDE.md to read." },
          title: { type: "string" },
          summary: { type: "string" },
          type: { type: "string", enum: ["feature", "fix", "refactor", "chore", "docs"] },
          created_by: { type: "string", description: "git user.email of creator" },
          assigned_to: { type: "string", description: "git user.email or null for open pool" },
          acceptance_criteria: { type: "array", items: { type: "string" } },
          related_node_ids: { type: "array", items: { type: "string" } },
        },
        required: ["title", "created_by"],
      },
    },
    {
      name: "claim_task",
      description:
        "Race-safe claim of a task. Sets claimed_by=claimer, claimed_at=now, status='claimed'. Returns the row if successful, or null + the current claimer if already taken.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          claimer: { type: "string", description: "git user.email of claimer" },
          force: { type: "boolean", default: false, description: "Transfer even if someone else owns it" },
        },
        required: ["id", "claimer"],
      },
    },
    {
      name: "unclaim_task",
      description:
        "Release a task back to the pool. Only the current claimer can unclaim (force=true skips the check).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          claimer: { type: "string", description: "git user.email of current claimer" },
          reason: { type: "string" },
          force: { type: "boolean", default: false },
        },
        required: ["id", "claimer"],
      },
    },
    {
      name: "update_task_step",
      description:
        "Transition a task to a new workflow step (scout/plan/plan-review/dev/test/review/commit/done). Appends to history JSONB. Used by autopilot — typically called twice per iteration: once on entry (outcome=null) and once on completion (outcome=<verdict>, signature=<hex>). The 'dev' step increments tasks.iteration only on entry (when outcome is null); plan_iter is tracked outside the brain (on disk). Signatures are persisted so stuck-loop windows can be reconstructed on resume.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          step: { type: "string", enum: ["scout", "plan", "plan-review", "dev", "test", "review", "commit", "done"] },
          agent: { type: "string", description: "Which agent caused this transition" },
          outcome: { type: "string", description: "Null on entry; one of complete / pass / fail / approve / request-changes / blocked on completion." },
          report_ref: { type: "string", description: "Pointer to the artifact file under .lmd/autopilot/<agent>/<task_id>[-<iter>].md" },
          signature: { type: "string", description: "16-hex short signature returned by the sub-agent. Pass only on completion calls — persisted in history for stuck-loop reconstruction on resume." },
          iter: { type: "number", description: "plan_iter or dev_iter — recorded in history so resume can hydrate windows ordered by iter without scanning timestamps." },
        },
        required: ["id", "step", "agent"],
      },
    },
    {
      name: "complete_task",
      description:
        "Mark a task as done. Sets status='done', completed_at=now, appends to history.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          commit_sha: { type: "string" },
        },
        required: ["id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "query") {
    const raw = String(args?.sql ?? "");
    const sql = ensureSingleStatement(raw);
    if (!SELECT_START_RE.test(sql)) {
      throw new Error("query tool only allows SELECT or read-only WITH");
    }
    if (FORBIDDEN_RE.test(sql)) {
      throw new Error("Forbidden statement (DDL / privilege change detected)");
    }
    if (/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
      throw new Error("Use the `execute` tool for write statements");
    }
    const r = await pool.query({ text: sql, rowMode: "object" });
    const rows = r.rows.slice(0, MAX_ROWS);
    return asText({
      rowCount: r.rowCount,
      truncated: r.rows.length > MAX_ROWS,
      rows,
    });
  }

  if (name === "execute") {
    const raw = String(args?.sql ?? "");
    const sql = ensureSingleStatement(raw);
    if (!WRITE_START_RE.test(sql)) {
      throw new Error("execute tool only allows INSERT/UPDATE/DELETE/WITH");
    }
    if (FORBIDDEN_RE.test(sql)) {
      throw new Error("Forbidden DDL or privilege statement");
    }
    const r = await pool.query(sql);
    return asText({ rowCount: r.rowCount ?? 0, command: r.command });
  }

  if (name === "get_settings") {
    return asText({
      statement_timeout_ms: STATEMENT_TIMEOUT_MS,
      max_rows: MAX_ROWS,
    });
  }

  if (name === "find_paths") {
    const source = String(args?.source ?? "");
    const target = String(args?.target ?? "");
    const maxDepth = Math.min(Math.max(Number(args?.max_depth ?? 4), 1), 8);
    if (!source || !target) {
      throw new Error("source and target are required");
    }
    const r = await pool.query(
      "SELECT path, steps, depth FROM find_paths($1, $2, $3)",
      [source, target, maxDepth],
    );
    return asText({ count: r.rowCount, paths: r.rows });
  }

  // ====== Typed flow handlers ======

  if (name === "upsert_node") {
    const a = args ?? {};
    if (!a.id || !a.app || !a.label) {
      throw new Error("id, app, label are required");
    }
    const r = await pool.query(
      `INSERT INTO nodes (id, app, type, url, mounted_on, label, grp, description, actions, access, preconditions, assertions, note)
       VALUES ($1,$2,COALESCE($3,'page'),$4,$5,$6,$7,$8,COALESCE($9::jsonb,'[]'),$10::jsonb,COALESCE($11::jsonb,'[]'),COALESCE($12::jsonb,'[]'),$13)
       ON CONFLICT (id) DO UPDATE SET
         app=EXCLUDED.app, type=EXCLUDED.type, url=EXCLUDED.url, mounted_on=EXCLUDED.mounted_on,
         label=EXCLUDED.label, grp=EXCLUDED.grp, description=EXCLUDED.description,
         actions=EXCLUDED.actions, access=EXCLUDED.access,
         preconditions=EXCLUDED.preconditions, assertions=EXCLUDED.assertions, note=EXCLUDED.note
       RETURNING id, label`,
      [
        a.id, a.app, a.type, a.url ?? null, a.mounted_on ?? null,
        a.label, a.grp ?? null, a.description ?? null,
        a.actions ? JSON.stringify(a.actions) : null,
        a.access ? JSON.stringify(a.access) : null,
        a.preconditions ? JSON.stringify(a.preconditions) : null,
        a.assertions ? JSON.stringify(a.assertions) : null,
        a.note ?? null,
      ],
    );
    return asText({ upserted: r.rows[0] });
  }

  if (name === "upsert_edge") {
    const a = args ?? {};
    if (!a.id || !a.source || !a.target || !a.action || !a.steps) {
      throw new Error("id, source, target, action, steps are required");
    }
    const r = await pool.query(
      `INSERT INTO edges (id, source, target, action, label, steps, condition, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         source=EXCLUDED.source, target=EXCLUDED.target, action=EXCLUDED.action,
         label=EXCLUDED.label, steps=EXCLUDED.steps, condition=EXCLUDED.condition, note=EXCLUDED.note
       RETURNING id`,
      [a.id, a.source, a.target, a.action, a.label ?? null, a.steps, a.condition ?? null, a.note ?? null],
    );
    return asText({ upserted: r.rows[0] });
  }

  if (name === "delete_node") {
    const a = args ?? {};
    if (!a.id) throw new Error("id is required");
    const cascade = a.cascade !== false;
    if (cascade) {
      await pool.query("DELETE FROM edges WHERE source = $1 OR target = $1", [a.id]);
    } else {
      const ref = await pool.query("SELECT 1 FROM edges WHERE source = $1 OR target = $1 LIMIT 1", [a.id]);
      if (ref.rowCount > 0) {
        throw new Error("Cannot delete: edges reference this node. Use cascade=true.");
      }
    }
    const r = await pool.query("DELETE FROM nodes WHERE id = $1 RETURNING id", [a.id]);
    return asText({ deleted: r.rows[0] ?? null, cascade });
  }

  if (name === "delete_edge") {
    const a = args ?? {};
    if (!a.id) throw new Error("id is required");
    const r = await pool.query("DELETE FROM edges WHERE id = $1 RETURNING id", [a.id]);
    return asText({ deleted: r.rows[0] ?? null });
  }

  // ====== Typed task handlers ======

  if (name === "create_task") {
    const a = args ?? {};
    if (!a.title || !a.created_by) {
      throw new Error("title and created_by are required");
    }
    if (!a.id && !a.scope) {
      throw new Error("scope is required when id is auto-generated (used to build id prefix)");
    }
    if (!a.id && /^(multi|all|everything|\*)$/i.test(String(a.scope).trim())) {
      throw new Error(
        `scope "${a.scope}" is not allowed — list the actual constituents joined by ' + ' (e.g. 'lms + crm' instead of 'multi'). Agents need explicit scopes to know which folders' CLAUDE.md files to read.`
      );
    }
    const slug = String(a.title)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 6)
      .join("-")
      .slice(0, 50);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD

    const MAX_RETRIES = 3;
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let id = a.id;
      if (!id) {
        const counterRes = await pool.query(
          "SELECT COALESCE(MAX(CAST(SPLIT_PART(id, '-', 2) AS INT)), 0) + 1 AS next FROM tasks WHERE id LIKE $1",
          [`${today}-%`],
        );
        const nnn = String(counterRes.rows[0].next + attempt).padStart(3, "0");
        id = `${today}-${nnn}-[${a.scope}]-${slug}`;
      }
      try {
        const r = await pool.query(
          `INSERT INTO tasks (id, title, summary, type, status, created_by, assigned_to, acceptance_criteria, related_node_ids)
           VALUES ($1,$2,$3,$4,'pending',$5,$6,COALESCE($7::jsonb,'[]'),COALESCE($8::jsonb,'[]'))
           RETURNING *`,
          [
            id, a.title, a.summary ?? null, a.type ?? null,
            a.created_by, a.assigned_to ?? null,
            a.acceptance_criteria ? JSON.stringify(a.acceptance_criteria) : null,
            a.related_node_ids ? JSON.stringify(a.related_node_ids) : null,
          ],
        );
        return asText({ task: r.rows[0] });
      } catch (err) {
        if (err.code === "23505" && !a.id) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw new Error(`create_task: failed to acquire unique id after ${MAX_RETRIES} attempts (${lastErr?.message ?? "unknown"})`);
  }

  if (name === "claim_task") {
    const a = args ?? {};
    if (!a.id || !a.claimer) throw new Error("id and claimer are required");
    const guard = a.force ? "TRUE" : "(claimed_by IS NULL OR claimed_by = $2)";
    const r = await pool.query(
      `UPDATE tasks
         SET claimed_by = $2, claimed_at = now(), status = 'claimed',
             history = history || jsonb_build_object('event','claim','by',$2,'at',now()),
             updated_at = now()
       WHERE id = $1 AND ${guard}
       RETURNING id, claimed_by, claimed_at`,
      [a.id, a.claimer],
    );
    if (r.rowCount === 0) {
      const owner = await pool.query("SELECT claimed_by FROM tasks WHERE id = $1", [a.id]);
      return asText({ claimed: false, current_owner: owner.rows[0]?.claimed_by ?? null });
    }
    return asText({ claimed: true, ...r.rows[0] });
  }

  if (name === "unclaim_task") {
    const a = args ?? {};
    if (!a.id || !a.claimer) throw new Error("id and claimer are required");
    const guard = a.force ? "TRUE" : "claimed_by = $2";
    const r = await pool.query(
      `UPDATE tasks
         SET claimed_by = NULL, claimed_at = NULL, status = 'pending',
             history = history || jsonb_build_object('event','unclaim','by',$2,'at',now(),'reason',$3::text),
             updated_at = now()
       WHERE id = $1 AND ${guard}
       RETURNING id`,
      [a.id, a.claimer, a.reason ?? null],
    );
    return asText({ unclaimed: r.rowCount > 0 });
  }

  if (name === "update_task_step") {
    const a = args ?? {};
    if (!a.id || !a.step || !a.agent) throw new Error("id, step, agent are required");
    // Iteration bumps only on the ENTRY call (outcome null) for the 'dev' step.
    // Completion calls (outcome != null) carry the signature and never re-bump.
    const isEntry = a.outcome == null || a.outcome === "";
    const incIter = a.step === "dev" && isEntry ? 1 : 0;
    const r = await pool.query(
      `UPDATE tasks
         SET current_step = $2,
             iteration = iteration + $3,
             status = CASE WHEN $2 = 'done' THEN 'done' ELSE 'active' END,
             history = history || jsonb_build_object(
               'step', $2, 'iteration', iteration + $3, 'at', now(),
               'agent', $4::text, 'outcome', $5::text, 'report_ref', $6::text,
               'signature', $7::text, 'iter', $8::int
             ),
             updated_at = now()
       WHERE id = $1
       RETURNING current_step, iteration, status`,
      [
        a.id, a.step, incIter, a.agent,
        a.outcome ?? null, a.report_ref ?? null,
        a.signature ?? null, a.iter ?? null,
      ],
    );
    return asText({ updated: r.rows[0] ?? null });
  }

  if (name === "complete_task") {
    const a = args ?? {};
    if (!a.id) throw new Error("id is required");
    const r = await pool.query(
      `UPDATE tasks
         SET status = 'done', current_step = 'done', completed_at = now(),
             history = history || jsonb_build_object('event','completed','at',now(),'commit',$2::text),
             updated_at = now()
       WHERE id = $1
       RETURNING id, completed_at`,
      [a.id, a.commit_sha ?? null],
    );
    return asText({ completed: r.rows[0] ?? null });
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
