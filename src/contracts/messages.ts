import type { ContextKind } from './context.js'

/** Payload of the asynchronous ingress-to-coordinator invocation. */
export type CoordinatorEvent = {
  jobId: string
}

/**
 * One SNS message per eligible chunk. It carries references and a hash, not chunk content.
 * The summary travels inline because it is derived, bounded, and needed by every worker.
 */
export type ChunkTaskMessage = {
  v: 1
  jobId: string
  chunkId: string
  ordinal: number
  kind: ContextKind
  source?: string
  contentKey: string
  contentHash: string
  summary: string
  /** Ordinal of a later chunk with identical content, if one exists. */
  laterDuplicateOrdinal?: number
  publishedAt: string
  deadlineAt: string
}
