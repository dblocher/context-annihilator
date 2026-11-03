import type { ContextKind } from '../../contracts/context.js'
import type { ReasonCode, RelevanceLabel } from '../../contracts/decisions.js'
import type { TokenUsage } from '../jobs/model.js'

export type ClassificationInput = {
  summary: string
  ordinal: number
  kind: ContextKind
  source?: string
  content: string
  laterDuplicateOrdinal?: number
}

export type ClassificationOutput = {
  label: RelevanceLabel | 'uncertain'
  reasonCode?: ReasonCode
  /** Free-form reason supplied with an abstention, when the provider gives one. */
  uncertainReason?: string
  confidence?: number
  modelId?: string
  latencyMs: number
  usage?: TokenUsage
}

/**
 * Provider-neutral relevance classifier. The Strands `LLMDecisionModel` adapter is the first
 * implementation; a Strands Decider HTTP adapter can implement the same interface later.
 */
export interface RelevanceClassifier {
  classify(input: ClassificationInput): Promise<ClassificationOutput>
}
