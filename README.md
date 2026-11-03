# Context Annihilator

A personal experiment. A Claude Code `/annihilate` command sends the current session's live
context to a small AWS service. The service summarizes the task, asks a decision model whether each
context record is still relevant, and returns the records to keep in their original order.
The hook then starts a fresh background Claude Code session seeded with that reduced
context, and the old session gets no model turn.

![Diagram: an old session's 13 context records pass through the Context Annihilator service (summarize the task, classify each record in parallel, apply a fail-open keep policy). A fresh session starts from a seed with the next action, a task summary, the 7 kept records in their original order, and a list of the 5 omitted records.](docs/images/context-reduction.svg)

Status: built and checked offline. Not deployed yet, and no live `/annihilate` run so far.
See `HANDOFF.md` for the current state and next steps.

## How it works

1. The hook reads the session transcript, splits it into ordered chunks, and calls the
   `ingress` Lambda function with an IAM-signed invoke. There is no public endpoint.
2. `ingress` validates the request, marks every user message protected, stores it in S3, records the job in DynamoDB, and starts
   the `coordinator` asynchronously.
3. The `coordinator` summarizes the task with Bedrock, drops earlier exact copies of
   repeated eligible chunks, and publishes one SNS message per remaining eligible chunk.
4. One `decision-worker` invocation per chunk classifies it with the Strands
   `LLMDecisionModel` and writes one idempotent result.
5. The client polls the `result` function. The first poll that sees a finished job freezes
   the ordered keep/drop result in S3.

Safety rules:

- Fail open. Protected, uncertain, failed, and timed-out chunks are always kept. A chunk is
  dropped only when the model decided it is irrelevant, or when it is an exact copy of a
  later eligible chunk. In that case only the last copy is classified, so the content
  survives unless the model drops that copy too.
- System, developer, tool-schema, and steering content, every user message, and the
  current user instruction are never classified or dropped. This includes large content
  the user pasted, such as logs or stack traces.
- Evaluated context is treated as untrusted data. Logs carry scalar fields only, never chunk
  content.

Design decisions are in `docs/adr/`.

## Layout

| Path | Contents |
| :- | :- |
| `src/contracts/` | Request and result types, limits, request validation |
| `src/domain/` | Use cases (start job, coordinator, chunk worker, get result), keep policy, aggregation. No AWS types. |
| `src/adapters/` | Bedrock, Strands, DynamoDB, S3, SNS, and Lambda adapters |
| `src/functions/` | Thin Lambda handlers |
| `src/client/` | IAM-signed Lambda client used by the hook and the scripts |
| `src/hosts/claude-code/` | Hook source: transcript parsing, seed rendering, time budget, launcher |
| `src/evaluation/` | Fixture format, task-run prompts, scoring |
| `infrastructure/template.yaml` | AWS SAM template |
| `claude-plugin/` | Claude Code plugin (skill, hook config, bundled hook in `dist/`) |
| `scripts/` | `build.mjs`, `harness.ts`, `evaluate.ts` |
| `test/smoke/` | Offline smoke tests |
| `test/fixtures/` | Hand-labeled cases for the harness and the evaluation |

## Requirements

- Node.js 22 or later. If the `node` on your PATH is older, run the TypeScript scripts with
  `npx --yes node@22 node_modules/tsx/dist/cli.mjs <script>`.
- AWS SAM CLI. The npm scripts call it through `uvx --from aws-sam-cli sam`.
- An AWS account with Bedrock access to the summary and decision models.
- Claude Code 2.1.295 or later for the plugin (`UserPromptExpansion` hooks and `onFailure`).

## Build and check offline

```bash
npm ci
npm run typecheck
npm run build      # bundles dist/functions/* and claude-plugin/dist/annihilate-hook.mjs
npx --yes node@22 node_modules/tsx/dist/cli.mjs test/smoke/pipeline.mts
npx --yes node@22 test/smoke/bundles.mjs
```

The pipeline smoke test runs the real use cases and the real Strands adapter against
in-memory ports and a fake `DecisionModel`. The bundle smoke test loads the built handlers
and the hook with no AWS credentials and checks that they fail closed without logging
content. Neither calls AWS.

## Deploy

```bash
AWS_PROFILE=<profile> npm run deploy
```

This builds, then runs `sam deploy` with stack name `context-annihilator`. The template
uses the prebuilt bundles in `dist/`, so there is no `sam build` step. Common overrides:

```bash
AWS_PROFILE=<profile> npm run deploy -- --parameter-overrides \
  SummaryModelId=<model-or-profile-id> DecisionModelId=<model-or-profile-id> AlarmEmail=<you@example.com>
```

Attach the stack output `ClientInvokePolicyArn` to the IAM principal that runs the hook or
the scripts. It allows `lambda:InvokeFunction` on the `ingress` and `result` functions only.

The Lambda roles have no AWS Marketplace permissions. Bedrock enables a third-party model
for the account on its first invocation, and that only succeeds when the caller can
subscribe in AWS Marketplace. If a function makes the first call, it may work for a few
minutes and then fail with `AccessDeniedException`. Before the first job, and after
switching to a model the account has never used, call each model once with a principal
that has `aws-marketplace:Subscribe` and `aws-marketplace:ViewSubscriptions`:

```bash
aws bedrock-runtime converse --model-id <model-or-profile-id> \
  --messages '[{"role":"user","content":[{"text":"Reply with OK."}]}]' \
  --inference-config maxTokens=10 --region us-east-1 --profile <admin-profile>
```

## Run against a deployed stack

Harness: submit one fixture or a real transcript and print the ordered decisions against the
hand labels.

```bash
mkdir -p test/evaluation/runs
npx --yes node@22 node_modules/tsx/dist/cli.mjs scripts/harness.ts \
  --fixture test/fixtures/basic-task.json --region us-east-1 --profile <profile> --out test/evaluation/runs/basic.json
```

Evaluation: run every fixture through the service, score the decisions against the labels,
and compare task runs on the full context (baseline) with task runs on the reduced seed
(filtered). It writes a JSON report to `test/evaluation/runs/` and exits 1 on any problem,
such as dropped protected or required context or fewer filtered passes than baseline.

```bash
npx --yes node@22 node_modules/tsx/dist/cli.mjs scripts/evaluate.ts --region us-east-1 --profile <profile>
```

Task runs call Bedrock directly with your credentials, so the profile also needs
`bedrock:InvokeModel` on the task model (default `global.anthropic.claude-sonnet-4-6`).
Use `--skip-task-runs` to score labels, tokens, latency, and service cost only. Prices come
from `test/evaluation/prices.json`; check them before relying on the cost figures.

## Claude Code plugin

Load it for one session with `claude --plugin-dir ./claude-plugin`, or add this repository
as a local marketplace (`.claude-plugin/marketplace.json`) and install
`context-annihilator` from it.

Plugin options:

| Option | Default | Notes |
| :- | :- | :- |
| `stack_name` | `context-annihilator` | Function names are `<stack>-ingress` and `<stack>-result`. |
| `aws_region` | `us-east-1` | |
| `aws_profile` | empty | Empty uses the default credential chain. |
| `node_path` | `node` | Use an absolute path to Node 22+ if the `node` on PATH is older. |
| `claude_path` | `claude` | Used for `claude --bg`. |
| `poll_timeout_seconds` | `240` | 30 to 255. |

Usage: `/annihilate [next instruction]`. The hook always blocks the command in the old
session. On success it starts `claude --bg --name annihilated-<job>` with the seed as the
prompt and prints the new session's ID and an attach command. On any failure it starts
nothing and leaves the old session unchanged. Seeds over 96 KiB put the retained records in
`$CLAUDE_PLUGIN_DATA/seeds/<jobId>.md` and pass that directory with `--add-dir`.

The hook has a 300 s timeout. It stops polling the service by about 257 s and refuses to
start a launch with less than 10 s left, so it can launch the new session, look up its ID,
and answer before the timeout.
