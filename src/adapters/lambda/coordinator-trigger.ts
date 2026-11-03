import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import type { CoordinatorEvent } from '../../contracts/messages.js'
import type { CoordinatorTrigger } from '../../domain/jobs/ports.js'

/** Starts the coordinator with an asynchronous invocation so ingress returns immediately. */
export class LambdaCoordinatorTrigger implements CoordinatorTrigger {
  constructor(
    private readonly client: LambdaClient,
    private readonly functionName: string,
  ) {}

  async start(jobId: string): Promise<void> {
    const event: CoordinatorEvent = { jobId }
    const response = await this.client.send(
      new InvokeCommand({
        FunctionName: this.functionName,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify(event)),
      }),
    )
    if (response.StatusCode !== 202) throw new Error(`coordinator invoke returned status ${response.StatusCode}`)
  }
}
