# Handoff: Context Annihilator MVP

Date: 2026-11-03. Repo: `/home/dblocher/repos/context-annihilator` (WSL Ubuntu). Kiro sees it as
`\\wsl.localhost\Ubuntu\home\dblocher\repos\context-annihilator`.

Git: branch `master`. The first commit (2026-11-03) holds everything below. `README.md` covers
setup and usage; this file covers state and next steps.

## Working agreement

The user runs every AWS CLI and SAM CLI action (SSO login, deploy, harness and evaluation runs
against the stack) by hand, to avoid giving the agent broad AWS permissions. The agent prepares
exact commands, reads the output the user shares, and does offline work. Do not run
`aws sso login`, `sam deploy`, or anything else that calls AWS.

## Goal

A personal experiment from the "Context Annihilator Project Seed" (source of truth: the
`[[Context Annihilator]]` note in the `Consulting/` vault, which a new session cannot see). The
service summarizes the current coding task, classifies each eligible context chunk in parallel with
the Strands `DecisionModel`, and returns the protected and retained chunks in their original order.
A Claude Code `/annihilate` command then starts a fresh background session from that reduced seed
and blocks the old session's model turn.

Hard rules from the seed:

- TypeScript, Node 22+, AWS Lambda, SNS fan-out, AWS SAM, DynamoDB with TTL, S3 with short
  lifecycle, Bedrock summarizer, Strands `DecisionModel` for decisions.
- Fail open: protected, uncertain, failed, and timed-out chunks are always kept.
- Never filter system, developer, tool-schema, steering, or the current user instruction.
  Treat evaluated context as untrusted data.
- No vector memory, no transparent gateway filtering, no UI. Personal use only.
- No unauthenticated public endpoint. Clients use IAM-signed direct Lambda invokes.

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
| Evaluation | `scripts/evaluate.ts`, `src/evaluation/{fixture,task,scoring}.ts`, `test/evaluation/prices.json` | Runs every fixture through the service, scores labels (required/supporting recall, retained precision, irrelevant drop rate, oracle reduction), runs a task model on baseline vs filtered context with deterministic answer checks, and reports tokens, latency by stage, and cost. Writes `test/evaluation/runs/eval-<timestamp>.json` (gitignored). Exits 1 on any problem. `--skip-task-runs` skips the task model. |
| Fixtures | `test/fixtures/{basic-task,esm-dirname,rename-alias,task-switch}.json` | 12, 13, 11, and 14 chunks; 11, 11, 10, and 13 labels; 8, 7, 6, and 7 task checks. |
| Smoke tests | `test/smoke/pipeline.mts`, `test/smoke/bundles.mjs` | Offline. 42 pipeline checks (validation, idempotency, conflict, duplicate deliveries, publish and classifier failures, timeouts, ordering, frozen results, transcript parsing, splitting, seed rendering, launch args). Bundle test loads all handlers and runs the hook under Node 22 and Node 18. |

Key behavior to know before changing code:

- Job ID is derived from `host` + `requestId`. Resubmitting the same request returns the same job.
  Resubmitting the same ID with different content returns `conflict`. The harness adds a run
  suffix to the fixture `requestId` unless given `--reuse`; the evaluation always adds one.
- A chunk is dropped only when `outcome` is `decided` and `decision` is `irrelevant`. An
  `irrelevant` label paired with a keep-type reason code is downgraded to `uncertain`.
- The first result poll that sees a finished job freezes the result in S3 (`resultKey` on the job
  record). Late worker results cannot change a manifest the client already saw.
- Workers skip messages older than the deadline plus `STALE_GRACE_MS`, check for an existing result
  before the model call, and write with `attribute_not_exists`.
- The hook always prints `{"decision":"block", ...}`. On failure it launches nothing and leaves the
  old session unchanged. It launches with `claude --bg --name annihilated-<job> [--add-dir <seeds>] -- <seed>`
  and refuses `--resume`, `--continue`, `--fork-session`, and `--session-id`. The `--` matters
  because `--add-dir` is variadic. Seeds over 96 KiB go to `$CLAUDE_PLUGIN_DATA/seeds/<jobId>.md`.
- The launcher reads the session ID from the `backgrounded · <id> · <name>` line of `claude --bg`
  output, falling back to `claude agents --json --all` by name. If `claude` ignores SIGTERM at its
  timeout, the launcher sends SIGKILL after 1 s (`KILL_GRACE_MS`) and reports a possible
  unconfirmed session.
- Installed `@strands-agents/sdk` is 1.22.0. Its `DecisionResult.metadata` has only `latencyMs`,
  so `modelId` comes from config and `confidence` stays empty. `LLMDecisionModel` ignores
  `uncertainty.minConfidence`.

## Verification done (2026-11-03)

