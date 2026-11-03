# Handoff: Context Annihilator

Date: 2026-11-03. Repo: `/home/dblocher/repos/context-annihilator` (WSL Ubuntu). Kiro sees it as
`\\wsl.localhost\Ubuntu\home\dblocher\repos\context-annihilator`.

Git: branch `master` at `49327b4`, pushed to `origin` (github.com/dblocher/context-annihilator).
The working tree was clean when this file was written. `README.md` covers setup and usage; this
file covers state and next steps.

## Working agreement

The user runs every AWS CLI and SAM CLI action (SSO login, deploy, harness and evaluation runs
against the stack) by hand, to avoid giving the agent broad AWS permissions. The agent prepares
exact commands, reads the output or report files the user points to, and does offline work. Do not
run `aws`, `sam`, the harness, or the evaluation yourself.

## Start here: approved changes for the next session

The user approved these four changes on 2026-11-03. **Status: all four are implemented and pass
the offline checks (45 pipeline checks, bundle checks). They are not deployed or evaluated yet,
and not committed.** Differences from the plan below: the duplicate reason reads
`duplicate: identical content appears later at #<last copy>`, `JobMetrics.chunks.duplicate` counts
them, the coordinator emits a `DuplicateChunks` metric, and the README diagram's step 3 box and
legend now mention duplicates.

### 1. Drop earlier exact duplicates without asking the model

Today `laterDuplicateOrdinals` (`src/domain/aggregation/duplicates.ts`) maps each eligible chunk
that has an identical later copy (same SHA-256 of content) to the next copy's ordinal. The
coordinator sends it as `laterDuplicateOrdinal`, and `buildDecisionState`
(`src/domain/decisions/state.ts`) adds a note. Haiku 4.5 and Haiku 5.5 both ignored the note and
kept `basic-task` #7 as an unresolved issue.

Change:

- In `runCoordinator` (`src/domain/jobs/run-coordinator.ts`), do not publish chunks that have a
  later identical copy. Write their results directly, the way protected chunks are handled, with a
  new outcome (suggested name `duplicate`), decision `irrelevant`, `keep: false`, reason code
  `duplicate`, and a reason such as `dropped: identical copy kept at #<ordinal>`.
- Only the last copy is classified. If it is kept for any reason, the content survives. If the
  model drops it, every copy was irrelevant.
- Protected chunks are never deduplicated (`duplicates.ts` already skips them).

Touch points to check: `DecisionOutcome` (`src/contracts/decisions.ts`) and the manifest type in
`src/contracts/api.ts`; `shouldKeep` in `src/domain/decisions/policy.ts`, whose comment says a model
verdict is the only path to a drop; progress counting, so coordinator-written results still count
as resolved and the job completes; metrics in `src/domain/aggregation/assemble.ts` (decide whether
to count duplicates separately); harness and evaluation output; the omitted-context list in
`src/hosts/claude-code/seed.ts`. The `laterDuplicateOrdinal` message field and the state note
become unused; remove them unless there is a reason to keep them. Record the second drop path in
`docs/adr/0002-data-contract-and-handoff.md`.

Smoke test (`test/smoke/pipeline.mts`): the fake model currently drops `c07` with reason
`duplicate`, expects 11 published messages, and checks the later-duplicate hint. Update these for
a `duplicate` outcome on `c07` with no model call and 10 published messages (9 after change 2,
which also protects `c01`).

### 2. Never drop earlier user messages

Today `AUTHORITATIVE_KINDS` (`src/contracts/context.ts`) is system, developer, tool-schema, and
steering, and validation rejects those kinds with `protected: false`. Hosts decide protection for
other kinds. The Claude Code transcript parser protects only the most recent human-typed prompt and
compact summaries (`src/hosts/claude-code/transcript.ts`). In the evaluation, Haiku 5.5 dropped
`task-switch` `c01-user-navbar` as unrelated, although it carries a standing schema-freeze rule.

