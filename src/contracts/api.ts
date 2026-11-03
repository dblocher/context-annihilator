import type { ContextKind } from './context.js'
import type { DecisionLabel, DecisionOutcome, ReasonCode } from './decisions.js'

export type ValidationIssue = {
  path: string
  code: string
  message: string
}

export type ApiErrorCode = 'invalid-request' | 'conflict' | 'not-found' | 'internal'

export type ApiError = {
  code: ApiErrorCode
  message: string
  issues?: ValidationIssue[]
}

/** Lambda functions are invoked directly, so errors travel in the payload, not as HTTP codes. */
export type ApiResponse<T> = { ok: true; value: T } | { ok: false; error: ApiError }

export type StartJobResponse = {
  jobId: string
  /** True when the same request was already accepted and this call returned the existing job. */
  duplicate: boolean
  chunkCount: number
  eligibleCount: number
  protectedCount: number
  pollAfterMs: number
}

export type GetResultRequest = {
  jobId: string
  /** When false, the result omits retained chunk content. Defaults to true. */
  includeContent?: boolean
}

export type ResultStatus = 'running' | 'complete' | 'failed'

export type ManifestEntry = {
  chunkId: string
  ordinal: number
  kind: ContextKind
  source?: string
  protected: boolean
  decision: DecisionLabel
  keep: boolean
  outcome: DecisionOutcome
  reason: string
  reasonCode?: ReasonCode
  confidence?: number
  modelId?: string
  latencyMs: number
  contentHash: string
  /** Rough estimate: UTF-8 characters divided by 4. */
  estimatedTokens: number
}

export type RetainedChunk = {
  chunkId: string
  ordinal: number
  kind: ContextKind
  source?: string
  content: string
}

export type LatencyStats = { count: number; p50: number; p95: number; max: number }

export type JobMetrics = {
  chunks: {
    total: number
    protected: number
    eligible: number
    decided: number
    uncertain: number
    failed: number
    timedOut: number
    dropped: number
    retained: number
  }
  /** Token counts are estimates (characters / 4), not tokenizer output. */
  tokens: {
    eligibleInput: number
    eligibleRetained: number
    /** Fraction of eligible input tokens removed, 0 to 1. */
    eligibleReduction: number
    totalInput: number
    totalRetained: number
  }
  timings: {
    receivedAt: string
    coordinatorStartedAt?: string
    summaryMs?: number
    dispatchedAt?: string
    lastResultAt?: string
    ingressToDispatchMs?: number
    ingressToLastResultMs?: number
    fanOutLagMs?: LatencyStats
    decisionLatencyMs?: LatencyStats
  }
  usage: {
    summaryInputTokens?: number
    summaryOutputTokens?: number
    decisionInputTokens: number
    decisionOutputTokens: number
  }
}

export type JobResult = {
  jobId: string
  requestId: string
  host: string
  status: ResultStatus
  /** Present when status is `failed`. Every chunk is kept in that case. */
  failure?: string
  progress: { eligible: number; resolved: number; pending: number }
  summary?: string
  summaryModelId?: string
  currentPrompt?: string
  /** Every chunk in original order, including protected and dropped ones. Present when not running. */
  manifest?: ManifestEntry[]
  /** Kept chunks in original order. Omitted when `includeContent` is false or the payload is too large. */
  retained?: RetainedChunk[]
  /** Short-lived URL for the full result JSON when it is too large to return inline. */
  fullResultUrl?: string
  metrics?: JobMetrics
}
