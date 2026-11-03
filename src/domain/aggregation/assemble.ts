import type { JobMetrics, JobResult, ManifestEntry, ResultStatus, RetainedChunk } from '../../contracts/api.js'
import type { StartJobRequest } from '../../contracts/context.js'
import type { ChunkDecision } from '../../contracts/decisions.js'
import { failedDecision, protectedDecision, timedOutDecision } from '../decisions/policy.js'
import type { ChunkResultRecord, JobRecord } from '../jobs/model.js'
import { contentHash } from '../util/hash.js'
import { latencyStats } from '../util/stats.js'
import { estimateTokens } from '../util/text.js'

export type JobState = { status: ResultStatus; failure?: string }

/**
 * Decides whether a job is still running. A dispatched job completes when every eligible
 * chunk has a result or its deadline passes; missing results then count as timed out.
 */
export function resolveJobState(job: JobRecord, resolvedCount: number, now: Date): JobState {
  if (job.status === 'failed') return { status: 'failed', failure: job.failure ?? 'job failed' }
  if (job.status === 'accepted' || job.status === 'summarizing') {
    if (now.getTime() > Date.parse(job.coordinatorDeadlineAt)) {
      return { status: 'failed', failure: 'the coordinator did not dispatch the job before its deadline' }
    }
    return { status: 'running' }
  }
  if (resolvedCount >= job.eligibleCount) return { status: 'complete' }
  if (job.deadlineAt !== undefined && now.getTime() > Date.parse(job.deadlineAt)) return { status: 'complete' }
  return { status: 'running' }
}

function ms(from?: string, to?: string): number | undefined {
  if (from === undefined || to === undefined) return undefined
  return Date.parse(to) - Date.parse(from)
}

export type AssembleInput = {
  job: JobRecord
  state: JobState
  results: readonly ChunkResultRecord[]
  /** Required unless the job is still running. */
  request?: StartJobRequest
  includeContent: boolean
}

/** Builds the ordered manifest, retained context, and metrics for a job. */
export function assembleResult({ job, state, results, request, includeContent }: AssembleInput): JobResult {
  const base: JobResult = {
    jobId: job.jobId,
    requestId: job.requestId,
    host: job.host,
    status: state.status,
    ...(state.failure !== undefined && { failure: state.failure }),
    progress: {
      eligible: job.eligibleCount,
      resolved: Math.min(results.length, job.eligibleCount),
      pending: Math.max(0, job.eligibleCount - results.length),
    },
    ...(job.summary !== undefined && { summary: job.summary }),
    ...(job.summaryModelId !== undefined && { summaryModelId: job.summaryModelId }),
  }
  if (state.status === 'running' || request === undefined) return base

  const byOrdinal = new Map(results.map((r) => [r.ordinal, r]))
  const manifest: ManifestEntry[] = []
  const retained: RetainedChunk[] = []

  for (const chunk of request.chunks) {
    const hash = contentHash(chunk.content)
    const stored = byOrdinal.get(chunk.ordinal)
    let decision: ChunkDecision
    if (chunk.protected) decision = protectedDecision(chunk.id, hash)
    else if (state.status === 'failed') decision = failedDecision(chunk.id, hash, `job failed: ${state.failure ?? 'unknown'}`)
    else if (stored !== undefined) decision = stored
    else decision = timedOutDecision(chunk.id, hash)

    manifest.push({
      chunkId: chunk.id,
      ordinal: chunk.ordinal,
      kind: chunk.kind,
      ...(chunk.source !== undefined && { source: chunk.source }),
      protected: chunk.protected,
      decision: decision.decision,
      keep: decision.keep,
      outcome: decision.outcome,
      reason: decision.reason,
      ...(decision.reasonCode !== undefined && { reasonCode: decision.reasonCode }),
      ...(decision.confidence !== undefined && { confidence: decision.confidence }),
      ...(decision.modelId !== undefined && { modelId: decision.modelId }),
      latencyMs: decision.latencyMs,
      contentHash: decision.contentHash,
      estimatedTokens: estimateTokens(chunk.content),
    })
    if (decision.keep && includeContent) {
      retained.push({
        chunkId: chunk.id,
        ordinal: chunk.ordinal,
        kind: chunk.kind,
        ...(chunk.source !== undefined && { source: chunk.source }),
        content: chunk.content,
      })
    }
  }

  return {
    ...base,
    currentPrompt: request.currentPrompt,
    manifest,
    ...(includeContent && { retained }),
    metrics: computeMetrics(job, request, manifest, results),
  }
}