Change, on the service side so every host gets it: treat every `kind: 'user'` chunk as protected
(never classified, manifest outcome `protected`). Normalize in `startJob`
(`src/domain/jobs/start-job.ts`) after validation and before computing `requestHash`, so resubmits
stay idempotent and `protectedCount`, `eligibleCount`, the coordinator, and metrics all see the
same thing. Do not add `user` to `AUTHORITATIVE_KINDS`: validation would then reject the fixtures
and transcripts that send user chunks with `protected: false`.

Trade-off to record in ADR 0002: large content the user pastes (logs, stack traces) is never
dropped either. The user accepted this.

Effects: `scoreLabels` (`src/evaluation/scoring.ts`) already skips protected entries, so the user
labels in fixtures become unused without errors. Smoke test counts change (for `basic-task`, 10
eligible and 2 protected). In `README.md`, update the safety rules. In
`docs/images/context-reduction.svg`, change row `#1 user` from `kept` to `protected` in both the
old-session and retained columns (class `kept` to `protected`); the "7 of 12 records kept" line
stays correct.

### 3. Fix the `rename-alias` `keeps-alias` check

`test/fixtures/rename-alias.json` checks the patch with
`fetchUser\s*=\s*getUser|getUser\s+as\s+fetchUser`. In the evaluation report
`test/evaluation/runs/eval-2026-11-03T19-35-20-356Z.json` (gitignored, local only):

- The baseline answer kept a deprecated wrapper,
  `export async function fetchUser(...args) { ... return getUser(...args) }`. That is a valid
  alias, and the check rejected it.
- The filtered answer wrote `export const fetchUser: typeof getUser = getUser`. The type annotation
  broke the regex. It is also a compile error, because `src/index.ts` only re-exports `getUser`
  and never imports it. A regex check cannot catch that.

Proposed pattern, with flags `m`:
`^(?!-)[^\n]*(?:\bfetchUser\b[^=\n]*=\s*getUser\b|\bgetUser\s+as\s+fetchUser\b)|^\+[^\n]*\bfunction\s+fetchUser\b`.
It ignores removed diff lines such as `-export { fetchUser, createUser } ...`. Verify offline by
re-scoring both stored answers from that report with `evaluateChecks` (`src/evaluation/task.ts`)
against the updated fixture: both should pass.

### 4. Tighten the summarizer prompt

`buildSummaryPrompt` (`src/domain/summarization/summarizer.ts`) asks for the headings Goal;
Constraints and decisions; Current state; Open problems; Next action, and says "Do not invent
details." In the `task-switch` evaluation, the summary added an open problem nobody had raised
(whether `mockReqRes` supports a cursor, "should be verified before writing the test"). The
filtered task run then asked to read the helpers instead of writing the patch, while the baseline
wrote it. That run is the only `task-switch` regression; the dropped `c01` was not the cause,
because the summary carried the schema freeze and both schema checks passed.

Change: Open problems lists only errors, failures, and questions that appear in the transcript and
are still unresolved, with no new risks, checks, or verification steps. Next action follows the
user's latest instruction and the session's own plan without adding steps. Keep "Do not invent
details."

### Checks and user commands after the changes

Offline (agent): `node node_modules/typescript/bin/tsc -p tsconfig.json`, `node scripts/build.mjs`,
`npx --yes node@22 node_modules/tsx/dist/cli.mjs test/smoke/pipeline.mts`, and
`npx --yes node@22 test/smoke/bundles.mjs`, using the log-file pattern in Environment notes.

User, from the repo root:

```bash
AWS_PROFILE=david-dev npm run deploy
npx --yes node@22 node_modules/tsx/dist/cli.mjs scripts/evaluate.ts --region us-east-1 --profile david-dev --repeats 3
echo "evaluate exit=$?"
```

No parameter overrides are needed: the stack already uses Haiku 5.5 with no temperature, and
`sam deploy` keeps previous parameter values. Expected cost is about $0.55 (four jobs at about
$0.02, plus 24 Sonnet 4.6 task runs at about $0.02). The report lands in
`test/evaluation/runs/eval-<timestamp>.json`. Compare it with
`eval-2026-11-03T19-35-20-356Z.json`: required recall should reach 100%, `basic-task` #7 should
show the `duplicate` outcome, and `rename-alias` should pass in both variants.

