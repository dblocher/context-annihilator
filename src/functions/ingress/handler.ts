import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { LambdaClient } from '@aws-sdk/client-lambda'
import { S3Client } from '@aws-sdk/client-s3'
import { LambdaCoordinatorTrigger } from '../../adapters/lambda/coordinator-trigger.js'
import { DynamoDbJobStore } from '../../adapters/storage/dynamodb-job-store.js'
import { S3PayloadStore } from '../../adapters/storage/s3-payload-store.js'
import type { ApiResponse, StartJobResponse } from '../../contracts/api.js'
import { describeError } from '../../domain/decisions/policy.js'
import { startJob, type StartJobDeps } from '../../domain/jobs/start-job.js'
import { intEnv, limitsFromEnv, requireEnv } from '../shared/env.js'
import { emitMetrics, logEvent } from '../shared/observability.js'
import { fail } from '../shared/responses.js'

const jobTtlSeconds = intEnv('JOB_TTL_SECONDS', 86_400, 60)

const deps: StartJobDeps = {
  store: new DynamoDbJobStore(new DynamoDBClient({}), requireEnv('TABLE_NAME'), jobTtlSeconds),
  payloads: new S3PayloadStore(new S3Client({}), requireEnv('BUCKET_NAME')),
  trigger: new LambdaCoordinatorTrigger(new LambdaClient({}), requireEnv('COORDINATOR_FUNCTION_NAME')),
  limits: limitsFromEnv(),
  now: () => new Date(),
  settings: {
    coordinatorDeadlineMs: intEnv('COORDINATOR_DEADLINE_MS', 180_000, 1_000),
    jobTtlSeconds,
    pollAfterMs: intEnv('POLL_AFTER_MS', 1_500, 100),
  },
}

/** Direct, IAM-authenticated invocation. The payload is a `StartJobRequest`. */
export const handler = async (event: unknown): Promise<ApiResponse<StartJobResponse>> => {
  const startedAt = Date.now()
  try {
    const result = await startJob(deps, event)
    if (result.ok) {
      const { jobId, duplicate, chunkCount, eligibleCount, protectedCount } = result.value
      logEvent('info', 'job.accepted', { jobId, duplicate, chunkCount, eligibleCount, protectedCount })
      emitMetrics(
        { JobsAccepted: { value: duplicate ? 0 : 1, unit: 'Count' }, IngressMs: { value: Date.now() - startedAt, unit: 'Milliseconds' } },
        { jobId },
      )
    } else {
      const first = result.error.issues?.[0]
      logEvent('warn', 'job.rejected', {
        code: result.error.code,
        message: result.error.message,
        issueCount: result.error.issues?.length ?? 0,
        firstIssue: first ? `${first.path} ${first.code}` : undefined,
      })
      emitMetrics({ JobsRejected: { value: 1, unit: 'Count' } })
    }
    return result
  } catch (error) {
    logEvent('error', 'job.ingress-error', { error: describeError(error) })
    return fail('internal', 'internal error; see function logs')
  }
}
