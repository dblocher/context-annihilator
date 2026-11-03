---
status: accepted
date: 2026-10-29
---

# ADR 0001: Chunk fan-out mechanism for the MVP

## Context

Each `/annihilate` call produces one task summary and N eligible context chunks. Every
chunk needs one closed-question relevance decision. The calls are independent, so they can
run in parallel. The caller is a Claude Code hook waiting interactively. The experiment
also wants to learn whether asynchronous SNS fan-out is a workable shape for this, so the
mechanism itself is under test.

Drivers, in order:

1. Fidelity to the fan-out experiment (the seed names SNS as the initial mechanism).
2. Interactive latency: the hook blocks until the seed is ready.
3. Operational complexity for a single-user stack.
4. Fail-open behavior: a lost or slow decision must keep the chunk.

## Options

### 1. SNS fan-out, DynamoDB aggregation, client polling

The coordinator publishes one SNS message per eligible chunk. SNS invokes a decision Lambda
asynchronously for each message. Workers write one conditional result item each. A result
Lambda aggregates on read, and the client polls it.

- Latency: SNS delivery plus one concurrent cold start per worker, plus up to one poll
  interval. Lambda's async retries back off by minutes, which is useless for an
  interactive caller, so retries must be off and the deadline does the work.
- Complexity: highest of the three. Delivery is at least once, so workers need
  idempotent writes. Nothing aggregates replies, so completion and timeout are computed
  from the job record, a deadline, and a result count. Two failure paths need queues: SNS
  delivery failures and async invocation failures.
- Fidelity: full. This is the mechanism under test.
- Limits: 256 KiB per SNS message, so messages carry S3 references and hashes, not chunk
  content.

### 2. Step Functions Express with an inline `Map`

One synchronous Express execution runs the summarizer, then a `Map` over chunk
references, and returns the aggregated array.

- Latency: no polling, because `StartSyncExecution` returns the result. Per-item Lambda
  invocations still pay cold starts.
- Complexity: moderate. Aggregation, per-item retry, and catch-to-default are built in.
  State payloads are capped at 256 KiB, so results still go through S3 or DynamoDB for
  large jobs. Inline `Map` concurrency is capped (40 iterations), and Express executions
  are capped at 5 minutes.
- Fidelity: low. It replaces the SNS mechanism instead of measuring it.

### 3. Direct bounded concurrency in one coordinator

One Lambda summarizes, then runs `Promise` pools of decision calls against Bedrock.

- Latency: lowest. One cold start, warm SDK clients, and no polling or queue hops. Bedrock
  throughput quotas are the real concurrency limit in every option.
- Complexity: lowest. No topic, no aggregation table, no DLQ.
- Fidelity: none for fan-out. A single function crash loses all in-flight decisions, so
  fail-open depends on in-process error handling.

## Decision

Use option 1, SNS plus DynamoDB aggregation and polling, for the MVP.

The experiment exists partly to measure this mechanism, and options 2 and 3 cannot answer
that question. The added complexity is bounded: one topic, one worker subscription, one
table, two DLQs.

To keep the comparison cheap later:

- Decision logic lives in `src/domain/decisions` and takes no SNS or Lambda types. Options 2
  and 3 can call the same `classifyChunk` function.
- Every stage records timestamps: ingress received, coordinator start, summary start and
  end, publish time per chunk, worker start, decision latency, and result write. The
  result endpoint reports fan-out lag (worker start minus publish), decision latency
  percentiles, and wall-clock time from ingress to the last result.

## Consequences

- Worker async invocation config: `MaximumRetryAttempts: 0`,
  `MaximumEventAgeInSeconds: 60`, and an SQS on-failure destination. The SNS subscription
  has its own redrive DLQ. Missing results after the job deadline are reported as
  `timed-out` and kept.
- Workers check for an existing result before calling the model and write with
  `attribute_not_exists`, so duplicate deliveries cost at most one extra read.
- The client polls the result Lambda. The poll interval is client-side configuration.
- The ingress Lambda returns as soon as the job is accepted and invokes the coordinator
  asynchronously. It never waits for decisions.
- Revisit this decision after measuring. If fan-out lag or cold starts dominate, prototype
  option 3 behind the same `classifyChunk` interface before trying option 2.
