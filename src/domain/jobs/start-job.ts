import type { ApiResponse, StartJobResponse } from '../../contracts/api.js'
import type { RequestLimits } from '../../contracts/limits.js'
import { validateStartJobRequest } from '../../contracts/validation.js'
import { describeError } from '../decisions/policy.js'
import { jobIdFor, sha256Hex } from '../util/hash.js'
import { payloadKeys, type JobRecord } from './model.js'
import type { CoordinatorTrigger, JobStore, PayloadStore } from './ports.js'

export type StartJobDeps = {
  store: JobStore
  payloads: PayloadStore
  trigger: CoordinatorTrigger
  limits: RequestLimits
  now: () => Date
  settings: {
    /** Measured from job creation. A job not dispatched by then is reported as failed. */
    coordinatorDeadlineMs: number
    jobTtlSeconds: number
    pollAfterMs: number
  }
}

function response(job: JobRecord, duplicate: boolean, pollAfterMs: number): ApiResponse<StartJobResponse> {
  return {
    ok: true,
    value: {
      jobId: job.jobId,
      duplicate,
      chunkCount: job.chunkCount,
      eligibleCount: job.eligibleCount,
      protectedCount: job.protectedCount,
      pollAfterMs,
    },
  }
}

function existingJobResponse(
  existing: JobRecord,
  requestHash: string,
  pollAfterMs: number,
): ApiResponse<StartJobResponse> {
  if (existing.requestHash === requestHash) return response(existing, true, pollAfterMs)
  return {
    ok: false,
    error: { code: 'conflict', message: 'requestId was already used for a request with different content' },
  }
}

/**
 * Validates the request, stores the full payload in S3, records the job, and starts the
 * coordinator asynchronously. Idempotent per (host, requestId).
 */
export async function startJob(deps: StartJobDeps, input: unknown): Promise<ApiResponse<StartJobResponse>> {
  const validation = validateStartJobRequest(input, deps.limits)
  if (!validation.ok) {
    return { ok: false, error: { code: 'invalid-request', message: 'request failed validation', issues: validation.issues } }
  }
  const request = validation.value
  const jobId = jobIdFor(request.host, request.requestId)
  const requestHash = sha256Hex(JSON.stringify(request))
  const { pollAfterMs } = deps.settings

  const existing = await deps.store.getJob(jobId)
  if (existing) return existingJobResponse(existing, requestHash, pollAfterMs)

  const requestKey = payloadKeys.request(jobId, requestHash)
  await deps.payloads.putJson(requestKey, request)

  const now = deps.now()
  const protectedCount = request.chunks.filter((chunk) => chunk.protected).length
  const job: JobRecord = {
    jobId,
    requestId: request.requestId,
    host: request.host,
    requestHash,
    requestKey,
    status: 'accepted',
    createdAt: now.toISOString(),
    coordinatorDeadlineAt: new Date(now.getTime() + deps.settings.coordinatorDeadlineMs).toISOString(),
    chunkCount: request.chunks.length,
    eligibleCount: request.chunks.length - protectedCount,
    protectedCount,
    expiresAt: Math.floor(now.getTime() / 1000) + deps.settings.jobTtlSeconds,
  }

  if ((await deps.store.createJob(job)) === 'exists') {
    const raced = await deps.store.getJob(jobId)
    if (raced) return existingJobResponse(raced, requestHash, pollAfterMs)
  }

  try {
    await deps.trigger.start(jobId)
  } catch (error) {
    const failure = `could not start coordinator: ${describeError(error)}`
    await deps.store.updateJob(jobId, { status: 'failed', failure }, { fromStatuses: ['accepted'] })
    return { ok: false, error: { code: 'internal', message: failure } }
  }
  return response(job, false, pollAfterMs)
}
