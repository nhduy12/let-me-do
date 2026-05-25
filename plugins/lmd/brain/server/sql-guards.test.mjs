// Unit tests for the brain SQL guards. Run with:
//   node --test sql-guards.test.mjs
//
// No external deps — the guards module is pure regex + string ops.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FORBIDDEN_RE,
  SELECT_START_RE,
  WRITE_START_RE,
  WRITE_KEYWORD_RE,
  stripStringsAndComments,
  ensureSingleStatement,
} from "./sql-guards.mjs";

// ===== stripStringsAndComments =====

test("strips single-quoted strings", () => {
  const out = stripStringsAndComments("SELECT label FROM nodes WHERE label = 'Create user'");
  assert.equal(out, "SELECT label FROM nodes WHERE label = ''");
});

test("strips '' escape inside single-quoted string", () => {
  const out = stripStringsAndComments("SELECT 'it''s fine'");
  assert.equal(out, "SELECT ''");
});

test("strips dollar-quoted strings", () => {
  const out = stripStringsAndComments("SELECT $tag$DROP TABLE secret$tag$ FROM x");
  assert.match(out, /SELECT '' FROM x/);
});

test("strips unnamed dollar-quoted strings", () => {
  const out = stripStringsAndComments("SELECT $$DELETE FROM users$$ AS s");
  assert.match(out, /SELECT '' AS s/);
});

test("strips line comments", () => {
  const out = stripStringsAndComments("SELECT 1 -- DROP TABLE x\nFROM y");
  assert.equal(out.replace(/\s+/g, " ").trim(), "SELECT 1 FROM y");
});

test("strips block comments (multiline)", () => {
  const out = stripStringsAndComments("SELECT 1 /* DELETE FROM users\nGRANT ALL */ FROM y");
  assert.equal(out.replace(/\s+/g, " ").trim(), "SELECT 1 FROM y");
});

test("strips double-quoted identifiers", () => {
  const out = stripStringsAndComments('SELECT "drop column" FROM "users"');
  assert.equal(out, 'SELECT "" FROM ""');
});

// ===== ensureSingleStatement =====

test("accepts trailing semicolon", () => {
  assert.equal(ensureSingleStatement("SELECT 1;"), "SELECT 1");
});

test("accepts no semicolon", () => {
  assert.equal(ensureSingleStatement("SELECT 1"), "SELECT 1");
});

test("rejects two statements", () => {
  assert.throws(
    () => ensureSingleStatement("SELECT 1; SELECT 2"),
    /single SQL statement/,
  );
});

test("rejects smuggled DROP after semicolon", () => {
  assert.throws(
    () => ensureSingleStatement("SELECT 1; DROP TABLE users"),
    /single SQL statement/,
  );
});

test("allows semicolon inside string literal", () => {
  assert.equal(
    ensureSingleStatement("SELECT 'a;b'"),
    "SELECT 'a;b'",
  );
});

test("allows semicolon inside line comment", () => {
  assert.equal(
    ensureSingleStatement("SELECT 1 -- ; trailing comment"),
    "SELECT 1 -- ; trailing comment",
  );
});

// ===== SELECT_START_RE / WRITE_START_RE =====

test("SELECT_START_RE accepts SELECT and WITH", () => {
  assert.ok(SELECT_START_RE.test("SELECT 1"));
  assert.ok(SELECT_START_RE.test("  select 1"));
  assert.ok(SELECT_START_RE.test("WITH x AS (SELECT 1) SELECT * FROM x"));
});

test("SELECT_START_RE rejects writes", () => {
  assert.ok(!SELECT_START_RE.test("INSERT INTO x VALUES (1)"));
  assert.ok(!SELECT_START_RE.test("UPDATE x SET y = 1"));
});

test("WRITE_START_RE accepts INSERT/UPDATE/DELETE/WITH", () => {
  assert.ok(WRITE_START_RE.test("INSERT INTO x VALUES (1)"));
  assert.ok(WRITE_START_RE.test("UPDATE x SET y = 1"));
  assert.ok(WRITE_START_RE.test("DELETE FROM x"));
  assert.ok(WRITE_START_RE.test("WITH d AS (DELETE FROM x RETURNING *) INSERT INTO y SELECT * FROM d"));
});

test("WRITE_START_RE rejects bare SELECT", () => {
  assert.ok(!WRITE_START_RE.test("SELECT 1"));
});

// ===== FORBIDDEN_RE — positives =====

test("FORBIDDEN_RE blocks DROP at start", () => {
  assert.ok(FORBIDDEN_RE.test("DROP TABLE users"));
});

test("FORBIDDEN_RE blocks ALTER at start", () => {
  assert.ok(FORBIDDEN_RE.test("ALTER TABLE x ADD COLUMN y INT"));
});

test("FORBIDDEN_RE blocks CREATE at start", () => {
  assert.ok(FORBIDDEN_RE.test("CREATE TABLE x (id INT)"));
});