function computeMetrics(
  job: JobRecord,
  request: StartJobRequest,
  manifest: readonly ManifestEntry[],
  results: readonly ChunkResultRecord[],
): JobMetrics {
  const eligible = manifest.filter((m) => !m.protected)
  const sum = (entries: readonly ManifestEntry[]) => entries.reduce((total, m) => total + m.estimatedTokens, 0)
  const eligibleInput = sum(eligible)
  const eligibleRetained = sum(eligible.filter((m) => m.keep))
  const promptTokens = estimateTokens(request.currentPrompt)

  const lastResultAt = results.reduce<string | undefined>(
    (latest, r) => (latest === undefined || r.writtenAt > latest ? r.writtenAt : latest),
    undefined,
  )
  const fanOutLags = results
    .map((r) => ms(r.publishedAt, r.workerStartedAt))
    .filter((v): v is number => v !== undefined)
  const decisionLatencies = results.filter((r) => r.outcome === 'decided').map((r) => r.latencyMs)
  const fanOutLagMs = latencyStats(fanOutLags)
  const decisionLatencyMs = latencyStats(decisionLatencies)
  const ingressToDispatchMs = ms(job.createdAt, job.dispatchedAt)
  const ingressToLastResultMs = ms(job.createdAt, lastResultAt)

  return {
    chunks: {
      total: manifest.length,
      protected: manifest.length - eligible.length,
      eligible: eligible.length,
      decided: eligible.filter((m) => m.outcome === 'decided').length,
      duplicate: eligible.filter((m) => m.outcome === 'duplicate').length,
      uncertain: eligible.filter((m) => m.outcome === 'decided' && m.decision === 'uncertain').length,
      failed: eligible.filter((m) => m.outcome === 'failed').length,
      timedOut: eligible.filter((m) => m.outcome === 'timed-out').length,
      dropped: manifest.filter((m) => !m.keep).length,
      retained: manifest.filter((m) => m.keep).length,
    },
    tokens: {
      eligibleInput,
      eligibleRetained,
      eligibleReduction: eligibleInput === 0 ? 0 : Number((1 - eligibleRetained / eligibleInput).toFixed(4)),
      totalInput: sum(manifest) + promptTokens,
      totalRetained: sum(manifest.filter((m) => m.keep)) + promptTokens,
    },
    timings: {
      receivedAt: job.createdAt,
      ...(job.coordinatorStartedAt !== undefined && { coordinatorStartedAt: job.coordinatorStartedAt }),
      ...(job.summaryMs !== undefined && { summaryMs: job.summaryMs }),
      ...(job.dispatchedAt !== undefined && { dispatchedAt: job.dispatchedAt }),
      ...(lastResultAt !== undefined && { lastResultAt }),
      ...(ingressToDispatchMs !== undefined && { ingressToDispatchMs }),
      ...(ingressToLastResultMs !== undefined && { ingressToLastResultMs }),
      ...(fanOutLagMs !== undefined && { fanOutLagMs }),
      ...(decisionLatencyMs !== undefined && { decisionLatencyMs }),
    },
    usage: {
      ...(job.summaryUsage !== undefined && {
        summaryInputTokens: job.summaryUsage.inputTokens,
        summaryOutputTokens: job.summaryUsage.outputTokens,
      }),
      decisionInputTokens: results.reduce((total, r) => total + (r.usage?.inputTokens ?? 0), 0),
      decisionOutputTokens: results.reduce((total, r) => total + (r.usage?.outputTokens ?? 0), 0),
    },
  }
}
