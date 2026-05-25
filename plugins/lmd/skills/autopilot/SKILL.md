---
name: autopilot
description: Drive a claimed task end-to-end through scouter → code-planner ⇄ plan-reviewer → developer ⇄ tester → reviewer ⇄ developer → committer, with hard iteration caps. All agent-to-agent context flows through files under `.lmd/autopilot/`; autopilot only handles short status payloads (file paths + signatures). Invoked automatically by claim-task after a successful claim, or by the user against an already-claimed task id (resume).
allowed-tools: Bash, Read, Write, Glob, Grep, mcp__brain__query, mcp__brain__find_paths, mcp__brain__get_settings, mcp__brain__claim_task, mcp__brain__update_task_step, mcp__brain__complete_task, mcp__brain__cancel_task
user-invocable: true
---

# autopilot

Runs in the main agent's context. The actual work happens in sub-agents (`scouter`, `code-planner`, `plan-reviewer`, `developer`, `tester`, `reviewer`, `committer`) the main agent spawns via the `Agent` tool. Autopilot is the loop controller — it never reads source code, never reads sub-agent report bodies (only their paths + 16-hex signatures), never mutates `nodes`/`edges`.

## File layout

Every artifact lives in `.lmd/autopilot/<agent>/`. Sub-agents read each other's files directly.

```
.lmd/autopilot/
├── scouter/<task_id>.md                            # one per task
├── code-planner/<task_id>-<plan_iter>.md           # one per plan iter
├── plan-reviewer/<task_id>-<plan_iter>.md          # one per plan review
├── plan-reviewer/<task_id>-<plan_iter>-devfeedback.md   # synth'd by autopilot on plan-insufficient
├── developer/<task_id>-<dev_iter>.md
├── tester/<task_id>-<dev_iter>.md
└── reviewer/<task_id>-<dev_iter>.md
```

## Args

```
/lmd:autopilot <task-id-or-prefix>
   [--plan-cap N]      # default 2
   [--dev-cap N]       # default 3
   [--review-cap N]    # default 2
   [--no-cap]          # disable all three caps
   [--keep-artifacts]  # skip Step 6 cleanup on done
```

Defaults are tuned to keep a worst-case run under ~150k tokens for typical
project sizes. Raise via `--*-cap` if you knowingly need more iterations.

## Concepts

**Two iteration counters**, both reconstructed from `task_events` on resume:

- `plan_iter` — `MAX(iter) WHERE step='plan' AND outcome IS NOT NULL` (orphan entries from crashes ignored).
- `dev_iter`  — `MAX(iter) WHERE step='dev'  AND outcome IS NOT NULL`. `tasks.iteration` mirrors this; bumped only on dev *completion* so a crash between entry+completion does not skip an iter.

**Caps** — autopilot bails to `blocked` on exhaust:

| Loop | Default | On exhaust |
|---|---|---|
| plan ⇄ plan-review | 2 | `kind:'plan_unresolved'` |
| dev ⇄ test          | 3 | `kind:'test_unresolved'` |
| review ⇄ dev        | 2 | `kind:'review_unresolved'` |
| committer           | 1 (fixed) | `kind:'commit_failed'` |
| file-not-found recovery | 3 per missing file | `kind:'recovery_exhausted'` |

**Stuck-loop detection** — each sub-agent returns a 16-hex `signature` (hash of its decision-bearing report sections). Autopilot keeps the last 3 per loop; if all three match → bail `stuck_<loop>_loop`.

**Two `update_task_step` calls per spawn**: an entry (`outcome:null`) and a completion (`outcome:<verdict>, signature, iter`). Entry never bumps `tasks.iteration`; dev-completion does. Crash between the two → resume re-runs the same iter (overwrites file, writes a fresh completion).

## Task ids contain `[scope]`

