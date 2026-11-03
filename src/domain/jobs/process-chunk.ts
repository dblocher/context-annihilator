import { CONTEXT_KINDS, type ContextKind } from '../../contracts/context.js'
import type { ChunkDecision } from '../../contracts/decisions.js'
import { JOB_ID_PATTERN } from '../../contracts/limits.js'
import type { ChunkTaskMessage } from '../../contracts/messages.js'
import type { RelevanceClassifier } from '../decisions/classifier.js'
import { classifyChunk, describeError, failedDecision } from '../decisions/policy.js'
import { contentHash } from '../util/hash.js'
import { payloadKeys, type TokenUsage } from './model.js'
import type { JobStore, PayloadStore } from './ports.js'

export type WorkerDeps = {
  store: JobStore
  payloads: PayloadStore
  classifier: RelevanceClassifier
  now: () => Date
  settings: {
    /** Messages received this long after the job deadline are skipped without a model call. */
    staleGraceMs: number
  }
}

export type WorkerOutcome = {
  status: 'written' | 'duplicate-delivery' | 'stale' | 'invalid'
  decision?: ChunkDecision
  usage?: TokenUsage
  fanOutLagMs?: number
}

const KIND_SET: ReadonlySet<string> = new Set(CONTEXT_KINDS)

/** Parses and checks an SNS message body. Returns undefined for anything malformed. */
export function parseChunkTaskMessage(body: string): ChunkTaskMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const m = value as Partial<ChunkTaskMessage>
  const valid =
    m.v === 1 &&
    typeof m.jobId === 'string' &&
    JOB_ID_PATTERN.test(m.jobId) &&
    typeof m.chunkId === 'string' &&
    typeof m.ordinal === 'number' &&
    Number.isSafeInteger(m.ordinal) &&
    m.ordinal >= 0 &&
    typeof m.kind === 'string' &&
    KIND_SET.has(m.kind) &&
    (m.source === undefined || typeof m.source === 'string') &&
    m.contentKey === payloadKeys.chunk(m.jobId, m.ordinal) &&
    typeof m.contentHash === 'string' &&
    typeof m.summary === 'string' &&
    (m.laterDuplicateOrdinal === undefined || Number.isSafeInteger(m.laterDuplicateOrdinal)) &&
    typeof m.publishedAt === 'string' &&
    typeof m.deadlineAt === 'string' &&
    !Number.isNaN(Date.parse(m.publishedAt)) &&
    !Number.isNaN(Date.parse(m.deadlineAt))
  return valid ? ({ ...m, kind: m.kind as ContextKind } as ChunkTaskMessage) : undefined
}

/**
 * Classifies one chunk and writes exactly one result. Duplicate deliveries are detected
 * before the model call and again by the conditional write. Content that fails to load or
 * does not match the published hash becomes a `failed` result, which keeps the chunk.
 */
export async function processChunkTask(deps: WorkerDeps, message: ChunkTaskMessage): Promise<WorkerOutcome> {
  const startedAt = deps.now()
  const fanOutLagMs = startedAt.getTime() - Date.parse(message.publishedAt)

  if (startedAt.getTime() > Date.parse(message.deadlineAt) + deps.settings.staleGraceMs) {
    return { status: 'stale', fanOutLagMs }
  }
  if (await deps.store.getChunkResult(message.jobId, message.ordinal)) {
    return { status: 'duplicate-delivery', fanOutLagMs }
  }

  const { decision, usage } = await decide(deps, message)
  const written = await deps.store.putChunkResult({
    ...decision,
    jobId: message.jobId,
    ordinal: message.ordinal,
    publishedAt: message.publishedAt,
    workerStartedAt: startedAt.toISOString(),
    writtenAt: deps.now().toISOString(),
    ...(usage !== undefined && { usage }),
  })
  return {
    status: written === 'written' ? 'written' : 'duplicate-delivery',
    decision,
    ...(usage !== undefined && { usage }),
    fanOutLagMs,
  }
}

async function decide(deps: WorkerDeps, message: ChunkTaskMessage): Promise<{ decision: ChunkDecision; usage?: TokenUsage }> {
  let content: string
  try {
    content = await deps.payloads.getText(message.contentKey)
  } catch (error) {
    return { decision: failedDecision(message.chunkId, message.contentHash, `content load failed: ${describeError(error)}`) }
  }
  if (contentHash(content) !== message.contentHash) {
    return { decision: failedDecision(message.chunkId, message.contentHash, 'content hash mismatch') }
  }
  return classifyChunk(deps.classifier, {
    chunkId: message.chunkId,
    contentHash: message.contentHash,
    summary: message.summary,
    ordinal: message.ordinal,
    kind: message.kind,
    ...(message.source !== undefined && { source: message.source }),
    content,
    ...(message.laterDuplicateOrdinal !== undefined && { laterDuplicateOrdinal: message.laterDuplicateOrdinal }),
  })
}
