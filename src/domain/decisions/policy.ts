import type { ChunkDecision, DecisionLabel, ReasonCode } from '../../contracts/decisions.js'
import type { TokenUsage } from '../jobs/model.js'
import type { ClassificationInput, ClassificationOutput, RelevanceClassifier } from './classifier.js'

const REASON_TEXT: Record<ReasonCode, string> = {
  'direct-dependency': 'the task directly needs this content',
  'authoritative-constraint': 'states a constraint or decision the task must follow',
  'unresolved-issue': 'contains an unresolved error or open question',
  'useful-evidence': 'useful evidence for the task',
  continuity: 'keeps the work history coherent',
  unrelated: 'unrelated to the current task',
  superseded: 'superseded by later context',
  duplicate: 'repeats content that appears later',
}

/**
 * The two paths to a drop (ADR 0002): a model verdict of `irrelevant` on hash-verified
 * content, or a `duplicate` outcome, where the coordinator found an identical later eligible
 * copy that is classified in its place.
 */
export function shouldKeep(outcome: ChunkDecision['outcome'], decision: DecisionLabel): boolean {
  if (outcome === 'duplicate') return false
  return !(outcome === 'decided' && decision === 'irrelevant')
}

/** Reasons that argue for keeping a chunk. An `irrelevant` label with one of these is contradictory. */
const KEEP_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'direct-dependency',
  'authoritative-constraint',
  'unresolved-issue',
])

export function decisionFromClassification(output: ClassificationOutput, contentHash: string, chunkId: string): ChunkDecision {
  if (output.label === 'irrelevant' && output.reasonCode !== undefined && KEEP_REASONS.has(output.reasonCode)) {
    output = {
      ...output,
      label: 'uncertain',
      uncertainReason: `contradictory verdict (irrelevant with reason ${output.reasonCode})`,
    }
  }
  const reason =
    output.label === 'uncertain'
      ? `uncertain: ${output.uncertainReason?.trim() || 'the model declined to choose a label'}; kept by policy`
      : `${output.label}: ${output.reasonCode ? REASON_TEXT[output.reasonCode] : 'no reason given'}`
  return {
    chunkId,
    decision: output.label,
    keep: shouldKeep('decided', output.label),
    reason,
    ...(output.reasonCode !== undefined && { reasonCode: output.reasonCode }),
    outcome: 'decided',
    ...(output.confidence !== undefined && { confidence: output.confidence }),
    ...(output.modelId !== undefined && { modelId: output.modelId }),
    latencyMs: output.latencyMs,
    contentHash,
  }
}

export function protectedDecision(chunkId: string, contentHash: string): ChunkDecision {
  return {
    chunkId,
    decision: 'required',
    keep: true,
    reason: 'protected: never classified',
    outcome: 'protected',
    latencyMs: 0,
    contentHash,
  }
}

/** An earlier exact copy of a later eligible chunk. Dropped without a model call. */
export function duplicateDecision(chunkId: string, contentHash: string, lastCopyOrdinal: number): ChunkDecision {
  return {
    chunkId,
    decision: 'irrelevant',
    keep: shouldKeep('duplicate', 'irrelevant'),
    reason: `duplicate: identical content appears later at #${lastCopyOrdinal}`,
    reasonCode: 'duplicate',
    outcome: 'duplicate',
    latencyMs: 0,
    contentHash,
  }
}

export function failedDecision(chunkId: string, contentHash: string, error: string, latencyMs = 0): ChunkDecision {
  return {
    chunkId,
    decision: 'uncertain',
    keep: true,
    reason: `failed: ${error}; kept by policy`,
    outcome: 'failed',
    latencyMs,
    contentHash,
  }
}

export function timedOutDecision(chunkId: string, contentHash: string): ChunkDecision {
  return {
    chunkId,
    decision: 'uncertain',
    keep: true,
    reason: 'timed out: no result before the job deadline; kept by policy',
    outcome: 'timed-out',
    latencyMs: 0,
    contentHash,
  }
}

/** Short, content-free error description safe for results and logs. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.replace(/\s+/g, ' ').slice(0, 200)
    return `${error.name}: ${message}`
  }
  return 'unknown error'
}

/**
 * Classifies one chunk and maps the outcome to a decision. Never throws: any classifier
 * error becomes a `failed` decision, which keeps the chunk.
 */
export async function classifyChunk(
  classifier: RelevanceClassifier,
  input: ClassificationInput & { chunkId: string; contentHash: string },
): Promise<{ decision: ChunkDecision; usage?: TokenUsage }> {
  const startedAt = Date.now()
  try {
    const output = await classifier.classify(input)
    return {
      decision: decisionFromClassification(output, input.contentHash, input.chunkId),
      ...(output.usage !== undefined && { usage: output.usage }),
    }
  } catch (error) {
    return { decision: failedDecision(input.chunkId, input.contentHash, describeError(error), Date.now() - startedAt) }
  }
}