Task ids like `20260524-001-[lms]-fix-login` contain `[` and `]` — special in shell globs, PowerShell `-like`, and the `Glob` tool. **Never** match task ids via globs. Use literal string ops only: Bash `${var:0:N}` substring or `[ "$a" = "$b" ]`; PowerShell `.StartsWith()` / `.Substring()` / `-eq`; for the `Glob` tool, pattern the directory (`.lmd/autopilot/scouter/*`) and filter the returned list in memory.

## Preflight

### 0. System check (fresh start only)

```
r = Skill({ skill: 'check-system', args: '--check-only --tier blocking' })
```

If r's last line starts with `RESULT: FAIL` → exit, surface r verbatim. Skip this step on resume (`status='active' AND current_step IS NOT NULL`).

### 1. Resolve task + ownership

Resolve `task_id` from input (full id / unique prefix / 1-indexed entry from latest `list-tasks` output). Fetch task row.

- `done`/`cancelled` → no-op exit.
- `pending` → `mcp__brain__claim_task({id, claimer:<git user.email>})`. `claimed:false` → exit "claimed by someone else".
- `claimed`/`active` → require `claimed_by == git user.email`; mismatch → exit.

### 2. Ensure directories

Idempotently create `.lmd/autopilot/{scouter,code-planner,plan-reviewer,developer,tester,reviewer}/`. Bash: `mkdir -p` all six in one call. PowerShell: `New-Item -ItemType Directory -Force -Path <p>` per dir.

### 3. State defaults

```
plan_iter = dev_iter = review_iter = 0
plan_sigs = plan_review_sigs = dev_sigs = test_sigs = review_sigs = []
scout_file = approved_plan_file = last_dev_file = last_test_file = null
prior_plan_file = prior_plan_review_file = prior_test_file = pending_review_feedback_file = null
recovery_attempts = {}   # in-memory only; resets per /lmd:autopilot invocation
```

### 4. Hydrate (resume only)

Run these queries on `task_events` (all use `kind='step'`):

| Var | Query |
|---|---|
| `plan_iter`              | `MAX(iter) WHERE step='plan' AND outcome IS NOT NULL` (default 0) |
| `dev_iter`               | `MAX(iter) WHERE step='dev'  AND outcome IS NOT NULL` (default 0) |
| approved plan iter       | `MAX(iter) WHERE step='plan-review' AND outcome='pass'` |
| passed test iter         | `MAX(iter) WHERE step='test' AND outcome='pass'` — seeds `last_dev_file`/`last_test_file` |
| `prior_test_file`        | `report_ref` of latest `step='test' AND outcome='fail'` |
| `pending_review_feedback_file` | `report_ref` of latest `step='review' AND outcome='request-changes'` |
| `*_sigs` windows         | For each step, take 3 latest `signature` values; reverse to oldest-first |

`scout_file` = `.lmd/autopilot/scouter/<task_id>.md` if it exists on disk. `approved_plan_file` / `last_dev_file` / `last_test_file` are derived paths at their respective iters.

### 5. Pre-bail (resume only)

