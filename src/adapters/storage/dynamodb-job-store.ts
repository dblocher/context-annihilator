import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb'
import type { ChunkResultRecord, JobRecord } from '../../domain/jobs/model.js'
import type { JobStore, UpdateCondition } from '../../domain/jobs/ports.js'

/**
 * Single-table layout:
 * - job:    pk = JOB#<jobId>, sk = META
 * - result: pk = JOB#<jobId>, sk = CHUNK#<ordinal, zero padded>
 * Both carry `expiresAt` (epoch seconds) for TTL.
 */
const META = 'META'
const CHUNK_PREFIX = 'CHUNK#'
const jobPk = (jobId: string) => `JOB#${jobId}`
const chunkSk = (ordinal: number) => `${CHUNK_PREFIX}${String(ordinal).padStart(8, '0')}`

function strip<T>(item: Record<string, unknown>): T {
  const { pk: _pk, sk: _sk, ...rest } = item
  return rest as T
}

function isConditionalFailure(error: unknown): boolean {
  return error instanceof ConditionalCheckFailedException || (error as { name?: string })?.name === 'ConditionalCheckFailedException'
}

export class DynamoDbJobStore implements JobStore {
  private readonly doc: DynamoDBDocumentClient

  constructor(
    client: DynamoDBClient,
    private readonly tableName: string,
    private readonly resultTtlSeconds: number,
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } })
  }

  async getJob(jobId: string): Promise<JobRecord | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: jobPk(jobId), sk: META }, ConsistentRead: true }),
    )
    return Item ? strip<JobRecord>(Item) : undefined
  }

  async createJob(job: JobRecord): Promise<'created' | 'exists'> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { pk: jobPk(job.jobId), sk: META, ...job },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      )
      return 'created'
    } catch (error) {
      if (isConditionalFailure(error)) return 'exists'
      throw error
    }
  }

  async updateJob(
    jobId: string,
    patch: Partial<Omit<JobRecord, 'jobId'>>,
    { fromStatuses, ifMissing }: UpdateCondition = {},
  ): Promise<'updated' | 'skipped'> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return 'skipped'
    const names: Record<string, string> = { '#pk': 'pk' }
    const values: Record<string, unknown> = {}
    const sets = entries.map(([key, value], i) => {
      names[`#f${i}`] = key
      values[`:v${i}`] = value
      return `#f${i} = :v${i}`
    })
    let condition = 'attribute_exists(#pk)'
    if (fromStatuses && fromStatuses.length > 0) {
      names['#status'] = 'status'
      const placeholders = fromStatuses.map((status, i) => {
        values[`:s${i}`] = status
        return `:s${i}`
      })
      condition += ` AND #status IN (${placeholders.join(', ')})`
    }
    if (ifMissing !== undefined) {
      names['#missing'] = ifMissing
      condition += ' AND attribute_not_exists(#missing)'
    }
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: jobPk(jobId), sk: META },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      )
      return 'updated'
    } catch (error) {
      if (isConditionalFailure(error)) return 'skipped'
      throw error
    }
  }

  async getChunkResult(jobId: string, ordinal: number): Promise<ChunkResultRecord | undefined> {
    const { Item } = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: jobPk(jobId), sk: chunkSk(ordinal) }, ConsistentRead: true }),
    )
    return Item ? strip<ChunkResultRecord & { expiresAt?: number }>(Item) : undefined
  }

  async putChunkResult(result: ChunkResultRecord): Promise<'written' | 'duplicate'> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: jobPk(result.jobId),
            sk: chunkSk(result.ordinal),
            ...result,
            expiresAt: Math.floor(Date.now() / 1000) + this.resultTtlSeconds,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      )
      return 'written'
    } catch (error) {
      if (isConditionalFailure(error)) return 'duplicate'
      throw error
    }
  }

  async listChunkResults(jobId: string): Promise<ChunkResultRecord[]> {
    const results: ChunkResultRecord[] = []
    let startKey: QueryCommandOutput['LastEvaluatedKey']
    do {
      const page: QueryCommandOutput = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': jobPk(jobId), ':prefix': CHUNK_PREFIX },
          ConsistentRead: true,
          ...(startKey && { ExclusiveStartKey: startKey }),
        }),
      )
      for (const item of page.Items ?? []) results.push(strip<ChunkResultRecord>(item))
      startKey = page.LastEvaluatedKey
    } while (startKey)
    return results
  }
}
