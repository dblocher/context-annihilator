import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client } from '@aws-sdk/client-s3'
import { DynamoDbJobStore } from '../../adapters/storage/dynamodb-job-store.js'
import { S3PayloadStore } from '../../adapters/storage/s3-payload-store.js'
import type { ApiResponse, JobResult } from '../../contracts/api.js'
import { describeError } from '../../domain/decisions/policy.js'
import { getResult, type ResultDeps } from '../../domain/jobs/get-result.js'
import { intEnv, requireEnv } from '../shared/env.js'
import { emitMetrics, logEvent } from '../shared/observability.js'
import { fail } from '../shared/responses.js'

const deps: ResultDeps = {
  store: new DynamoDbJobStore(new DynamoDBClient({}), requireEnv('TABLE_NAME'), intEnv('JOB_TTL_SECONDS', 86_400, 60)),
  payloads: new S3PayloadStore(new S3Client({}), requireEnv('BUCKET_NAME')),
  now: () => new Date(),
  settings: {
    inlineMaxBytes: intEnv('INLINE_RESULT_MAX_BYTES', 5_000_000, 1_024),
    urlTtlSeconds: intEnv('RESULT_URL_TTL_SECONDS', 300, 30),
  },
}

/** Direct, IAM-authenticated invocation with `{ jobId, includeContent? }`. */
export const handler = async (event: unknown): Promise<ApiResponse<JobResult>> => {
  try {
    const { response, frozeNow, result } = await getResult(deps, event)
    const metrics = result?.metrics
    if (frozeNow && result && metrics) {
      logEvent('info', 'job.finished', {
        jobId: result.jobId,
        status: result.status,
        failure: result.failure,
        eligible: metrics.chunks.eligible,
        dropped: metrics.chunks.dropped,
        failed: metrics.chunks.failed,
        timedOut: metrics.chunks.timedOut,
        eligibleReduction: metrics.tokens.eligibleReduction,
        ingressToLastResultMs: metrics.timings.ingressToLastResultMs,
      })
      emitMetrics(
        {
          JobsCompleted: { value: result.status === 'complete' ? 1 : 0, unit: 'Count' },
          JobsFailed: { value: result.status === 'failed' ? 1 : 0, unit: 'Count' },
          ChunksTimedOut: { value: metrics.chunks.timedOut, unit: 'Count' },
          EligibleTokenReductionPercent: { value: metrics.tokens.eligibleReduction * 100, unit: 'Percent' },
          ...(metrics.timings.ingressToLastResultMs !== undefined && {
            IngressToLastResultMs: { value: metrics.timings.ingressToLastResultMs, unit: 'Milliseconds' },
          }),
        },
        { jobId: result.jobId },
      )
    }
    return response
  } catch (error) {
    logEvent('error', 'result.error', { error: describeError(error) })
    return fail('internal', 'internal error; see function logs')
  }
}
