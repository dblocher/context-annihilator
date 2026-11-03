export const RELEVANCE_LABELS = ['required', 'supporting', 'irrelevant'] as const
export type RelevanceLabel = (typeof RELEVANCE_LABELS)[number]

/** `uncertain` covers model abstentions and every chunk kept without a model verdict. */
export type DecisionLabel = RelevanceLabel | 'uncertain'

/**
 * Closed reason codes asked alongside the relevance label (ADR 0002).
 * Decision models cannot generate free text, so the reason is a second closed question.
 */
export const REASON_CODES = [
  'direct-dependency',
  'authoritative-constraint',
  'unresolved-issue',
  'useful-evidence',
  'continuity',
  'unrelated',
  'superseded',
  'duplicate',
] as const
export type ReasonCode = (typeof REASON_CODES)[number]

/**
 * Why a chunk has the decision it has. Only `decided` chunks (model verdict `irrelevant`) and
 * `duplicate` chunks (an earlier exact copy of a later eligible chunk) can be dropped.
 */
export type DecisionOutcome = 'decided' | 'duplicate' | 'protected' | 'failed' | 'timed-out'

export type ChunkDecision = {
  chunkId: string
  decision: DecisionLabel
  keep: boolean
  reason: string
  reasonCode?: ReasonCode
  outcome: DecisionOutcome
  confidence?: number
  modelId?: string
  latencyMs: number
  contentHash: string
}
