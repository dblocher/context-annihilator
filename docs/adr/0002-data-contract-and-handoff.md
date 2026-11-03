---
status: accepted
date: 2026-10-29
---

# ADR 0002: Data contract changes and Claude Code handoff rules

## Context

The project seed gives a starting data contract and asks for changes to be recorded here.
The installed `@strands-agents/sdk` 1.22.0 also differs from the design document: the
`DecisionResult.metadata` type carries only `latencyMs`. It has no `modelId`, `confidence`,
or `probabilities`, and `LLMDecisionModel` ignores `uncertainty.minConfidence`.

## Decisions

### Request contract

- `ContextKind` is unchanged. `system`, `developer`, `tool-schema`, and `steering` are
  authoritative. A request that sends any of them with `protected: false` is rejected.
- `currentPrompt` is always protected. It travels outside `chunks` and is never classified.
- Every `user` chunk is protected (added 2026-11-03). Hosts may still send `user` chunks
  with `protected: false`; `startJob` sets `protected: true` after validation and before it
  computes the request hash, so resubmissions stay idempotent and the job counts, the
  coordinator, and the metrics all see the same protection. `user` is not added to the
  authoritative kinds, because validation would then reject existing hosts and fixtures
  that send user chunks unprotected. Reason: in the 2026-11-03 evaluation, Haiku 5.5
  dropped an earlier user message in `task-switch` that carried a standing schema-freeze
  rule. Trade-off, accepted by the user: large content the user pastes into a message
  (logs, stack traces) is never dropped either.
- Ordinals must be unique non-negative integers, and `chunks` must be sorted by ordinal.
  Gaps are allowed, so a host can omit entries without renumbering.
- Chunk IDs must be unique, 1 to 200 characters, with no control characters.
- `requestId` must match `^[A-Za-z0-9._:-]{1,128}$`. The job ID is derived from `host` and
  `requestId`. Resubmitting the same request returns the same job. Resubmitting the same
  `requestId` with different content is rejected as a conflict.
- Default limits, all configurable: 1,000 chunks, 64 KiB per chunk, 5 MiB total request,
  32 KiB `currentPrompt`. The total stays under the 6 MB synchronous Lambda invoke payload
  limit, because the client calls the ingress function directly with IAM credentials.
  Hosts split oversized content into ordered parts instead of truncating it.

### Decision contract

`ChunkDecision` gains these fields:

- `outcome`: `decided`, `duplicate`, `protected`, `failed`, or `timed-out`. The `decision`
  label alone cannot say why an `uncertain` chunk was kept.
- `reasonCode`: the answer to a second closed question asked in the same model call (for
  example `superseded`, `duplicate`, `direct-dependency`). Decision models cannot produce
  free text, so `reason` is a readable sentence built from the code, or the `Uncertain`
  reason when the model abstains.
- `ordinal`, `kind`, `source`, and `protected` are copied into each manifest entry so the
  result keeps the request's provenance.
- `modelId` comes from configuration, not from the SDK. `confidence` stays optional and is
  empty for `LLMDecisionModel`.

Keep policy: a chunk is dropped on one of two paths. Every other combination is kept.

1. Model verdict: `outcome` is `decided`, `decision` is `irrelevant`, and the worker
   verified the content hash.
2. Earlier duplicate (added 2026-11-03): `outcome` is `duplicate`.

Confidence thresholds stay off until a provider is measured on the labeled set.

Duplicate content: the coordinator hashes eligible chunks. An eligible chunk whose exact
content (same SHA-256) appears again later among eligible chunks is not published. The
coordinator writes its result directly with `outcome: duplicate`, `decision: irrelevant`,
`keep: false`, `reasonCode: duplicate`, and a reason naming the ordinal of the last copy.
Only the last copy is classified. If it is kept for any reason, including a failure or a
timeout, the content survives. If the model drops it, every copy was irrelevant. Protected
chunks are never deduplicated and do not count as a later copy. Coordinator-written results
count as resolved, like publish failures, so the job completes without waiting for them.
Metrics count them in `chunks.duplicate`, separately from `decided`.

This replaces the earlier design, in which the coordinator sent the earlier copy a
`laterDuplicateOrdinal` hint and left the drop to the model. Haiku 4.5 and Haiku 5.5 both
ignored the hint and kept the earlier copy in `basic-task`, so the hint field was removed
from the chunk message.

### Claude Code transcript mapping

- Only entries after the most recent compact boundary are sent, because only those are in
  the live context.
- User text maps to `user`. Assistant text maps to `assistant`.
- Each `tool_use` block is paired with its `tool_result` into one chunk. `Read` results map
  to `file` with the file path as `source`. Other tools map to `tool-result` with the tool
  name as `source`.
- The compaction summary message and the most recent human-typed prompt are protected.
  The service also protects every other `user` chunk (see Request contract).
- Thinking blocks are excluded. They are signed, model-internal, and cannot be replayed in
  a new session. Their count appears in the adapter's parse statistics.
- Sidechain (subagent) entries and bookkeeping entries such as `file-history-snapshot`,
  `progress`, `queue-operation`, and `mode` are skipped.

### Handoff

- The hook blocks the `/annihilate` expansion in every case: success, service failure, or
  crash. The hook entry sets `onFailure: "block"`, so the old session gets no model turn
  even if the hook cannot start.
- The new session starts with `claude --bg --name <unique-name> <prompt>`. The launcher
  refuses to pass `--resume`, `--continue`, `--fork-session`, or the old session ID.
- A single argv string is limited to 128 KiB on Linux. Seeds up to 96 KiB go inline as the
  first prompt. Larger seeds are written to the plugin data directory, which is added
  with `--add-dir`, and the inline prompt carries the summary, the next action, and the
  file path.
- The adapter finds the new session's ID with `claude agents --json` by matching the
  unique name, and returns it in the block reason.
- If the service fails, the adapter launches nothing and reports the error. The old
  session stays as it was, which is the fail-open state for a handoff.

## Consequences

- Requirements: Claude Code v2.1.295 or later (for `onFailure`, `UserPromptExpansion`, and
  agent view), and Node.js 22 or later for the hook process.
- Evaluation reports must read `outcome`, not `decision`, to separate model abstentions
  from infrastructure failures.
- A Strands Decider or System One provider can fill `confidence` later without a contract
  change.
