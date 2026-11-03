import type { ApiResponse, GetResultRequest, JobResult } from '../../contracts/api.js'
import type { StartJobRequest } from '../../contracts/context.js'
import { JOB_ID_PATTERN } from '../../contracts/limits.js'
import { utf8Bytes } from '../../contracts/validation.js'
import { assembleResult, resolveJobState } from '../aggregation/assemble.js'
import { randomToken } from '../util/hash.js'
import { payloadKeys } from './model.js'
import type { JobStore, PayloadStore } from './ports.js'

export type ResultDeps = {
  store: JobStore
  payloads: PayloadStore
  now: () => Date
  settings: {
    inlineMaxBytes: number
    urlTtlSeconds: number
  }
}

export type ResultOutcome = { response: ApiResponse<JobResult>; frozeNow: boolean; result?: JobResult }

function parseRequest(input: unknown): GetResultRequest | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const { jobId, includeContent } = input as Record<string, unknown>
  if (typeof jobId !== 'string' || !JOB_ID_PATTERN.test(jobId)) return undefined
  if (includeContent !== undefined && typeof includeContent !== 'boolean') return undefined
  return { jobId, ...(includeContent !== undefined && { includeContent }) }
}

/** Applies `includeContent` and swaps retained content for a short-lived URL when too large. */
async function shape(deps: ResultDeps, full: JobResult, key: string, includeContent: boolean): Promise<JobResult> {
  const { retained, ...withoutContent } = full
  if (!includeContent) return withoutContent
  if (utf8Bytes(JSON.stringify(full)) <= deps.settings.inlineMaxBytes) return full
  return { ...withoutContent, fullResultUrl: await deps.payloads.presignGet(key, deps.settings.urlTtlSeconds) }
}

/**
 * Returns job progress, or the final ordered result. The first call that sees a finished job
 * freezes the result in S3, and later calls return that frozen copy, so results that arrive
 * after the deadline cannot change a manifest the client already received.
 */
export async function getResult(deps: ResultDeps, input: unknown): Promise<ResultOutcome> {
  const request = parseRequest(input)
  if (!request) {
    return {
      response: { ok: false, error: { code: 'invalid-request', message: 'expected { jobId: string, includeContent?: boolean }' } },
      frozeNow: false,
    }
  }
  const includeContent = request.includeContent ?? true

  let job = await deps.store.getJob(request.jobId)
  if (!job) return { response: { ok: false, error: { code: 'not-found', message: 'job not found' } }, frozeNow: false }

  if (job.resultKey === undefined) {
    const results = await deps.store.listChunkResults(job.jobId)
    const state = resolveJobState(job, results.length, deps.now())
    if (state.status === 'running') {
      return { response: { ok: true, value: assembleResult({ job, state, results, includeContent: false }) }, frozeNow: false }
    }

    let source: StartJobRequest | undefined
    try {
      source = await deps.payloads.getJson<StartJobRequest>(job.requestKey)
    } catch (error) {
      if (state.status === 'complete') throw error
    }
    const full = assembleResult({ job, state, results, ...(source !== undefined && { request: source }), includeContent: true })
    const key = payloadKeys.result(job.jobId, randomToken(6))
    await deps.payloads.putJson(key, full)
    const frozen = await deps.store.updateJob(
      job.jobId,
      { resultKey: key, resultRecordedAt: deps.now().toISOString() },
      { ifMissing: 'resultKey' },
    )
    if (frozen === 'updated') {
      return { response: { ok: true, value: await shape(deps, full, key, includeContent) }, frozeNow: true, result: full }
    }
    job = (await deps.store.getJob(job.jobId)) ?? job
  }

  const key = job.resultKey as string
  const full = await deps.payloads.getJson<JobResult>(key)
  return { response: { ok: true, value: await shape(deps, full, key, includeContent) }, frozeNow: false }
}