Any `*_sigs` window of length 3 with all entries identical → bail `stuck_<loop>_loop` immediately (don't waste another iteration). If `dev_iter >= dev_cap` (caps enabled) → bail `kind:'resumed_at_cap'`.

## Helpers (internal shorthand)

The loop pseudocode below uses these macros. They are not real tools — each expands to the call inline.

```
entry(step, iter, ref)         ::= mcp__brain__update_task_step({id:task_id, step, agent:'autopilot', outcome:null, report_ref:ref, iter})
done(step, iter, outcome, ref, sig?) ::= mcp__brain__update_task_step({id:task_id, step, agent:'autopilot', outcome, report_ref:ref, signature:sig, iter})
push(window, sig, kind, file) ::= window = (window+[sig]).slice(-3); IF length==3 AND all_equal(window): bail {kind, last_signature:sig, last_file:file}; EXIT
fnf(r)                         ::= handle_file_not_found(r)  -- see "File-not-found recovery"
cap(iter, n, kind, last_file) ::= IF cap_enabled AND iter > n: bail {kind, last_file}; EXIT
```

## Workflow

Dispatch on resume:

| `task.current_step` | GOTO |
|---|---|
| `null` / `scout`           | step0 |
| `plan` / `plan-review`     | step1_loop |
| `dev` / `test`             | step2_loop |
| `review`                   | step3_loop |
| `commit`                   | step4_commit |
| `done`                     | no-op exit |

### step0 — scout

```
entry('scout', null, ".lmd/autopilot/scouter/" + task_id + ".md")
r = Agent.spawn('scouter', { task_id })
IF r.status=='blocked':
  done('scout', null, 'blocked', r.file); bail {kind:'scout_blocked', notes:r.notes}; EXIT
done('scout', null, 'complete', r.file)
scout_file = r.file
FALL THROUGH to step1_loop
```

### step1_loop — plan ⇄ plan-review

```
LOOP:
  plan_iter += 1
  cap(plan_iter, plan_cap, 'plan_unresolved', prior_plan_review_file)

  # planner
  pref = ".lmd/autopilot/code-planner/" + task_id + "-" + plan_iter + ".md"
  entry('plan', plan_iter, pref)
  p = Agent.spawn('code-planner', {task_id, plan_iter, scout_file, prior_plan_file, prior_plan_review_file})

  IF p.reason=='file_not_found': fnf(p); plan_iter -= 1; CONTINUE
  IF p.status=='blocked':
    done('plan', plan_iter, 'blocked', p.file)
    IF p.reason=='scout-insufficient':
      sc = Agent.spawn('scouter', {task_id, extra_objective:p.detail}); scout_file = sc.file
      plan_iter -= 1; CONTINUE
    bail {kind:p.reason}; EXIT

  done('plan', plan_iter, 'complete', p.file, p.signature)
  push(plan_sigs, p.signature, 'stuck_plan_loop', p.file)

  # plan-reviewer
  prref = ".lmd/autopilot/plan-reviewer/" + task_id + "-" + plan_iter + ".md"
  entry('plan-review', plan_iter, prref)
  pr = Agent.spawn('plan-reviewer', {task_id, plan_iter, scout_file, plan_file:p.file})
  IF pr.reason=='file_not_found': fnf(pr); CONTINUE
  done('plan-review', plan_iter, pr.verdict, pr.file, pr.signature)

  IF pr.verdict=='pass':
    approved_plan_file = p.file; BREAK   # → step2_loop
  push(plan_review_sigs, pr.signature, 'stuck_plan_review_loop', pr.file)
  prior_plan_file = p.file; prior_plan_review_file = pr.file
```

### step2_loop — dev ⇄ test

```
LOOP:
  dev_iter += 1
  cap(dev_iter, dev_cap, 'test_unresolved', prior_test_file)

  # developer
  dref = ".lmd/autopilot/developer/" + task_id + "-" + dev_iter + ".md"
  entry('dev', dev_iter, dref)
  d = Agent.spawn('developer', {
    task_id, iter:dev_iter, scout_file, plan_file:approved_plan_file,
    prior_test_file, prior_review_file:pending_review_feedback_file
  })

  IF d.reason=='file_not_found': fnf(d); CONTINUE
  IF d.status=='blocked':
    done('dev', dev_iter, 'blocked', d.file)
    IF d.reason=='plan-insufficient':
      # Write a synthesized plan-review failure at .lmd/autopilot/plan-reviewer/<task_id>-<plan_iter>-devfeedback.md
      # containing one block-grade issue tagged [plan-insufficient] with d.detail, verdict: fail.
      synth = <path above>
      prior_plan_file = approved_plan_file; prior_plan_review_file = synth
      dev_iter -= 1
      dev_sigs = test_sigs = review_sigs = []     # fresh loops under the new plan
      pending_review_feedback_file = null
      GOTO step1_loop
    bail {kind:d.reason}; EXIT

  done('dev', dev_iter, 'complete', d.file, d.signature)   # bumps tasks.iteration
  push(dev_sigs, d.signature, 'stuck_dev_loop', d.file)

  # tester
  tref = ".lmd/autopilot/tester/" + task_id + "-" + dev_iter + ".md"
  entry('test', dev_iter, tref)
  t = Agent.spawn('tester', {task_id, iter:dev_iter, scout_file, dev_file:d.file})
  IF t.reason=='file_not_found': fnf(t); CONTINUE
  done('test', dev_iter, t.verdict, t.file, t.signature)

  IF t.verdict=='pass':
    last_dev_file = d.file; last_test_file = t.file; BREAK   # → step3_loop
  push(test_sigs, t.signature, 'stuck_test_loop', t.file)
  prior_test_file = t.file
  pending_review_feedback_file = null   # invalidate stale review feedback
```

### step3_loop — review ⇄ dev

```
review_iter = 0   # local; does NOT persist across plan re-runs
LOOP:
  review_iter += 1
  cap(review_iter, review_cap, 'review_unresolved', pending_review_feedback_file)

  rref = ".lmd/autopilot/reviewer/" + task_id + "-" + dev_iter + ".md"
  entry('review', dev_iter, rref)
  rv = Agent.spawn('reviewer', {task_id, iter:dev_iter, scout_file, dev_file:last_dev_file, test_file:last_test_file})
  IF rv.reason=='file_not_found': fnf(rv); CONTINUE
  done('review', dev_iter, rv.verdict, rv.file, rv.signature)

  IF rv.verdict=='approve': BREAK   # → step4_commit
  push(review_sigs, rv.signature, 'stuck_review_loop', rv.file)
  pending_review_feedback_file = rv.file
  prior_test_file = null            # tester ran against an older dev iter
  dev_sigs = []; test_sigs = []     # fresh dev/test cycle under reviewer feedback (review_sigs preserved)
  GOTO step2_loop                   # dev_cap NOT reset — protects against ping-pong
```

### step4_commit

```
entry('commit', null, last_dev_file)
c = Agent.spawn('committer', {task_id, final_dev_file:last_dev_file})
IF c.reason=='file_not_found': fnf(c); GOTO step4_commit
IF c.status=='failed':
  done('commit', null, 'failed', last_dev_file); bail {kind:'commit_failed', hook_output:c.hook_output}; EXIT
done('commit', null, 'success', c.sha)
FALL THROUGH to step5_done
```

### step5_done

```
mcp__brain__complete_task({id:task_id, commit_sha:c.sha})
terminal_state = 'done'
FALL THROUGH to step6_cleanup
```

### step6_cleanup (only on `terminal_state=='done'` AND not `--keep-artifacts`)

Delete only THIS task's artifact files (subdirs stay; parallel-session tasks untouched). Per sub-directory `scouter`/`code-planner`/`plan-reviewer`/`developer`/`tester`/`reviewer`:

1. `Glob` with a **generic** pattern (no task id embedded) — `.lmd/autopilot/<sub>/*`.
2. Filter the returned paths in memory: keep iff basename equals `<task_id>.md` OR starts with `<task_id>-` (literal string match — never glob; task id contains `[scope]`).
3. Delete each match: Bash `rm -f -- <path>` or PowerShell `Remove-Item -Force -LiteralPath <path>` (`-LiteralPath` disables wildcards).

After cleanup, file paths in the return report are informational only — no longer dereferenceable.

## File-not-found recovery

A sub-agent missing a required input returns `{status:'blocked', reason:'file_not_found', missing:<path>, need:<agent-name>}`.

`fnf(r)`:

```
recovery_attempts[r.missing] += 1
IF recovery_attempts[r.missing] > 3: bail {kind:'recovery_exhausted', missing, need}; EXIT
n = parse_iter_from_path(r.missing)   # null for scouter; else digits after task_id-

SWITCH r.need:
  scouter:       Agent.spawn('scouter',       {task_id})
  code-planner:  Agent.spawn('code-planner',  {task_id, plan_iter:n, scout_file})
  plan-reviewer: Agent.spawn('plan-reviewer', {task_id, plan_iter:n, scout_file,
                              plan_file:".lmd/autopilot/code-planner/"+task_id+"-"+n+".md"})
  developer:     Agent.spawn('developer',     {task_id, iter:n, scout_file, plan_file:approved_plan_file,
                              prior_test_file, prior_review_file:pending_review_feedback_file})
  tester:        Agent.spawn('tester',        {task_id, iter:n, scout_file,
                              dev_file:".lmd/autopilot/developer/"+task_id+"-"+n+".md"})
  reviewer:      Agent.spawn('reviewer',      {task_id, iter:n, scout_file,
                              dev_file:last_dev_file, test_file:last_test_file})
# Caller then re-spawns the original failing agent at its own iter.
```

`parse_iter_from_path(path)`: scouter paths have no iter — return `null`. Else strip the basename's leading `<task_id>-` prefix via literal substring (NEVER glob — `[scope]` is special); leading digits of the remainder are the iter (`3-devfeedback` → 3).

## Sub-agent return contracts

| Agent | Success payload | Notes |
|---|---|---|
| scouter        | `status, file, confidence, notes`             | No signature — never stuck-checked |
| code-planner   | `status, file, signature, reason?`            | reason: `file_not_found` / `scout-insufficient` / `ambiguous` |
| plan-reviewer  | `verdict (pass/fail), file, signature`        | |
| developer      | `status, file, signature, reason?, detail?`   | reason: `file_not_found` / `plan-insufficient` / `ambiguous` |
| tester         | `verdict (pass/fail), file, signature`        | |
| reviewer       | `verdict (approve/request-changes), file, signature` | |
| committer      | `status (success/failed), sha?, hook_output?` | No signature — cap=1 |

Any agent blocked by missing inputs returns the file_not_found shape instead; routed through `handle_file_not_found`.

## Cancellation

User Ctrl+C, or `task.status` flips to `cancelled` externally:

1. `mcp__brain__cancel_task({id:task_id, reason:'user-interrupt'})` — sets status + appends `cancel` row to `task_events` atomically.
2. Exit immediately; don't await the in-flight sub-agent.

Cancellation is final. Restart via `/lmd:unclaim-task` then `/lmd:claim-task`. `.lmd/autopilot/` files stay on disk (cleanup runs only on `done`).

## Invariants

- `claimed_by` never changes during an autopilot run; mismatch → bail.
- Each spawn writes **two** `task_events` rows: entry (`outcome IS NULL`), then completion (`outcome = <verdict>, signature = <hex>`).
- `tasks.iteration` increments only on dev-completion. Entry calls never bump.
- Resume reads only from `task_events` + on-disk existence checks; in-memory state is fully reconstructed.
- Autopilot's only writes under `.lmd/autopilot/`: the synthesized devfeedback plan-review file (plan-insufficient path) and the per-task deletes in step6.

## Output

```yaml
task_id, terminal_state (done | blocked | cancelled)
iterations: { plan, dev_test, review }      # this-session counts
scout_file, approved_plan_file, final_dev_file, final_test_file, final_review_file   # only fields that reached their step
commit_sha (if done), blockers (if blocked), duration_ms
```

When Step 6 ran, file paths are informational (files deleted).

## Forbidden

- Read sub-agent report bodies into main context (paths + signatures only).
- Do sub-agent work (write code/plans/reviews/tests/commits; mutate `nodes`/`edges`).
- Call `mcp__brain__execute` or call `claim_task` outside Preflight step 1.
- Bypass caps except via `--no-cap` (committer cap stays 1; recovery cap stays 3).
- Spawn sub-agents in parallel — sequential only.
- Embed the task id in any glob pattern (Bash globs, PowerShell `-like`, `Glob` tool). Literal string ops only.
