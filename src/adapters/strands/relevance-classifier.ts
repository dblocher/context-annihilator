import { BedrockModel, LLMDecisionModel, Uncertain, type DecisionModel } from '@strands-agents/sdk'
import type { ReasonCode, RelevanceLabel } from '../../contracts/decisions.js'
import type { ClassificationInput, ClassificationOutput, RelevanceClassifier } from '../../domain/decisions/classifier.js'
import { DECISION_SYSTEM_PROMPT, REASON_QUESTION, RELEVANCE_QUESTION } from '../../domain/decisions/questions.js'
import { buildDecisionState } from '../../domain/decisions/state.js'

export type StrandsClassifierOptions = {
  modelId: string
  region: string
  /** Output budget for the structured-output tool call. */
  maxTokens: number
  /** Omit to use the model default. */
  temperature?: number
  requestTimeoutMs: number
  /** Whether the model may answer `uncertain`. Uncertain chunks are kept. */
  allowUncertain: boolean
  /** Only read by providers that return confidence. `LLMDecisionModel` ignores it. */
  minConfidence?: number
}

/**
 * Relevance classifier backed by the Strands `DecisionModel` abstraction, using
 * `LLMDecisionModel` over a Bedrock model. Asks two closed questions in one call:
 * the relevance label and a reason code.
 */
export class StrandsRelevanceClassifier implements RelevanceClassifier {
  private readonly decisionModel: DecisionModel

  constructor(private readonly options: StrandsClassifierOptions, decisionModel?: DecisionModel) {
    this.decisionModel =
      decisionModel ??
      new LLMDecisionModel({
        model: new BedrockModel({
          modelId: options.modelId,
          region: options.region,
          maxTokens: options.maxTokens,
          ...(options.temperature !== undefined && { temperature: options.temperature }),
          requestTimeout: options.requestTimeoutMs,
        }),
        systemPrompt: DECISION_SYSTEM_PROMPT,
      })
  }

  async classify(input: ClassificationInput): Promise<ClassificationOutput> {
    const uncertainty = this.options.allowUncertain
      ? this.options.minConfidence !== undefined
        ? { minConfidence: this.options.minConfidence }
        : true
      : false

    const result = await this.decisionModel.ask(buildDecisionState(input), {
      relevance: { question: RELEVANCE_QUESTION.question, choices: RELEVANCE_QUESTION.choices, uncertainty },
      reason: { question: REASON_QUESTION.question, choices: REASON_QUESTION.choices },
    })

    const relevance: RelevanceLabel | Uncertain = result.answers.relevance
    const reason: ReasonCode | Uncertain = result.answers.reason
    const usage = result.usage
      ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
      : undefined

    return {
      label: relevance instanceof Uncertain ? 'uncertain' : relevance,
      ...(relevance instanceof Uncertain && relevance.reason !== undefined && { uncertainReason: relevance.reason }),
      ...(!(reason instanceof Uncertain) && { reasonCode: reason }),
      modelId: this.options.modelId,
      latencyMs: result.metadata.latencyMs,
      ...(usage !== undefined && { usage }),
    }
  }
}
