import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import {
  buildSummaryPrompt,
  SUMMARY_SYSTEM_PROMPT,
  type SummaryInput,
  type SummaryOutput,
  type TaskSummarizer,
} from '../../domain/summarization/summarizer.js'

export type BedrockSummarizerOptions = {
  modelId: string
  maxTokens: number
  maxWords: number
  /** Hard cap on stored summary length, so it fits inline in every SNS message. */
  maxChars: number
  temperature?: number
}

/** Generative task summarizer using the Bedrock Converse API. */
export class BedrockTaskSummarizer implements TaskSummarizer {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly options: BedrockSummarizerOptions,
  ) {}

  async summarize(input: SummaryInput): Promise<SummaryOutput> {
    const startedAt = Date.now()
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.options.modelId,
        system: [{ text: SUMMARY_SYSTEM_PROMPT }],
        messages: [{ role: 'user', content: [{ text: buildSummaryPrompt(input, this.options.maxWords) }] }],
        inferenceConfig: {
          maxTokens: this.options.maxTokens,
          ...(this.options.temperature !== undefined && { temperature: this.options.temperature }),
        },
      }),
    )
    const text = (response.output?.message?.content ?? [])
      .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
      .join('')
      .trim()
    if (text.length === 0) throw new Error(`summarizer returned no text (stopReason=${response.stopReason ?? 'unknown'})`)

    const summary = text.length > this.options.maxChars ? `${text.slice(0, this.options.maxChars)}\n[summary truncated]` : text
    return {
      summary,
      modelId: this.options.modelId,
      latencyMs: response.metrics?.latencyMs ?? Date.now() - startedAt,
      ...(response.usage && {
        usage: { inputTokens: response.usage.inputTokens ?? 0, outputTokens: response.usage.outputTokens ?? 0 },
      }),
    }
  }
}
