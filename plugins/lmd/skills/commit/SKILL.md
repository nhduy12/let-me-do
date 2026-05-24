---
name: commit
description: Stage and commit current changes with a meaningful message derived from a task or from the diff itself. Wrapper around committer for ad-hoc commits outside the brief→autopilot workflow.
allowed-tools: Bash, Read, Write, mcp__brain__query, mcp__brain__get_settings
user-invocable: true
---

# commit

Thin wrapper around the `committer` agent for ad-hoc commits (no autopilot pipeline).

**When useful**: dev finished a chunk manually; after standalone `/lmd:qa` + `/lmd:review`; quick chore / refactor / docs commits.

## Workflow

1. Parse args:
   - `--task <id>` — pull task context for subject + body.
   - `--type <feat|fix|refactor|chore|docs|test>` — conventional-commit type. Required when project's `CLAUDE.md` mandates conventional commits (auto-detect from `## Git Commit Rules` / `## Commit Convention` sections); otherwise message is freeform.
   - `--message <text>` — override auto-generated message.
   - `--dry-run` — print staged files + proposed message, don't commit.
2. Resolve `final_dev_file` for committer:
   - `mkdir -p .lmd/autopilot/developer`.
   - With `--task <id>`: pick latest `.lmd/autopilot/developer/<task_id>-<iter>.md` (max numeric iter).
   - No task / no dev report: write a synthetic one at `.lmd/autopilot/developer/<task_id_or_'adhoc'>-<unix_ts>.md` (numeric suffix required for parseability). Body: `git diff --stat` + 2-line description.
3. Stage: if nothing currently staged, stage every modified + untracked file not matched by `.gitignore`. No prompt.
4. Spawn `committer` with `task_id`, `final_dev_file`, optional `commit_type`. One commit per invocation — unrelated changes go into the body as notes; never split.
5. Relay commit hash (or failure reason). Pre-commit hook failure → never auto-fix; return hook output.

## Args

```
/lmd:commit                                  # auto-compose from working tree
/lmd:commit --task <id>                      # use task as message source
/lmd:commit --type feat                      # conventional-commit prefix
/lmd:commit --message "fix login redirect"   # override subject
/lmd:commit --dry-run                        # preview, don't commit
```

## Forbidden

- `git push` (human call).
- Open a PR (same).
- `git commit --amend` (always new commits).
- `--no-verify` (never bypass hooks).
- Add `Co-Authored-By` trailers unless project convention requires.

## Output

- Commit hash on success.
- On failure: hook output (lint / type-check), staged file list, what to fix.
