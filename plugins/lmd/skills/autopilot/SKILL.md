---
name: autopilot
description: Drive a claimed task end-to-end through scouter → code-planner ⇄ plan-reviewer → developer ⇄ tester → reviewer ⇄ developer → committer, with hard iteration caps. All agent-to-agent context flows through files under `.lmd/autopilot/`; autopilot only handles short status payloads (file paths + signatures). Invoked automatically by claim-task after a successful claim, or by the user against an already-claimed task id (resume).
allowed-tools: Bash, Read, Write, Glob, Grep, mcp__brain__query, mcp__brain__find_paths, mcp__brain__get_settings, mcp__brain__claim_task, mcp__brain__update_task_step, mcp__brain__complete_task, mcp__brain__cancel_task
user-invocable: true
---

# autopilot

Runs in the main agent's context. The skill is a recipe the main agent follows; the actual work happens in the scouter / code-planner / plan-reviewer / developer / tester / reviewer / committer subagents the main agent spawns via the Agent tool.

## File-based agent communication

To keep the main (autopilot) context small, every detailed artifact lives in a file under `.lmd/autopilot/<agent-name>/`. Autopilot only holds short status payloads (file path + 16-hex signature + 1-line note). Sub-agents read each other's files directly without going through autopilot.

```
<repo-root>/.lmd/autopilot/
├── scouter/<task_id>.md                       # one per task — scouter
├── code-planner/<task_id>-<plan_iter>.md      # one per plan iteration — code-planner
├── plan-reviewer/<task_id>-<plan_iter>.md     # one per plan review — plan-reviewer
├── plan-reviewer/<task_id>-<plan_iter>-devfeedback.md   # synthesized by autopilot on plan-insufficient
├── developer/<task_id>-<dev_iter>.md          # one per dev iteration — developer
├── tester/<task_id>-<dev_iter>.md             # one per test, paired with same dev_iter — tester
└── reviewer/<task_id>-<dev_iter>.md           # one per review, paired with same dev_iter — reviewer
```

Two independent iteration counters, both reconstructed from `task_events` on resume:
- **`plan_iter`** — max `iter` value among `task_events` rows where `kind='step' AND step='plan' AND outcome IS NOT NULL` (0 if none). Entry-only events from crashed iterations are ignored.
- **`dev_iter`** — max `iter` value among `task_events` rows where `kind='step' AND step='dev' AND outcome IS NOT NULL` (0 if none). `tasks.iteration` mirrors this but is only bumped at dev-step completion, so a crash between entry and completion does not skip an iter.

## Task ids contain `[scope]`

Task ids like `20260524-001-[lms]-fix-login` contain `[` and `]`, which are special in shell glob patterns. **Never** use unquoted globs against task ids. Inside Bash, always loop with literal string comparison (`[ "$a" = "$b" ]` or `${var:0:N}` substring), never `case`/`[[ ]]` glob matching against ids.

## When invoked

- **Automatically by `claim-task`** after a successful claim (default behavior unless `--no-start`).
- **Directly by the user** to resume an already-claimed but unfinished task:
  ```
  /lmd:autopilot <task-id>
  ```
- **By an outer batch loop** (main agent processing many tasks in sequence).

## Args

```
/lmd:autopilot <task-id-or-prefix>
   [--plan-cap <N>]       # max plan ⇄ plan-review iterations, default 3
   [--dev-cap <N>]        # max dev ⇄ test iterations, default 5
   [--review-cap <N>]     # max review ⇄ dev cycles, default 3
   [--no-cap]             # remove plan-cap, dev-cap, AND review-cap (set-goal-and-leave)
   [--keep-artifacts]     # skip Step 6 cleanup on done — preserve all .lmd/autopilot/<task_id>* files
```

## Preflight (always runs)

Steps below run sequentially before the workflow starts. They make fresh-start and resume produce the same hydrated in-memory state — workflow steps below contain no initialization, only loop logic.

### 1. Resolve task and ownership

