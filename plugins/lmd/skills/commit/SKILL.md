---
name: commit
description: Stage and commit current changes with a meaningful message derived from a task or from the diff itself. Wrapper around committer for ad-hoc commits outside the brief→autopilot workflow.
allowed-tools: Bash, Read, Write, mcp__brain__query, mcp__brain__get_settings
user-invocable: true
---

# commit

> *"Wrap it up and commit — no pushing."*

Thin wrapper around the `committer` agent. User-invoked when the dev wants a smart commit without going through the full workflow.

## When useful

- Dev finished a chunk manually, wants a clean, well-messaged commit.
- After running `/lmd:qa` and `/lmd:review` standalone — finish with `/lmd:commit`.
- Quick housekeeping commits (chore / refactor / docs).

## Workflow

1. **Parse args** from `$ARGUMENTS`:
   - `--task <id>` — pull task context to compose subject + body.
   - `--type <feat|fix|refactor|chore|docs|test>` — conventional-commit type. Required when the project's `CLAUDE.md` mandates conventional commits (auto-detect from `## Git Commit Rules` / `## Commit Convention` sections). Otherwise the commit message is freeform.
   - `--message <text>` — override auto-generated message.
   - `--dry-run` — print the staged files + proposed message, don't commit.
2. **Resolve final dev report file** for committer's `final_dev_file` input:
   - Ensure `.lmd/autopilot/developer/` exists (`mkdir -p`).
   - If `--task <id>` is given, use the latest `.lmd/autopilot/developer/<task_id>-<iter>.md` on disk (pick by max numeric iter).
   - If no task or no dev report exists, write a synthetic one at `.lmd/autopilot/developer/<task_id_or_'adhoc'>-<unix_ts>.md` (the trailing numeric is required so the path stays parseable). Body: working-tree diff (`git diff --stat`) + a 2-line description. Committer reads this as the commit message source.
3. **Stage changes** — if nothing is currently staged, stage every modified + untracked file not matched by `.gitignore`. No prompt.
4. **Spawn `committer` agent** with `task_id`, `final_dev_file`, and optional `commit_type`. One commit per invocation — unrelated changes go into the body as notes; never split.
5. **Relay** the commit hash (or failure reason) to the user. On pre-commit hook failure: never auto-fix; return error with hook output.

## What this skill does NOT do

- **Does NOT `git push`** — push is always a human call.
- **Does NOT open a PR** — same.
- **Does NOT amend** — always a new commit.
- **Does NOT skip hooks** (`--no-verify`).
- **Does NOT add `Co-Authored-By` trailers** unless project convention explicitly requires.

## Args

```
/lmd:commit                              # auto-compose from working tree
/lmd:commit --task <id>                  # use task as message source
/lmd:commit --type feat                  # conventional-commit prefix
/lmd:commit --message "fix login redirect"  # override subject
/lmd:commit --dry-run                    # preview, don't commit
```

## Output

- Commit hash on success.
- On failure: hook output (lint / type-check), staged file list, what to fix.