### Deferred

- **D. Exploratory test on a real session.** The user will set this up later. Only a long real
  session can show actual token savings; see the cost model below.
- **Live `/annihilate` run.** Needs Claude Code 2.1.295 or later in WSL (installed: 1.0.35). Then
  load `claude --plugin-dir ./claude-plugin`, set `node_path` to an absolute Node 22 path and
  `aws_profile` to `david-dev`, and run `/annihilate <next step>`. The real `claude --bg` output
  format (the parser expects the 2.1.316 `backgrounded · <id> · <name>` line) and whether it
  detaches its stdout are still unconfirmed.

## Current state

- **Deployed** by the user: stack `context-annihilator` in us-east-1. Summarizer
  `global.anthropic.claude-sonnet-4-6`. Decisions `global.anthropic.claude-haiku-5-5` with
  `DecisionTemperature` empty, because Haiku 5.5 rejects temperature, top_p, and top_k.
- **Works end to end** through the harness and the evaluation. Workers run in parallel.
- **Not yet tried:** the Claude Code plugin against the live stack.

## Results so far (2026-11-03)

Harness on `basic-task`:

| Run | Outcome |
| :- | :- |
| Haiku 4.5, question named `reason` | Passed. #5 and #8 failed with `invalid answer set`: `LLMDecisionModel` gives every answer object an optional `reason` string, and a question also named `reason` made the model return a bare string. Fixed by renaming the question to `reasonCode` (`src/adapters/strands/relevance-classifier.ts`). |
| Haiku 4.5 after redeploy | All 11 decisions failed with an AWS Marketplace `AccessDeniedException`, kept by policy. Haiku 4.5 had never been used in the account, so the worker role's first calls started an automatic Marketplace subscription. Calls work for up to 15 minutes while it finalizes, then the subscription failed because the role has no Marketplace permissions. The README Deploy section now says to call a new model once with an admin profile first. |
| Haiku 5.5 | No problems, none failed. Dropped #2, #4, and #8 correctly; #8 is the README with injected instructions, so the model ignored them. False keeps: #5 (stale error) and #7 (earlier duplicate). 30.8% eligible reduction (704 to 487 estimated tokens). 11.8 s from ingress to last result; the summary takes 6.8 s; decision latency p50 1.7 s. |

Evaluation, all four fixtures, one task run per variant
(`test/evaluation/runs/eval-2026-11-03T19-35-20-356Z.json`):

| Fixture | Req recall | Sup recall | Precision | Irrelevant dropped | Eligible reduction | Hand-label ceiling | Baseline | Filtered |
| :- | -: | -: | -: | -: | -: | -: | :-: | :-: |
| basic-task | 100% | 100% | 75% | 60% | 31% | 47% | 1/1 | 1/1 |
| esm-dirname | 100% | 100% | 80% | 33% | 5% | 34% | 1/1 | 1/1 |
| rename-alias | 100% | 100% | 89% | 50% | 6% | 26% | 0/1 | 0/1 |
| task-switch | 75% | 100% | 100% | 100% | 28% | 24% | 1/1 | 0/1 |

Overall: required recall 94%, supporting recall 100%, retained precision 85%, irrelevant dropped
67%. Service cost $0.082 for four jobs. Task-model input was 10,399 tokens baseline and 14,205
filtered: on contexts this small, the seed's summary and instructions outweigh what is removed.
Changes 2 to 4 above address the `task-switch` false drop, the `task-switch` regression, and the
`rename-alias` check.

## Cost model: annihilator vs. resending the context to Claude Opus 5.5