- Resolve `task_id` from input (full id, prefix, or 1-indexed entry from latest `list-tasks` output).
- Fetch task row from brain. If not found → exit with error.
- Status branching:
  - `done` / `cancelled` → no-op exit.
  - `pending` → self-claim via `mcp__brain__claim_task({ id, claimer: <git user.email> })`. If `claimed: false` → exit "claimed by someone else".
  - `claimed` / `active` → require `claimed_by == git user.email`. Mismatch → exit.

### 2. Ensure directories

```bash
mkdir -p .lmd/autopilot/scouter .lmd/autopilot/code-planner .lmd/autopilot/plan-reviewer \
         .lmd/autopilot/developer .lmd/autopilot/tester .lmd/autopilot/reviewer
```

### 3. Initialize state to defaults

```
# Counters
plan_iter = 0
dev_iter  = 0
review_iter = 0

# Sliding windows for stuck-loop detection
plan_sigs = []
plan_review_sigs = []
dev_sigs = []
test_sigs = []
review_sigs = []

# File references (paths only, never content)
scout_file = null
approved_plan_file = null
last_dev_file = null
last_test_file = null
prior_plan_file = null
prior_plan_review_file = null
prior_test_file = null
pending_review_feedback_file = null

# Recovery counter (in-memory only; resets on each /lmd:autopilot invocation)
recovery_attempts = {}
```

### 4. Hydrate from task_events (only when resuming)

Resuming means `task.status == 'active'` AND `task.current_step IS NOT NULL`. Skip this entire step on fresh start.

All queries read from `task_events`. Critically, `plan_iter` and `dev_iter` derive from **completed** events only (`outcome IS NOT NULL`). An orphan entry-only event from a crashed iteration must not count — otherwise resume would bump past the crashed iter and skip a number.

```sql
-- Query A: latest completed plan_iter (entries without a matching completion are ignored)
SELECT COALESCE(MAX(iter), 0) AS max_iter
FROM task_events
WHERE task_id = $1
  AND kind = 'step'
  AND step = 'plan'
  AND outcome IS NOT NULL;

-- Query B: signatures per loop step, newest first (autopilot picks first 3 per step)
SELECT step, signature, iter, created_at
FROM task_events
WHERE task_id = $1
  AND kind = 'step'
  AND signature IS NOT NULL
ORDER BY created_at DESC;

-- Query C: latest approved plan_iter
SELECT MAX(iter) AS iter
FROM task_events
WHERE task_id = $1
  AND kind = 'step'
  AND step = 'plan-review'
  AND outcome = 'pass';

-- Query D: latest passed test iter (this is also the latest matching dev_iter for last_dev_file)
SELECT MAX(iter) AS iter
FROM task_events
WHERE task_id = $1
  AND kind = 'step'
  AND step = 'test'
  AND outcome = 'pass';

-- Query D2: latest completed dev_iter — protects against crashes between
-- dev-entry and dev-completion. Used to seed local dev_iter.
SELECT COALESCE(MAX(iter), 0) AS max_iter
FROM task_events
WHERE task_id = $1
  AND kind = 'step'
  AND step = 'dev'
  AND outcome IS NOT NULL;

-- Query E: latest failed test (for prior_test_file on resume at dev step)
SELECT report_ref AS file
FROM task_events
WHERE task_id = $1
  AND kind = 'step'
  AND step = 'test'
  AND outcome = 'fail'
ORDER BY created_at DESC
LIMIT 1;

-- Query F: latest review request-changes (for pending_review_feedback_file on resume at dev step)
SELECT report_ref AS file
FROM task_events
WHERE task_id = $1
  AND kind = 'step'
  AND step = 'review'
  AND outcome = 'request-changes'
ORDER BY created_at DESC
LIMIT 1;
```

Apply results:

