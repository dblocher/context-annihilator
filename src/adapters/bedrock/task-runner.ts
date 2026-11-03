import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { normalizeAnswer, TASK_ANSWER_TOOL, type TaskRunInput, type TaskRunner, type TaskRunOutput } from '../../evaluation/task.js'

export type BedrockTaskRunnerOptions = {
  modelId: string
  maxTokens: number
  temperature?: number
}

/** Evaluation task runs on the Bedrock Converse API, with the answer tool forced. */
export class BedrockTaskRunner implements TaskRunner {
  constructor(
    private readonly client: BedrockRuntimeClient,
    private readonly options: BedrockTaskRunnerOptions,
  ) {}

  async run(input: TaskRunInput): Promise<TaskRunOutput> {
    const startedAt = Date.now()
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.options.modelId,
        system: [{ text: input.system }],
        messages: [{ role: 'user', content: [{ text: input.context }] }],
        inferenceConfig: {
          maxTokens: this.options.maxTokens,
          ...(this.options.temperature !== undefined && { temperature: this.options.temperature }),
        },
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: TASK_ANSWER_TOOL.name,
                description: TASK_ANSWER_TOOL.description,
                inputSchema: { json: TASK_ANSWER_TOOL.inputSchema },
              },
            },
          ],
          toolChoice: { tool: { name: TASK_ANSWER_TOOL.name } },
        },
      }),
    )
    const toolUse = (response.output?.message?.content ?? []).find(
      (block) => 'toolUse' in block && block.toolUse?.name === TASK_ANSWER_TOOL.name,
    )?.toolUse
    if (!toolUse) throw new Error(`task model did not call ${TASK_ANSWER_TOOL.name} (stopReason=${response.stopReason ?? 'unknown'})`)
    return {
      answer: normalizeAnswer(toolUse.input),
      modelId: this.options.modelId,
      latencyMs: response.metrics?.latencyMs ?? Date.now() - startedAt,
      usage: { inputTokens: response.usage?.inputTokens ?? 0, outputTokens: response.usage?.outputTokens ?? 0 },
    }
  }
}
