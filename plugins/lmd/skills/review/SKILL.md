---
name: review
description: Run reviewer against the current diff. Reviews code style, conventions, security, and brain consistency. Returns approve or request-changes with structured feedback. Use this for standalone review outside the brief→autopilot workflow.
allowed-tools: Read, Write, Glob, Grep, Bash, mcp__brain__query, mcp__brain__find_paths, mcp__brain__get_settings
user-invocable: true
---

# review

Thin wrapper around the `reviewer` agent for standalone code review (no autopilot pipeline).

**When useful**: chunk finished, want another opinion before commit/PR; pre-PR sanity; CI gate.

## Workflow

1. Parse args:
   - `--diff <ref>` — review a specific diff range. Default: working tree vs `HEAD`.
   - `--task <id>` — pull task context so reviewer knows intended scope.
   - `--strict` — flip style nits from `info` to `warn` (still doesn't block; only substantive issues block).
   - `--save-feedback` — persist review report path in the task record.
2. Prepare ad-hoc artifacts:
   - `mkdir -p .lmd/autopilot/{scouter,developer,tester}`.
   - Reuse `.lmd/autopilot/scouter/<task_id>.md` if present, else write a minimal placeholder.
   - Pick `adhoc_iter` as a numeric unix timestamp.
   - Write a synthetic dev report at `.lmd/autopilot/developer/<task_id>-<adhoc_iter>.md` (`git diff --stat` + 2-line summary).
   - Write a pseudo "test passed" file at `.lmd/autopilot/tester/<task_id>-<adhoc_iter>.md` (reviewer refuses otherwise). Note in the file that no real QA ran.
3. Spawn `reviewer` with `task_id`, `iter: <adhoc_iter>`, `scout_file`, `dev_file`, `test_file`. Convention sources auto-detected: root `CLAUDE.md` + nested + `.claude/rules/*.md`.
4. Relay verdict:
   - `approve` + brief comment.
   - `request-changes` + structured issue list (file:line + suggestion). Block-grade = security, correctness, CLAUDE.md violations, brain inconsistency. Style nits never block.

Personal disagreement with a documented convention surfaces as `info`. Project convention wins.

## Args

```
/lmd:review                       # working tree
/lmd:review --diff HEAD~3..HEAD   # last 3 commits
/lmd:review --task <id> --strict
/lmd:review --save-feedback
```

## Forbidden

- Verify behavior (use `/lmd:qa`).
- Change code (user applies fixes).
- Commit or push.

## Output

- Verdict (approve / request-changes).
- Issues with severity (info / warn / block).
- Brain consistency report (orphan edges, missing nodes).