```
plan_iter = Query A result      # latest plan iter that COMPLETED
dev_iter  = Query D2 result     # latest dev iter that COMPLETED (NOT task.iteration — that may have been bumped without a completion if the bump rule changes; D2 is authoritative)

# Hydrate signature windows (newest 3 per step, ordered ASC after slicing)
For each step in [plan, plan-review, dev, test, review]:
  rows = Query B filtered to that step, take first 3
  loop_sigs = reverse(rows)   # oldest-first

scout_file = ".lmd/autopilot/scouter/" + task_id + ".md" if file exists on disk, else null
approved_plan_file = if Query C returned N: ".lmd/autopilot/code-planner/" + task_id + "-" + N + ".md", else null
last_test_iter = Query D result
last_dev_file  = if last_test_iter set: ".lmd/autopilot/developer/" + task_id + "-" + last_test_iter + ".md", else null
last_test_file = if last_test_iter set: ".lmd/autopilot/tester/"    + task_id + "-" + last_test_iter + ".md", else null
prior_test_file = Query E result (or null)
pending_review_feedback_file = Query F result (or null)
```

### 5. Pre-bail check (only when resuming)

For each loop window that has length == 3 AND all entries identical → bail immediately with the matching `stuck_*_loop` kind. This catches "we were 1 iter past the stuck threshold when we crashed" without wasting another cycle.

Also: if `dev_iter >= dev_cap` (with caps enabled) at resume time → bail with `kind='resumed_at_cap'`.

## Iteration caps

| Loop | Default cap | Override | On exhaust |
|---|---|---|---|
| plan ⇄ plan-review | **3** | `--plan-cap N`, `--no-cap` | `blocked` + `{kind:'plan_unresolved', last_plan_review_file}` |
| dev ⇄ tester | **5** | `--dev-cap N`, `--no-cap` | `blocked` + `{kind:'test_unresolved', last_test_file}` |
| review ⇄ dev | **3** | `--review-cap N`, `--no-cap` | `blocked` + `{kind:'review_unresolved', last_review_file}` |
| committer | **1** (always) | — | `blocked` + `{kind:'commit_failed', hook_output}` |
| file-not-found recovery | **3** per missing file | — | `blocked` + `{kind:'recovery_exhausted', missing, need}` |

## Stuck-loop detection (always on)

Each sub-agent returns a 16-hex `signature`. Autopilot keeps the last 3 per loop, compares `all_equal` after each completion. On match → bail with `{kind:'stuck_<loop>_loop', last_signature, last_file}`.

## File-not-found recovery

Any sub-agent that finds a required input missing returns:

```yaml
status: blocked
reason: file_not_found
missing: <path>
need: scouter | code-planner | plan-reviewer | developer | tester | reviewer
```

Autopilot owns recovery. The recovery handler is invoked uniformly after every sub-agent return:

```
handle_file_not_found(result):
  key = result.missing
  recovery_attempts[key] = (recovery_attempts[key] or 0) + 1
  IF recovery_attempts[key] > 3:
    bail to blocked (kind='recovery_exhausted', missing=key, need=result.need)
    EXIT

  miss_iter = extract_iter(result.missing)   # see helper below

  SWITCH result.need:
    CASE 'scouter':
      Agent.spawn('scouter', { task_id })
    CASE 'code-planner':
      Agent.spawn('code-planner', { task_id, plan_iter: miss_iter, scout_file })
    CASE 'plan-reviewer':
      plan_path = ".lmd/autopilot/code-planner/" + task_id + "-" + miss_iter + ".md"
      Agent.spawn('plan-reviewer', { task_id, plan_iter: miss_iter, scout_file, plan_file: plan_path })
    CASE 'developer':
      Agent.spawn('developer', {
        task_id, iter: miss_iter, scout_file,
        plan_file: approved_plan_file,
        prior_test_file, prior_review_file: pending_review_feedback_file
      })
    CASE 'tester':
      dev_path = ".lmd/autopilot/developer/" + task_id + "-" + miss_iter + ".md"
      Agent.spawn('tester', { task_id, iter: miss_iter, scout_file, dev_file: dev_path })
    CASE 'reviewer':
      Agent.spawn('reviewer', {
        task_id, iter: miss_iter, scout_file,
        dev_file: last_dev_file, test_file: last_test_file
      })

  RETRY current_step   # the caller re-spawns the agent that returned file_not_found
```

