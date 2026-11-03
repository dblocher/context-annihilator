import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import type { SNSEvent } from 'aws-lambda'
import { DynamoDbJobStore } from '../../adapters/storage/dynamodb-job-store.js'
import { S3PayloadStore } from '../../adapters/storage/s3-payload-store.js'
import { StrandsRelevanceClassifier } from '../../adapters/strands/relevance-classifier.js'
import { parseChunkTaskMessage, processChunkTask, type WorkerDeps } from '../../domain/jobs/process-chunk.js'
import { boolEnv, intEnv, optionalNumberEnv, requireEnv } from '../shared/env.js'
import { emitMetrics, logEvent } from '../shared/observability.js'

const temperature = optionalNumberEnv('DECISION_TEMPERATURE', 0, 1)
const minConfidence = optionalNumberEnv('UNCERTAINTY_MIN_CONFIDENCE', 0, 1)

const deps: WorkerDeps = {
  store: new DynamoDbJobStore(new DynamoDBClient({}), requireEnv('TABLE_NAME'), intEnv('JOB_TTL_SECONDS', 86_400, 60)),
  payloads: new S3PayloadStore(new S3Client({}), requireEnv('BUCKET_NAME')),
  classifier: new StrandsRelevanceClassifier({
    modelId: requireEnv('DECISION_MODEL_ID'),
    region: requireEnv('AWS_REGION'),
    maxTokens: intEnv('DECISION_MAX_TOKENS', 300, 32),
    ...(temperature !== undefined && { temperature }),
    requestTimeoutMs: intEnv('DECISION_REQUEST_TIMEOUT_MS', 30_000, 1_000),
    allowUncertain: boolEnv('ALLOW_UNCERTAIN', true),
    ...(minConfidence !== undefined && { minConfidence }),
  }),
  now: () => new Date(),
  settings: { staleGraceMs: intEnv('STALE_GRACE_MS', 5_000, 0) },
}

/** SNS subscription target. SNS delivers one record per invocation; the loop is defensive. */
export const handler = async (event: SNSEvent): Promise<void> => {
  for (const record of event.Records) {
    const message = parseChunkTaskMessage(record.Sns.Message)
    if (!message) {
      logEvent('error', 'chunk.invalid-message', { snsMessageId: record.Sns.MessageId })
      emitMetrics({ InvalidMessages: { value: 1, unit: 'Count' } })
      continue
    }
    const outcome = await processChunkTask(deps, message)
    const decision = outcome.decision
    logEvent(outcome.status === 'written' ? 'info' : 'warn', `chunk.${outcome.status}`, {
      jobId: message.jobId,
      ordinal: message.ordinal,
      kind: message.kind,
      outcome: decision?.outcome,
      decision: decision?.decision,
      keep: decision?.keep,
      reasonCode: decision?.reasonCode,
      failure: decision?.outcome === 'failed' ? decision.reason : undefined,
      latencyMs: decision?.latencyMs,
      fanOutLagMs: outcome.fanOutLagMs,
    })

    const metrics: Parameters<typeof emitMetrics>[0] = {}
    if (outcome.fanOutLagMs !== undefined) metrics.FanOutLagMs = { value: outcome.fanOutLagMs, unit: 'Milliseconds' }
    if (outcome.status === 'duplicate-delivery') metrics.DuplicateDeliveries = { value: 1, unit: 'Count' }
    if (outcome.status === 'stale') metrics.StaleDeliveries = { value: 1, unit: 'Count' }
    if (outcome.status === 'written' && decision) {
      metrics.ChunksDecided = { value: decision.outcome === 'decided' ? 1 : 0, unit: 'Count' }
      metrics.ChunkFailures = { value: decision.outcome === 'failed' ? 1 : 0, unit: 'Count' }
      metrics.ChunksUncertain = { value: decision.decision === 'uncertain' ? 1 : 0, unit: 'Count' }
      metrics.ChunksDropped = { value: decision.keep ? 0 : 1, unit: 'Count' }
      if (decision.outcome === 'decided') metrics.DecisionLatencyMs = { value: decision.latencyMs, unit: 'Milliseconds' }
    }
    emitMetrics(metrics, { jobId: message.jobId })
  }
}
