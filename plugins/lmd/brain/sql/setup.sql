-- let-me-do / brain — DB + role + schema setup
--
-- Run once when installing the plugin for a new project.
--
-- Usage:
--   psql -U <superuser> -h <host> \
--     -v db_name=brain_my_project \
--     -v ai_pwd='<SET_PASSWORD>' \
--     -f setup.sql
--
-- Notes:
--   - `db_name`: name of the new database (use a dedicated DB per project).
--   - `ai_pwd`: password for the ai_agent role (the role is created if missing).
--   - psql substitutes :"db_name" -> quoted identifier, :'ai_pwd' -> string literal.
--   - The CREATE DATABASE / CREATE ROLE block runs in the bootstrap DB (e.g. `postgres`);
--     GRANTs and schema setup run after `\c :"db_name"`.

\set ON_ERROR_STOP on

-- ====== PART 1: Create DB + role (idempotent) ======

SELECT format('CREATE DATABASE %I', :'db_name') AS cmd
\gexec

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ai_agent') THEN
    EXECUTE format('CREATE ROLE ai_agent WITH LOGIN PASSWORD %L', :'ai_pwd');
  ELSE
    EXECUTE format('ALTER ROLE ai_agent WITH PASSWORD %L', :'ai_pwd');
  END IF;
END
$$;

-- ====== PART 2: GRANT in the new DB ======

\c :"db_name"

GRANT CONNECT ON DATABASE :"db_name" TO ai_agent;
GRANT USAGE, CREATE ON SCHEMA public TO ai_agent;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ai_agent;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ai_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ai_agent;

-- ====== PART 3: nodes + edges schema ======

BEGIN;

CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  app           TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'page',
  url           TEXT,
  mounted_on    TEXT REFERENCES nodes(id),
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

CREATE INDEX IF NOT EXISTS nodes_actions_gin
  ON nodes USING GIN (actions);

CREATE INDEX IF NOT EXISTS nodes_fts
  ON nodes USING GIN (
    to_tsvector('simple', label || ' ' || COALESCE(description, ''))
  );

CREATE INDEX IF NOT EXISTS nodes_app ON nodes (app);
CREATE INDEX IF NOT EXISTS nodes_grp ON nodes (grp);
CREATE INDEX IF NOT EXISTS edges_src ON edges (source);
CREATE INDEX IF NOT EXISTS edges_tgt ON edges (target);

ALTER TABLE nodes OWNER TO ai_agent;
ALTER TABLE edges OWNER TO ai_agent;

COMMIT;

-- ====== PART 4: Helper SQL function for path traversal ======

CREATE OR REPLACE FUNCTION find_paths(
  src       TEXT,
  tgt       TEXT,
  max_depth INT DEFAULT 4
) RETURNS TABLE(path TEXT[], steps TEXT[], depth INT)
LANGUAGE sql STABLE AS $$
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
$$;

ALTER FUNCTION find_paths(TEXT, TEXT, INT) OWNER TO ai_agent;
GRANT EXECUTE ON FUNCTION find_paths(TEXT, TEXT, INT) TO ai_agent;

-- ====== PART 5: Tasks region (workflow state) ======
-- Stores cross-developer tasks the lmd agent team picks up and processes.
-- People identity is the git user.email of whoever invoked the skill.

BEGIN;

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  summary             TEXT,
  type                TEXT,                              -- feature / fix / refactor / chore / docs
  status              TEXT NOT NULL DEFAULT 'pending',   -- pending / claimed / active / done / blocked / cancelled

  created_by          TEXT NOT NULL,                     -- git user.email of creator
  assigned_to         TEXT,                              -- git user.email or NULL (open pool)
  claimed_by          TEXT,                              -- git user.email of current owner
  claimed_at          TIMESTAMPTZ,

  current_step        TEXT,                              -- dev / test / review / commit / done
  iteration           INT NOT NULL DEFAULT 0,

  acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  related_node_ids    JSONB NOT NULL DEFAULT '[]',
  history             JSONB NOT NULL DEFAULT '[]',       -- append-only audit of step transitions
  blockers            JSONB NOT NULL DEFAULT '[]',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS tasks_status_idx
  ON tasks (status);

CREATE INDEX IF NOT EXISTS tasks_assigned_idx
  ON tasks (assigned_to)
  WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_claimed_idx
  ON tasks (claimed_by)
  WHERE claimed_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS tasks_created_at_idx
  ON tasks (created_at DESC);

CREATE INDEX IF NOT EXISTS tasks_fts
  ON tasks USING GIN (
    to_tsvector('simple', title || ' ' || COALESCE(summary, ''))
  );

ALTER TABLE tasks OWNER TO ai_agent;

COMMIT;