Helper:

```
extract_iter(path):
  # path looks like ".lmd/autopilot/<agent>/<task_id>[-<N>].md"
  # scouter files have no iter — return null
  IF path ends with "/scouter/<task_id>.md": return null
  # Otherwise the suffix after the last "-" before ".md" is the iter
  name = basename(path) without ".md"        # vd "20260524-001-[lms]-foo-3"
  # Strip task_id prefix + "-" exactly (literal compare, never glob)
  IF name == task_id: return null
  IF name starts_with(task_id + "-"):
    rest = name without leading (task_id + "-")
    # rest is the numeric iter OR something like "3-devfeedback"
    Take leading digits of rest as the iter; ignore any trailing suffix
    return int(leading_digits) or null
  return null
```

The "strip leading prefix" must be done with literal substring comparison, not glob/regex, because task_id contains `[scope]`. In Bash: `${name#${task_id}-}` does literal prefix removal (the `#` parameter expansion treats `[` as a literal character because there's no quoting issue inside the expansion — but wait, `#` parameter expansion IS pattern-based and `[` IS special). Safer in Bash: use length-based substring: `"${name:${#task_id}+1}"`.

## Two `update_task_step` calls per iteration

Every `Agent.spawn` is bracketed by **two** calls:

1. **Entry** (before spawn): `outcome: null, signature: null`. Marks `current_step`. Writes a `step` event to `task_events`. Does NOT bump `tasks.iteration`.
2. **Completion** (after spawn): `outcome: <verdict>, signature: <hex>, iter: <N>`. Writes a second `step` event with the verdict. Bumps `tasks.iteration` only when `step='dev'`.

The bump-on-completion rule is what makes crash recovery safe. If autopilot crashes between entry and completion, the entry event sits in `task_events` with `outcome IS NULL`. Resume hydration (Query A / D2) ignores those orphan entries and recovers `plan_iter` / `dev_iter` from the last *completed* iter. The loop then bumps the local counter and re-spawns the agent for the same iter; its file gets overwritten (Write is idempotent), and a fresh completion event is written.

## Workflow

```
SWITCH resume_point derived from task.current_step:
  null | 'scout'                 → GOTO step0
  'plan' | 'plan-review'         → GOTO step1_loop
  'dev' | 'test'                 → GOTO step2_loop
  'review'                       → GOTO step3_loop
  'commit'                       → GOTO step4_commit
  'done'                         → no-op exit
```

### step0 — scout

```
mcp__brain__update_task_step({ id: task_id, step: 'scout', agent: 'autopilot',
  outcome: null, report_ref: ".lmd/autopilot/scouter/" + task_id + ".md" })

scout_result = Agent.spawn('scouter', { task_id })

IF scout_result.status == 'blocked':
  mcp__brain__update_task_step({ id: task_id, step: 'scout', agent: 'autopilot',
    outcome: 'blocked', report_ref: scout_result.file })
  bail to blocked (kind='scout_blocked', notes=scout_result.notes)
  EXIT

mcp__brain__update_task_step({ id: task_id, step: 'scout', agent: 'autopilot',
  outcome: 'complete', report_ref: scout_result.file })

scout_file = scout_result.file

FALL THROUGH to step1_loop
```

### step1_loop — plan ⇄ plan-review

```
LOOP:
  plan_iter += 1
  IF cap_enabled AND plan_iter > plan_cap:
    bail to blocked (kind='plan_unresolved', last_plan_review_file=prior_plan_review_file)
    EXIT

  # --- planner: entry ---
  plan_ref = ".lmd/autopilot/code-planner/" + task_id + "-" + plan_iter + ".md"
  mcp__brain__update_task_step({ id: task_id, step: 'plan', agent: 'autopilot',
    outcome: null, report_ref: plan_ref, iter: plan_iter })

  plan_result = Agent.spawn('code-planner', {
    task_id, plan_iter, scout_file, prior_plan_file, prior_plan_review_file
  })

  IF plan_result.reason == 'file_not_found':
    handle_file_not_found(plan_result)
    plan_iter -= 1
    CONTINUE

  IF plan_result.status == 'blocked':
    mcp__brain__update_task_step({ id: task_id, step: 'plan', agent: 'autopilot',
      outcome: 'blocked', report_ref: plan_result.file, iter: plan_iter })

    IF plan_result.reason == 'scout-insufficient':
      sc = Agent.spawn('scouter', { task_id, extra_objective: plan_result.detail })
      scout_file = sc.file
      plan_iter -= 1
      CONTINUE

    bail to blocked with plan_result.reason
    EXIT

  plan_file = plan_result.file

  # --- planner: completion (persists signature) ---
  mcp__brain__update_task_step({ id: task_id, step: 'plan', agent: 'autopilot',
    outcome: 'complete', report_ref: plan_file,
    signature: plan_result.signature, iter: plan_iter })

  plan_sigs = (plan_sigs + [plan_result.signature]).slice(-3)
  IF plan_sigs.length == 3 AND all_equal(plan_sigs):
    bail to blocked (kind='stuck_plan_loop', last_signature=plan_sigs[0], last_file=plan_file)
    EXIT

  # --- plan-reviewer: entry ---
  pr_ref = ".lmd/autopilot/plan-reviewer/" + task_id + "-" + plan_iter + ".md"
  mcp__brain__update_task_step({ id: task_id, step: 'plan-review', agent: 'autopilot',
    outcome: null, report_ref: pr_ref, iter: plan_iter })

  pr_result = Agent.spawn('plan-reviewer', { task_id, plan_iter, scout_file, plan_file })

  IF pr_result.reason == 'file_not_found':
    handle_file_not_found(pr_result)
    CONTINUE

  plan_review_file = pr_result.file

  # --- plan-reviewer: completion ---
  mcp__brain__update_task_step({ id: task_id, step: 'plan-review', agent: 'autopilot',
    outcome: pr_result.verdict, report_ref: plan_review_file,
    signature: pr_result.signature, iter: plan_iter })

  IF pr_result.verdict == 'pass':
    approved_plan_file = plan_file
    BREAK   # exit step1_loop, fall through to step2_loop
  ELSE:
    plan_review_sigs = (plan_review_sigs + [pr_result.signature]).slice(-3)
    IF plan_review_sigs.length == 3 AND all_equal(plan_review_sigs):
      bail to blocked (kind='stuck_plan_review_loop', last_signature=plan_review_sigs[0], last_file=plan_review_file)
      EXIT
    prior_plan_file = plan_file
    prior_plan_review_file = plan_review_file
    CONTINUE
```

### step2_loop — dev ⇄ test

```
LOOP:
  dev_iter += 1
  IF cap_enabled AND dev_iter > dev_cap:
    bail to blocked (kind='test_unresolved', last_test_file=prior_test_file)
    EXIT

  # --- developer: entry (writes step event; does NOT bump tasks.iteration yet) ---
  dev_ref = ".lmd/autopilot/developer/" + task_id + "-" + dev_iter + ".md"
  mcp__brain__update_task_step({ id: task_id, step: 'dev', agent: 'autopilot',
    outcome: null, report_ref: dev_ref, iter: dev_iter })

  dev_result = Agent.spawn('developer', {
    task_id, iter: dev_iter, scout_file,
    plan_file: approved_plan_file,
    prior_test_file,
    prior_review_file: pending_review_feedback_file
  })

  IF dev_result.reason == 'file_not_found':
    handle_file_not_found(dev_result)
    CONTINUE

  IF dev_result.status == 'blocked':
    mcp__brain__update_task_step({ id: task_id, step: 'dev', agent: 'autopilot',
      outcome: 'blocked', report_ref: dev_result.file, iter: dev_iter })

    IF dev_result.reason == 'plan-insufficient':
      synth_path = ".lmd/autopilot/plan-reviewer/" + task_id + "-" + plan_iter + "-devfeedback.md"
      Write synth_path with body:
        "# Synthesized dev feedback — " + task_id + " · plan_iter " + plan_iter + "\n\n"
        "Source: developer at dev_iter " + dev_iter + " reported plan-insufficient.\n\n"
        "## Block-grade issues\n- [plan-insufficient] " + dev_result.detail + "\n\n"
        "Verdict: fail"
      prior_plan_file = approved_plan_file
      prior_plan_review_file = synth_path
      dev_iter -= 1
      # Reset dev/test/review sigs — new plan = fresh context for these loops
      dev_sigs = []
      test_sigs = []
      review_sigs = []
      pending_review_feedback_file = null
      GOTO step1_loop

    bail to blocked with dev_result.reason
    EXIT

  dev_file = dev_result.file

  # --- developer: completion (persists signature, bumps tasks.iteration) ---
  mcp__brain__update_task_step({ id: task_id, step: 'dev', agent: 'autopilot',
    outcome: 'complete', report_ref: dev_file,
    signature: dev_result.signature, iter: dev_iter })

  dev_sigs = (dev_sigs + [dev_result.signature]).slice(-3)
  IF dev_sigs.length == 3 AND all_equal(dev_sigs):
    bail to blocked (kind='stuck_dev_loop', last_signature=dev_sigs[0], last_file=dev_file)
    EXIT

  # --- tester: entry ---
  test_ref = ".lmd/autopilot/tester/" + task_id + "-" + dev_iter + ".md"
  mcp__brain__update_task_step({ id: task_id, step: 'test', agent: 'autopilot',
    outcome: null, report_ref: test_ref, iter: dev_iter })

  test_result = Agent.spawn('tester', { task_id, iter: dev_iter, scout_file, dev_file })

  IF test_result.reason == 'file_not_found':
    handle_file_not_found(test_result)
    CONTINUE

  test_file = test_result.file

  # --- tester: completion ---
  mcp__brain__update_task_step({ id: task_id, step: 'test', agent: 'autopilot',
    outcome: test_result.verdict, report_ref: test_file,
    signature: test_result.signature, iter: dev_iter })

  IF test_result.verdict == 'pass':
    last_test_file = test_file
    last_dev_file = dev_file
    BREAK   # exit step2_loop, fall through to step3_loop
  ELSE:
    test_sigs = (test_sigs + [test_result.signature]).slice(-3)
    IF test_sigs.length == 3 AND all_equal(test_sigs):
      bail to blocked (kind='stuck_test_loop', last_signature=test_sigs[0], last_file=test_file)
      EXIT
    prior_test_file = test_file
    pending_review_feedback_file = null   # invalidate any stale review feedback
    CONTINUE
```

### step3_loop — review ⇄ dev

```
review_iter = 0   # local counter — does NOT persist across plan re-runs

LOOP:
  review_iter += 1
  IF cap_enabled AND review_iter > review_cap:
    bail to blocked (kind='review_unresolved', last_review_file=pending_review_feedback_file)
    EXIT

  # --- reviewer: entry ---
  rev_ref = ".lmd/autopilot/reviewer/" + task_id + "-" + dev_iter + ".md"
  mcp__brain__update_task_step({ id: task_id, step: 'review', agent: 'autopilot',
    outcome: null, report_ref: rev_ref, iter: dev_iter })

  review_result = Agent.spawn('reviewer', {
    task_id, iter: dev_iter, scout_file,
    dev_file: last_dev_file, test_file: last_test_file
  })

  IF review_result.reason == 'file_not_found':
    handle_file_not_found(review_result)
    CONTINUE

  review_file = review_result.file

  # --- reviewer: completion ---
  mcp__brain__update_task_step({ id: task_id, step: 'review', agent: 'autopilot',
    outcome: review_result.verdict, report_ref: review_file,
    signature: review_result.signature, iter: dev_iter })

  IF review_result.verdict == 'approve':
    BREAK   # fall through to step4_commit
  ELSE:
    review_sigs = (review_sigs + [review_result.signature]).slice(-3)
    IF review_sigs.length == 3 AND all_equal(review_sigs):
      bail to blocked (kind='stuck_review_loop', last_signature=review_sigs[0], last_file=review_file)
      EXIT
    pending_review_feedback_file = review_file
    prior_test_file = null   # tester ran against an older dev iter; will re-test after rework
    # Reset dev/test sliding windows before re-entering step2_loop. The dev
    # work that follows addresses reviewer feedback against a fresh diff, so
    # signatures from the pre-review dev/test cycle would produce false-positive
    # stuck_dev_loop / stuck_test_loop detections if mixed with the new ones.
    # review_sigs is NOT reset — it tracks the current review chain across
    # rework iterations.
    dev_sigs = []
    test_sigs = []
    GOTO step2_loop
    # dev_cap counter does NOT reset (protects against ping-pong); dev_iter keeps growing
```

### step4_commit

```
mcp__brain__update_task_step({ id: task_id, step: 'commit', agent: 'autopilot',
  outcome: null, report_ref: last_dev_file })

commit_result = Agent.spawn('committer', { task_id, final_dev_file: last_dev_file })

IF commit_result.reason == 'file_not_found':
  handle_file_not_found(commit_result)
  GOTO step4_commit

IF commit_result.status == 'failed':
  mcp__brain__update_task_step({ id: task_id, step: 'commit', agent: 'autopilot',
    outcome: 'failed', report_ref: last_dev_file })
  bail to blocked (kind='commit_failed', hook_output=commit_result.hook_output)
  EXIT

mcp__brain__update_task_step({ id: task_id, step: 'commit', agent: 'autopilot',
  outcome: 'success', report_ref: commit_result.sha })

FALL THROUGH to step5_done
```

### step5_done

```
mcp__brain__complete_task({ id: task_id, commit_sha: commit_result.sha })
terminal_state = 'done'
FALL THROUGH to step6_cleanup
```

### step6_cleanup (only on `terminal_state == 'done'` AND not `--keep-artifacts`)

Delete this task's artifact files only. Subdirectories stay. Other parallel-session tasks are not touched.

Use a Bash loop that compares paths via literal string operations — never globs — because task ids contain `[scope]`:

```bash
TID="<task_id>"                              # literal, may contain [scope]
PREFIX_LEN=$(( ${#TID} + 1 ))                # length of "<task_id>-"

for SUB in scouter code-planner plan-reviewer developer tester reviewer; do
  DIR=".lmd/autopilot/$SUB"
  [ -d "$DIR" ] || continue
  for F in "$DIR"/*; do
    [ -f "$F" ] || continue
    NAME="${F##*/}"
    # Match exactly "<task_id>.md" (scouter case) or anything starting with "<task_id>-"
    if [ "$NAME" = "${TID}.md" ] || [ "${NAME:0:${PREFIX_LEN}}" = "${TID}-" ]; then
      rm -f -- "$F"
    fi
  done
done
```

The `${NAME:0:${PREFIX_LEN}}` substring expansion is plain string slicing — no glob interpretation. This is the only safe way to match task ids containing `[scope]` in bash.

After cleanup, output paths are no longer dereferenceable; they're informational in the return report below.

## Sub-agent return contracts (what autopilot receives)

Every sub-agent returns a small structured payload. Autopilot never reads the full report file unless explicitly debugging.

| Agent | Success payload | Notes |
|---|---|---|
| `scouter` | `status, file, confidence, notes` | No signature — never participates in stuck-loop |
| `code-planner` | `status, file, signature, reason?` | reason: `file_not_found` / `scout-insufficient` / `ambiguous` |
| `plan-reviewer` | `verdict (pass/fail), file, signature` | |
| `developer` | `status, file, signature, reason?, detail?` | reason: `file_not_found` / `plan-insufficient` / `ambiguous` |
| `tester` | `verdict (pass/fail), file, signature` | |
| `reviewer` | `verdict (approve/request-changes), file, signature` | |
| `committer` | `status (success/failed), sha?, hook_output?` | No signature — single-shot, cap=1 |

When any agent is blocked by missing inputs, it returns the `file_not_found` payload (status, reason, missing, need). Handled uniformly by `handle_file_not_found`.

## Cancellation

If user interrupts (Ctrl+C) or task `status` flips to `cancelled` externally:
1. Call `mcp__brain__cancel_task({ id: task_id, reason: 'user-interrupt' })` (or similar reason). This both sets `status='cancelled'` and appends a `cancel` row to `task_events` atomically.
2. Exit immediately — don't finish the in-flight sub-agent.

Cancellation is final. Restart: `unclaim-task` then `claim-task`. Files under `.lmd/autopilot/` remain on disk for postmortem (cleanup only runs on `done`).

## State invariants

- `claimed_by` never changes during autopilot. The skill bails if it does.
- Every iteration writes **two** rows to `task_events`: entry marker (`outcome IS NULL`), then completion marker (`outcome = <verdict>, signature = <hex>`).
- `tasks.iteration` increments only on the **completion** call of the `dev` step. Entry calls never bump. This is what makes crash recovery safe — see "Two `update_task_step` calls per iteration" above.
- Resume reads everything it needs from `task_events` + disk existence checks. The in-memory state of a previous session is not persisted; it's reconstructed.
- `blockers` JSONB is append-only.
- Autopilot itself never reads sub-agent report files (only their paths), never reads source code, never mutates `nodes` / `edges`.
- Autopilot writes to `.lmd/autopilot/` only for: (a) the synthetic devfeedback plan-review file used when developer reports `plan-insufficient`, (b) the per-task delete in step6_cleanup. No other artifact writes.

## Output (returned to caller)

```yaml
task_id: <id>
terminal_state: done | blocked | cancelled
iterations:
  plan: <count of plan_iter increments this session>
  dev_test: <count of dev_iter increments this session>
  review: <count of review_iter increments this session>
scout_file: .lmd/autopilot/scouter/<id>.md
approved_plan_file: .lmd/autopilot/code-planner/<id>-<plan_iter>.md   # if step1 succeeded
final_dev_file: .lmd/autopilot/developer/<id>-<dev_iter>.md           # if step2 succeeded
final_test_file: .lmd/autopilot/tester/<id>-<dev_iter>.md             # if step2 succeeded
final_review_file: .lmd/autopilot/reviewer/<id>-<dev_iter>.md         # if step3 succeeded
commit_sha: <sha if done>
blockers: <list if blocked, each with file pointer>
duration_ms: <elapsed>
```

If `terminal_state == 'done'` and Step 6 ran, the file paths above point to deleted files (kept for caller's information).

## Forbidden actions

- Don't read sub-agent report files into the main context — only hold paths and signatures.
- Don't write code (developer does that).
- Don't write plans (code-planner does that).
- Don't review plans (plan-reviewer does that).
- Don't run tests (tester does that).
- Don't commit (committer does that).
- Don't mutate `nodes` / `edges` (developer does that via typed MCP tools).
- Don't call `mcp__brain__execute` (raw SQL).
- Don't call `mcp__brain__claim_task` outside the preflight self-claim path.
- Don't bypass plan/dev/review caps except via `--no-cap`. Committer cap stays at 1; recovery cap stays at 3.
- Don't spawn subagents in parallel within this loop — sequential only.
- Don't use bash globs / `case` / `[[ ]]` pattern matching against task ids (they contain `[scope]`). Use literal string ops (`[ "$a" = "$b" ]`, `${var:0:N}`).
