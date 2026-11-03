import type { ChunkDecision } from '../../contracts/decisions.js'

export type JobStatus = 'accepted' | 'summarizing' | 'dispatched' | 'failed'

export type TokenUsage = { inputTokens: number; outputTokens: number }

/** Transient job metadata stored in DynamoDB with a TTL. Contains no chunk content. */
export type JobRecord = {
  jobId: string
  requestId: string
  host: string
  requestHash: string
  requestKey: string
  status: JobStatus
  createdAt: string
  /** After this time, a job that never reached `dispatched` is reported as failed. */
  coordinatorDeadlineAt: string
  chunkCount: number
  eligibleCount: number
  protectedCount: number
  coordinatorStartedAt?: string
  summary?: string
  summaryModelId?: string
  summaryMs?: number
  summaryUsage?: TokenUsage
  dispatchedAt?: string
  /** After this time, missing chunk results are reported as timed out and kept. */
  deadlineAt?: string
  failure?: string
  /**
   * S3 key of the frozen result. The first poll that sees the job finished writes it, and
   * later polls return it unchanged, so late worker results cannot change a reported manifest.
   */
  resultKey?: string
  resultRecordedAt?: string
  /** Epoch seconds for DynamoDB TTL. */
  expiresAt: number
}

/** One idempotent result per eligible chunk. The first write wins. */
export type ChunkResultRecord = ChunkDecision & {
  jobId: string
  ordinal: number
  publishedAt?: string
  workerStartedAt: string
  writtenAt: string
  usage?: TokenUsage
}

export const payloadKeys = {
  request: (jobId: string, requestHash: string) => `jobs/${jobId}/request-${requestHash.slice(0, 12)}.json`,
  chunk: (jobId: string, ordinal: number) => `jobs/${jobId}/chunks/${ordinal}.txt`,
  result: (jobId: string, token: string) => `jobs/${jobId}/result-${token}.json`,
}