| Check | Result |
| :- | :- |
| `tsc -p tsconfig.json` (TypeScript 7.0.2) | Pass |
| `node scripts/build.mjs` | Pass. Bundles: ingress 1279 KiB, coordinator 1286 KiB, decision-worker 2869 KiB, result 1140 KiB, hook 887 KiB. |
| `test/smoke/pipeline.mts` under Node 22 | 42 checks pass |
| `test/smoke/bundles.mjs` under Node 22 | Pass. No chunk content or prompt in logs. Hook answers `decision: block` under Node 22 (credential failure) and Node 18 (version check). |
| Hook budget and launcher timing (throwaway script with a fake `claude`, not in the repo) | Budget arithmetic as described above. Launch with printed ID, ID found by lookup, no ID (lookup bounded), hang (timeout), and a grandchild holding stdout (bounded) all behave. A child that ignored SIGTERM made the launcher wait forever; fixed with the SIGKILL backstop and rechecked (returns in about 3 s for a 2 s timeout). |
| All four fixtures through `parseFixture` | Pass |
| `claude plugin validate ./claude-plugin` and `claude plugin validate .` with Claude Code 2.1.317 | Both pass with warnings: no `author` in plugin.json, no marketplace description. Directory-submission checks also flag no LICENSE and no icon; those only matter for publishing. The output does not say whether it checked `hooks/hooks.json`. Run with an isolated `HOME` from a throwaway install in `/tmp`; the global WSL `claude` is still 1.0.35. |
| `claude --help` (2.1.317) | `--bg`, `--name`, `--add-dir`, `agents --json --all`, and `attach <id|name>` all exist. |
| `sam validate --lint` (SAM CLI 1.171.0, 2026-10-30) | Pass. Not rerun; the template has not changed since. |

## Not verified or not done

1. **Deployed 2026-11-03, not yet exercised.** Stack `context-annihilator` in us-east-1 with
   default parameters. Functions `context-annihilator-ingress` and `context-annihilator-result`;
   client policy `context-annihilator-ClientInvokePolicy-pa3LMDRbE9tR`. No job has run yet.
2. **Model invocation is unverified.** Defaults are `global.anthropic.claude-sonnet-4-6`
   (summarizer and evaluation task model) and `global.anthropic.claude-haiku-4-5-20251001-v1:0`
   (decisions). Both profiles are listed as ACTIVE in us-east-1 (checked 2026-11-03), so no
   overrides are needed. Global profiles need three IAM resources: the profile in the source
   Region, the source-Region foundation model, and the Region-less
   `arn:aws:bedrock:::foundation-model/<model>`. The template grants the profile and
   `arn:aws:bedrock:*::foundation-model/*`; IAM's `*` matches an empty Region, so this should
   cover all three. A first real job will confirm it.
3. **No live `/annihilate` run.** The real `claude --bg` output format and whether it detaches its
   stdout are unconfirmed. The parser expects the 2.1.316 format.
4. **Global Claude Code in WSL is 1.0.35**, too old for the plugin (needs 2.1.295+).
5. **Evaluation never ran against AWS.** Prices in `prices.json` were checked on 2026-10-30 from a
   third-party table; confirm them on the Bedrock pricing page.
6. The corpus has four fixtures. Grow it before tuning any thresholds.
7. The offline smoke tests do not cover `budget.ts`, `parseBackgroundSessionId`, or
   `src/evaluation/`.

## Environment notes (WSL from Kiro's PowerShell)

- Load the `wsl-windows-shell` skill. Run Linux commands as `wsl -e bash -lc '...'` or write a script
  to `/tmp` and run `wsl -e bash /tmp/x.sh`. Double quotes inside the bash string get mangled.
- Redirect output to `/tmp/<unique-name>.log`, append `echo EXIT=$?`, then read the log. The tool's
  exit code is unreliable. Use a new log name per run, because the file reader can return cached
  content (it did again on 2026-11-03; copying the log to a new name worked around it).
- Default `node` is v18. Run anything that loads the AWS SDK or Strands with `npx --yes node@22 ...`.
  `tsc` and `scripts/build.mjs` work under Node 18.
- The AWS CLI is `~/bin/aws` and needs a login shell (`bash -l`). Profile `david-dev`, region
  `us-east-1`, account 551377672022.
- SAM CLI is not installed. Use `~/.local/bin/uvx --from aws-sam-cli sam ...`. The npm scripts do this.

## Next actions

User steps (AWS) are marked **user**.

1. **user** `aws sso login --profile david-dev`.
2. Done 2026-11-03: both default inference profiles are ACTIVE in us-east-1.
3. Done 2026-11-03: `AWS_PROFILE=david-dev npm run deploy` with default parameters.
4. **user** Harness against the live stack:
   `mkdir -p test/evaluation/runs && npx --yes node@22 node_modules/tsx/dist/cli.mjs scripts/harness.ts --fixture test/fixtures/basic-task.json --region us-east-1 --profile david-dev --out test/evaluation/runs/basic.json`.
   Then check parallel worker execution in the worker logs and the `FanOutLagMs` metric.
5. **user** Evaluation:
   `npx --yes node@22 node_modules/tsx/dist/cli.mjs scripts/evaluate.ts --region us-east-1 --profile david-dev`.
   Share the report path or the printed table.
6. **user** Update Claude Code in WSL to 2.1.295 or later.
7. **user** Load the plugin (`claude --plugin-dir ./claude-plugin`), set `node_path` to an absolute
   Node 22 path and `aws_profile` to `david-dev`, then try `/annihilate <next step>`. Share the
   hook's message and `claude agents --json --all` output so the agent can confirm the ID parsing.
8. Grow the labeled corpus and tune from the evaluation results.
