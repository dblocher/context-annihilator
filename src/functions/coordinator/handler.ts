import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { SNSClient } from '@aws-sdk/client-sns'
import { BedrockTaskSummarizer } from '../../adapters/bedrock/task-summarizer.js'
import { SnsChunkPublisher } from '../../adapters/messaging/sns-chunk-publisher.js'
import { DynamoDbJobStore } from '../../adapters/storage/dynamodb-job-store.js'
import { S3PayloadStore } from '../../adapters/storage/s3-payload-store.js'
import { JOB_ID_PATTERN } from '../../contracts/limits.js'
import type { CoordinatorEvent } from '../../contracts/messages.js'
import { runCoordinator, type CoordinatorDeps } from '../../domain/jobs/run-coordinator.js'
import { intEnv, optionalNumberEnv, requireEnv } from '../shared/env.js'
import { emitMetrics, logEvent } from '../shared/observability.js'

const summaryTemperature = optionalNumberEnv('SUMMARY_TEMPERATURE', 0, 1)

const deps: CoordinatorDeps = {
  store: new DynamoDbJobStore(new DynamoDBClient({}), requireEnv('TABLE_NAME'), intEnv('JOB_TTL_SECONDS', 86_400, 60)),
  payloads: new S3PayloadStore(new S3Client({}), requireEnv('BUCKET_NAME')),
  publisher: new SnsChunkPublisher(new SNSClient({}), requireEnv('TOPIC_ARN'), intEnv('PUBLISH_CONCURRENCY', 8, 1)),
  summarizer: new BedrockTaskSummarizer(new BedrockRuntimeClient({}), {
    modelId: requireEnv('SUMMARY_MODEL_ID'),
    maxTokens: intEnv('SUMMARY_MAX_TOKENS', 1_500, 64),
    maxWords: intEnv('SUMMARY_MAX_WORDS', 450, 50),
    maxChars: intEnv('SUMMARY_MAX_CHARS', 6_000, 500),
    ...(summaryTemperature !== undefined && { temperature: summaryTemperature }),
  }),
  now: () => new Date(),
  settings: {
    decisionDeadlineMs: intEnv('DECISION_DEADLINE_MS', 60_000, 1_000),
    summaryBudgetChars: intEnv('SUMMARY_INPUT_BUDGET_CHARS', 400_000, 1_000),
    summaryPerChunkChars: intEnv('SUMMARY_PER_CHUNK_CHARS', 6_000, 200),
    storeConcurrency: intEnv('STORE_CONCURRENCY', 16, 1),
  },
}

/** Invoked asynchronously by ingress with `{ jobId }`. */
export const handler = async (event: CoordinatorEvent): Promise<void> => {
  const jobId = event?.jobId
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) {
    logEvent('error', 'coordinator.invalid-event')
    return
  }
  const startedAt = Date.now()
  const outcome = await runCoordinator(deps, jobId)
  const totalMs = Date.now() - startedAt

  if (outcome.status === 'dispatched') {
    logEvent('info', 'coordinator.dispatched', { jobId, ...outcome })
    emitMetrics(
      {
        SummaryMs: { value: outcome.summaryMs, unit: 'Milliseconds' },
        PublishMs: { value: outcome.dispatchMs, unit: 'Milliseconds' },
        CoordinatorMs: { value: totalMs, unit: 'Milliseconds' },
        ChunksPublished: { value: outcome.published, unit: 'Count' },
        DuplicateChunks: { value: outcome.duplicates, unit: 'Count' },
        PublishFailures: { value: outcome.publishFailures, unit: 'Count' },
      },
      { jobId },
    )
  } else if (outcome.status === 'failed') {
    logEvent('error', 'coordinator.failed', { jobId, failure: outcome.failure })
    emitMetrics({ CoordinatorFailures: { value: 1, unit: 'Count' } }, { jobId })
  } else {
    logEvent('warn', 'coordinator.skipped', { jobId, reason: outcome.reason })
  }
}