Approximate prices, USD per million tokens, checked 2026-11-03. Opus 5.5 figures are Anthropic list
prices reported by [LiteLLM](https://models.litellm.ai/models/claude-opus-5-5) and
[claudeai.dev](https://claudeai.dev/docs/resources/claude-opus-55/); Bedrock global profiles are
assumed to match. The others come from `test/evaluation/prices.json`.

| Model | Role | Input | Output | Cache write (5 min) | Cache read |
| :- | :- | -: | -: | -: | -: |
| Claude Opus 5.5 | The coding agent | 4.00 | 20.00 | 5.00 | 0.20 |
| Claude Sonnet 4.6 | Summary | 3.00 | 15.00 | | |
| Claude Haiku 5.5 | Decisions | 0.10 | 0.50 | | |

Service cost model:

- **Measured** on the fixtures (700 to 1,300 eligible tokens): about $0.02 per job. The summary is
  about $0.016, the decisions about $0.004, and Lambda, SNS, DynamoDB, and S3 together under $0.001.
- **Summary at scale:** Sonnet reads at most 400,000 characters (about 100k tokens), so at most
  about $0.30 input plus about $0.012 output.
- **Decisions at scale:** each chunk costs about 2,700 fixed input tokens (system prompt, tool
  schema, summary) plus 1.3 times its own size (Haiku 5.5 counts about 30% more tokens), and about
  100 output tokens.
- **Seed overhead:** about 1,500 tokens (summary, instructions, omitted-context list).

Scenario: 150,000 tokens of eligible session context in 200 chunks, 750 tokens each on average.
The annihilator costs about $0.40: $0.31 for the summary and $0.08 for the decisions. Claude
Code's own system prompt and tool definitions are sent either way, so they are left out.

| Reduction | Context after | Saved per turn | No cache: saved per turn | No cache: break-even | Warm cache: one-time cost | Warm cache: saved per turn | Warm cache: break-even |
| :- | -: | -: | -: | -: | -: | -: | -: |
| 16% (evaluation aggregate) | 127,500 | 22,500 | $0.090 | 4.4 turns | $1.01 | $0.0045 | about 225 turns |
| 31% (best fixture) | 105,000 | 45,000 | $0.180 | 2.2 turns | $0.90 | $0.0090 | about 100 turns |
| 50% (assumed long session) | 76,500 | 73,500 | $0.294 | 1.4 turns | $0.77 | $0.0147 | about 52 turns |

How the columns are computed, with A the annihilator cost, C the context before, C' the context
after (C times one minus the reduction, plus the 1,500-token overhead), and ΔC = C − C':

- **No cache:** every turn pays $4/M for the context. Break-even turns = A / (ΔC × $4/M).
- **Warm cache** (normal for Claude Code): the old session would read its context from cache at
  $0.20/M. The fresh session must first write its seed to the cache at $5/M. One-time cost =
  A + C' × ($5 − $0.20)/M. Break-even turns = one-time cost / (ΔC × $0.20/M).
- **Cache expired** (idle longer than the 5-minute cache): each resumed turn rewrites the context
  at $5/M, so each such turn saves ΔC × $5/M, which is $0.11 to $0.37 in the scenarios.
- **Effort medium:** Opus 5.5 thinks adaptively at medium effort by default, and thinking tokens
  bill as output at $20/M. Output depends on the task, not on context size, so it is the same with
  or without annihilation. It lowers the relative saving but does not move the break-even. With an
  assumed 3,000 output tokens per turn ($0.06), a warm-cache turn at 150k context costs about
  $0.09, and a 31% reduction saves about 10% of it. Without caching, the turn costs about $0.66,
  and the saving is about 27%.

Takeaways:

- With a warm prompt cache, token savings alone rarely pay for the handoff (52 to 225 turns). The
  largest one-time cost is the fresh session's cache write ($0.37 to $0.61 more than the cache read
  it replaces), which is more than the service itself.
- Without caching, or after idle gaps that expire the cache, it pays back within 1 to 5 turns.
- On fixture-sized contexts, the seed is larger than the original, so there is no saving at any
  turn count. A size threshold in the hook (skip the handoff below some number of eligible tokens)
  would avoid that.
- The stronger case under warm caching is answer quality from removing stale context, not cost.
  The deferred real-session test is what will show real reduction numbers.
- Cost levers: a Haiku 5.5 summary would cut the summary from about $0.31 to about $0.01 at 100k
  input tokens (quality untested). Decision calls share about 2,700 prefix tokens that prompt
  caching could reuse, but decisions are already the cheap part.

## Other open items (not approved yet)

- The harness exits 0 when every decision fails (fail-open keeps everything). Exiting 1 when any
  decision fails would make runs like the Marketplace one visible. Offered, not decided.
- The offline smoke tests do not cover `budget.ts`, `parseBackgroundSessionId`, or
  `src/evaluation/`.
- `claude plugin validate` warnings: no `author` in plugin.json, no marketplace description.
- The corpus has four fixtures. Grow it before tuning thresholds.

## What exists

| Area | Location | Notes |
| :- | :- | :- |
| ADRs | `docs/adr/0001-chunk-fan-out-mechanism.md`, `docs/adr/0002-data-contract-and-handoff.md` | 0001 picks SNS + DynamoDB + polling over Step Functions `Map` and in-process concurrency. 0002 records contract changes (`outcome`, `reasonCode`, limits, transcript mapping, handoff rules). |
| Contracts | `src/contracts/` | Types, limits, and `validateStartJobRequest`. |
| Domain | `src/domain/` | Use cases in `jobs/` (`startJob`, `runCoordinator`, `processChunkTask`, `getResult`), keep policy in `decisions/policy.ts`, aggregation in `aggregation/`, ports in `jobs/ports.ts`. No AWS or Lambda types. |
| Adapters | `src/adapters/` | Strands `LLMDecisionModel` + `BedrockModel` classifier, Bedrock Converse summarizer, Bedrock task runner (evaluation only), DynamoDB job store, S3 payload store, SNS `PublishBatch` publisher, async Lambda trigger. |
| Lambda handlers | `src/functions/{ingress,coordinator,decision-worker,result}/handler.ts` | Thin wiring. Logs accept scalar fields only, so chunk content cannot be logged by accident. Metrics use EMF in namespace `ContextAnnihilator`. |
| SAM template | `infrastructure/template.yaml` | Function names are `<stack>-ingress`, `-coordinator`, `-decision-worker`, `-result`. `CodeUri` points at prebuilt `dist/` bundles, so there is no `sam build` step. Worker and coordinator async retries are 0 with an SQS on-failure queue. SNS subscription has a redrive DLQ. Alarms cover errors, throttles, duration, async event age, DLQs, and custom failure metrics. Output `ClientInvokePolicyArn` is the least-privilege client policy. |
| Service client | `src/client/service-client.ts` | Used by the hook, the harness, and the evaluation. |
| Claude Code plugin | `claude-plugin/` and `.claude-plugin/marketplace.json` | Skill `annihilate` (model invocation disabled). `UserPromptExpansion` hook in exec form, `timeout: 300`, `onFailure: "block"`. Hook source is `src/hosts/claude-code/{hook,transcript,seed,launcher,budget}.ts`, bundled to `claude-plugin/dist/annihilate-hook.mjs` (gitignored, so run the build first). |
| Hook time budget | `src/hosts/claude-code/budget.ts` | Hook deadline is spawn + 295 s. Polling stops at spawn + 257 s (30 s launch + 8 s ID lookup reserved). The hook refuses to start a launch with under 10 s left. `poll_timeout_seconds` (default 240, max 255) can only shorten polling. |
| Harness | `scripts/harness.ts` | Submits a fixture or a transcript, polls, prints ordered decisions against hand labels, writes JSON with `--out` (create the directory first). Exits 1 on a protected drop or a labeled false drop. |
| Evaluation | `scripts/evaluate.ts`, `src/evaluation/{fixture,task,scoring}.ts`, `test/evaluation/prices.json` | Runs every fixture through the service, scores labels, runs a task model (Sonnet 4.6, called with the user's credentials) on baseline vs filtered context with deterministic answer checks, and reports tokens, latency by stage, and cost. Writes `test/evaluation/runs/eval-<timestamp>.json` (gitignored). Exits 1 on any problem. `--skip-task-runs` skips the task model; `--repeats` sets task runs per variant. |
| Fixtures | `test/fixtures/{basic-task,esm-dirname,rename-alias,task-switch}.json` | 12, 13, 11, and 14 chunks; 11, 11, 10, and 13 labels; 8, 7, 6, and 7 task checks. |
| Smoke tests | `test/smoke/pipeline.mts`, `test/smoke/bundles.mjs` | Offline. 42 pipeline checks with a fake `DecisionModel` (it bypasses the real answer schema). Bundle test loads all handlers and runs the hook under Node 22 and Node 18. |
| README diagram | `docs/images/context-reduction.svg` | Hand-written SVG based on the `basic-task` hand labels, linked from `README.md`. Check it in headless Edge after edits (see the `wsl-windows-shell` skill). |

Key behavior to know before changing code:

- Job ID is derived from `host` + `requestId`. Resubmitting the same request returns the same job.
  Resubmitting the same ID with different content returns `conflict`. The harness adds a run
  suffix to the fixture `requestId` unless given `--reuse`; the evaluation always adds one.
- A chunk is dropped only when `outcome` is `decided` and `decision` is `irrelevant` (change 1 adds
  the `duplicate` path). An `irrelevant` label paired with a keep-type reason code is downgraded to
  `uncertain`.
- The first result poll that sees a finished job freezes the result in S3 (`resultKey` on the job
  record). Late worker results cannot change a manifest the client already saw.
- Workers skip messages older than the deadline plus `STALE_GRACE_MS`, check for an existing result
  before the model call, and write with `attribute_not_exists`.
- Strands question IDs become property names in the structured-output schema, and each answer
  object already has a `reason` field. Do not name a question `reason`.
- Haiku 5.5 accepts the forced tool choice `LLMDecisionModel` uses (no thinking block in that
  case), rejects sampling parameters, and may stop with `refusal`, which becomes a failed decision
  and is kept.
- `sam deploy` reuses previous parameter values for an existing stack. Changing a template default
  does nothing until it is passed in `--parameter-overrides`. Pass an empty value as
  `'Name=""'`.
- The hook always prints `{"decision":"block", ...}`. On failure it launches nothing and leaves the
  old session unchanged. It launches with `claude --bg --name annihilated-<job> [--add-dir <seeds>] -- <seed>`
  and refuses `--resume`, `--continue`, `--fork-session`, and `--session-id`. The `--` matters
  because `--add-dir` is variadic. Seeds over 96 KiB go to `$CLAUDE_PLUGIN_DATA/seeds/<jobId>.md`.
- The launcher reads the session ID from `claude --bg` output, falling back to
  `claude agents --json --all` by name. If `claude` ignores SIGTERM at its timeout, the launcher
  sends SIGKILL after 1 s (`KILL_GRACE_MS`) and reports a possible unconfirmed session.
- Installed `@strands-agents/sdk` is 1.22.0. Its `DecisionResult.metadata` has only `latencyMs`,
  so `modelId` comes from config and `confidence` stays empty. `LLMDecisionModel` ignores
  `uncertainty.minConfidence`.

## Environment notes (WSL from Kiro's PowerShell)

- Load the `wsl-windows-shell` skill. Run Linux commands as `wsl -e bash -lc '...'` or write a script
  to `/tmp` and run `wsl -e bash /tmp/x.sh`. Double quotes inside the bash string get mangled.
- A script just written to `\\wsl.localhost\Ubuntu\tmp\` is sometimes not visible to WSL yet.
  Prefix the command with `Start-Sleep -Seconds 1;` and retry once if bash reports
  "No such file or directory".
- Redirect output to `/tmp/<unique-name>.log`, append `echo EXIT=$?`, then read the log. The tool's
  exit code is unreliable. Use a new log name per run, because the file reader can return cached
  content.
- Default `node` is v18. Run anything that loads the AWS SDK or Strands with `npx --yes node@22 ...`.
  `tsc` and `scripts/build.mjs` work under Node 18.
- The AWS CLI (`~/bin/aws`, profile `david-dev`, region `us-east-1`) and SAM CLI (through
  `uvx --from aws-sam-cli sam`) are for the user to run.
