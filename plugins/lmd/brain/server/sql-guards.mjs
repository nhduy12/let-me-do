// SQL safety guards for the brain MCP server. Pure functions, no Node deps —
// safe to import from tests without booting the MCP transport or Postgres pool.
//
// Threat model: an LLM agent composes SQL and submits it via the `query` or
// `execute` tool. We want to:
//   1. Reject DDL / privilege / replication / utility statements (FORBIDDEN_RE).
//   2. Restrict the `query` tool to read-only shapes (SELECT or WITH ... SELECT).
//   3. Restrict the `execute` tool to write statements only (INSERT/UPDATE/DELETE
//      or writeable WITH).
//   4. Refuse multi-statement payloads (semicolon smuggling).
//
// All regex checks run on a "scrubbed" copy of the SQL where strings, dollar-
// quoted blocks, quoted identifiers, and comments have been replaced with
// inert placeholders. That keeps a benign `WHERE label = 'Create user'` from
// tripping the CREATE rule.
//
// Forbidden-command and write-keyword detection both anchor to "statement
// positions" — start of input, after `;`, or after `(`. Without this anchor,
// schemas that legitimately use words like `do`, `load`, `call`, `copy`,
// `cluster`, `drop`, `update` as identifiers ('SELECT do FROM jobs', 'SELECT
// update_col FROM ...') would be rejected. The anchor catches the real attack
// surface (a writeable CTE body like `WITH x AS (DELETE FROM y ...)`) while
// letting bare identifiers through.
//
// SECURITY is intentionally NOT in the forbidden list — it is only a modifier
// of CREATE FUNCTION (e.g. `SECURITY DEFINER`), and CREATE is already blocked.

export const FORBIDDEN_RE =
  /(?:^|[;(])\s*(?:DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER|COPY|SET\s+ROLE|RESET\s+ROLE|LISTEN|NOTIFY|LOAD|DO|CALL)\b/i;

export const SELECT_START_RE = /^\s*(SELECT|WITH)\b/i;
export const WRITE_START_RE = /^\s*(INSERT|UPDATE|DELETE|WITH)\b/i;
export const WRITE_KEYWORD_RE =
  /(?:^|[;(])\s*(?:INSERT|UPDATE|DELETE)\b/i;

export function stripStringsAndComments(sql) {
  let out = sql;
  out = out.replace(/--[^\n]*/g, "");
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''");
  out = out.replace(/'(?:[^']|'')*'/g, "''");
  out = out.replace(/"(?:[^"]|"")*"/g, '""');
  return out;
}

export function ensureSingleStatement(sql) {
  const trimmed = sql.replace(/;\s*$/, "").trim();
  if (stripStringsAndComments(trimmed).includes(";")) {
    throw new Error("Only a single SQL statement per call is allowed");
  }
  return trimmed;
}
