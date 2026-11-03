import { PublishBatchCommand, SNSClient, type PublishBatchRequestEntry } from '@aws-sdk/client-sns'
import type { ChunkTaskMessage } from '../../contracts/messages.js'
import { utf8Bytes } from '../../contracts/validation.js'
import type { ChunkPublisher, PublishFailure } from '../../domain/jobs/ports.js'
import { describeError } from '../../domain/decisions/policy.js'
import { mapWithConcurrency } from '../../domain/util/concurrency.js'

const MAX_BATCH_ENTRIES = 10
/** SNS caps a whole batch at 256 KiB; leave headroom for envelope overhead. */
const MAX_BATCH_BYTES = 240 * 1024

type Pending = { message: ChunkTaskMessage; body: string; bytes: number }

/** Publishes one SNS message per chunk using PublishBatch, with bounded batch concurrency. */
export class SnsChunkPublisher implements ChunkPublisher {
  constructor(
    private readonly client: SNSClient,
    private readonly topicArn: string,
    private readonly concurrency: number,
  ) {}

  async publish(messages: readonly ChunkTaskMessage[]): Promise<{ failures: PublishFailure[] }> {
    const failures: PublishFailure[] = []
    const batches: Pending[][] = []
    let current: Pending[] = []
    let currentBytes = 0

    for (const message of messages) {
      const body = JSON.stringify(message)
      const bytes = utf8Bytes(body)
      if (bytes > MAX_BATCH_BYTES) {
        failures.push({ chunkId: message.chunkId, error: `message is ${bytes} bytes, above the SNS limit` })
        continue
      }
      if (current.length === MAX_BATCH_ENTRIES || currentBytes + bytes > MAX_BATCH_BYTES) {
        batches.push(current)
        current = []
        currentBytes = 0
      }
      current.push({ message, body, bytes })
      currentBytes += bytes
    }
    if (current.length > 0) batches.push(current)

    const batchFailures = await mapWithConcurrency(batches, this.concurrency, (batch) => this.publishBatch(batch))
    for (const list of batchFailures) failures.push(...list)
    return { failures }
  }

  private async publishBatch(batch: Pending[]): Promise<PublishFailure[]> {
    const entries: PublishBatchRequestEntry[] = batch.map((pending, i) => ({ Id: `m${i}`, Message: pending.body }))
    try {
      const response = await this.client.send(
        new PublishBatchCommand({ TopicArn: this.topicArn, PublishBatchRequestEntries: entries }),
      )
      return (response.Failed ?? []).map((failed) => {
        const index = Number((failed.Id ?? 'm-1').slice(1))
        return {
          chunkId: batch[index]?.message.chunkId ?? 'unknown',
          error: `${failed.Code ?? 'PublishFailed'}: ${failed.Message ?? ''}`.trim(),
        }
      })
    } catch (error) {
      const description = describeError(error)
      return batch.map((pending) => ({ chunkId: pending.message.chunkId, error: description }))
    }
  }
}