test("FORBIDDEN_RE blocks GRANT / REVOKE / TRUNCATE at start", () => {
  assert.ok(FORBIDDEN_RE.test("GRANT ALL ON x TO y"));
  assert.ok(FORBIDDEN_RE.test("REVOKE ALL ON x FROM y"));
  assert.ok(FORBIDDEN_RE.test("TRUNCATE x"));
});

test("FORBIDDEN_RE blocks SET ROLE / RESET ROLE", () => {
  assert.ok(FORBIDDEN_RE.test("SET ROLE postgres"));
  assert.ok(FORBIDDEN_RE.test("RESET ROLE"));
});

test("FORBIDDEN_RE blocks LISTEN / NOTIFY / LOAD / DO / CALL at start", () => {
  assert.ok(FORBIDDEN_RE.test("LISTEN x"));
  assert.ok(FORBIDDEN_RE.test("NOTIFY x, 'msg'"));
  assert.ok(FORBIDDEN_RE.test("LOAD 'libname'"));
  assert.ok(FORBIDDEN_RE.test("DO $$ BEGIN ... END $$"));
  assert.ok(FORBIDDEN_RE.test("CALL myproc()"));
});

test("FORBIDDEN_RE blocks DROP smuggled inside writable CTE", () => {
  // attacker tries: WITH x AS (DROP TABLE y) SELECT 1
  assert.ok(FORBIDDEN_RE.test("WITH x AS (DROP TABLE y) SELECT 1"));
});

test("FORBIDDEN_RE blocks after semicolon (multi-statement smuggling)", () => {
  assert.ok(FORBIDDEN_RE.test("SELECT 1; DROP TABLE users"));
});

// ===== FORBIDDEN_RE — negatives (no false positives) =====

test("FORBIDDEN_RE allows bare 'do' as identifier", () => {
  assert.ok(!FORBIDDEN_RE.test("SELECT do FROM jobs"));
});

test("FORBIDDEN_RE allows bare 'load' as identifier", () => {
  assert.ok(!FORBIDDEN_RE.test("SELECT load FROM metrics"));
});

test("FORBIDDEN_RE allows bare 'call' as identifier", () => {
  assert.ok(!FORBIDDEN_RE.test("SELECT call FROM events"));
});

test("FORBIDDEN_RE allows bare 'copy' as identifier", () => {
  assert.ok(!FORBIDDEN_RE.test("SELECT copy FROM docs"));
});

test("FORBIDDEN_RE allows 'CREATE' inside a string literal (after strip)", () => {
  const scrubbed = stripStringsAndComments("SELECT label FROM nodes WHERE label = 'Create user'");
  assert.ok(!FORBIDDEN_RE.test(scrubbed));
});

test("FORBIDDEN_RE allows column names like update_status", () => {
  // word-boundary guards against substring matches; this is included for completeness.
  assert.ok(!FORBIDDEN_RE.test("SELECT update_status FROM tasks"));
});

// ===== WRITE_KEYWORD_RE =====

test("WRITE_KEYWORD_RE flags writeable CTE body", () => {
  assert.ok(WRITE_KEYWORD_RE.test("WITH d AS (DELETE FROM x) SELECT * FROM d"));
  assert.ok(WRITE_KEYWORD_RE.test("WITH i AS (INSERT INTO x VALUES (1) RETURNING *) SELECT * FROM i"));
});

test("WRITE_KEYWORD_RE does NOT flag bare identifiers", () => {
  assert.ok(!WRITE_KEYWORD_RE.test("SELECT update FROM x"));
  assert.ok(!WRITE_KEYWORD_RE.test("SELECT delete FROM trash"));
  assert.ok(!WRITE_KEYWORD_RE.test("SELECT insert FROM logs"));
});

test("WRITE_KEYWORD_RE flags top-level write", () => {
  assert.ok(WRITE_KEYWORD_RE.test("INSERT INTO x VALUES (1)"));
  assert.ok(WRITE_KEYWORD_RE.test("UPDATE x SET y = 1"));
  assert.ok(WRITE_KEYWORD_RE.test("DELETE FROM x"));
});

// ===== Integration-shape sanity =====

test("benign read with identifier collisions passes full guard chain", () => {
  const sql = "SELECT do, load, call, copy FROM ops WHERE label = 'Create me'";
  const scrubbed = stripStringsAndComments(ensureSingleStatement(sql));
  assert.ok(SELECT_START_RE.test(scrubbed));
  assert.ok(!FORBIDDEN_RE.test(scrubbed));
  assert.ok(!WRITE_KEYWORD_RE.test(scrubbed));
});

test("smuggled DDL caught by full guard chain", () => {
  const sql = "SELECT 1; DROP TABLE users";
  assert.throws(() => ensureSingleStatement(sql), /single SQL statement/);
});

test("writable CTE caught", () => {
  const sql = "WITH d AS (DELETE FROM users WHERE id = 1 RETURNING *) SELECT * FROM d";
  const scrubbed = stripStringsAndComments(sql);
  // Starts with WITH so SELECT_START_RE passes — but WRITE_KEYWORD_RE must catch it.
  assert.ok(SELECT_START_RE.test(scrubbed));
  assert.ok(WRITE_KEYWORD_RE.test(scrubbed));
});
