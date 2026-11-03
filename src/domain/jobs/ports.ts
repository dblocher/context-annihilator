import type { ChunkTaskMessage } from '../../contracts/messages.js'
import type { ChunkResultRecord, JobRecord, JobStatus } from './model.js'

export type UpdateCondition = {
  fromStatuses?: JobStatus[]
  ifMissing?: keyof JobRecord
}

export interface JobStore {
  getJob(jobId: string): Promise<JobRecord | undefined>
  /** Conditional create. Returns `exists` when a job with this ID is already stored. */
  createJob(job: JobRecord): Promise<'created' | 'exists'>
  /**
   * Applies a partial update to an existing job. Returns `skipped` when the condition fails:
   * `fromStatuses` limits the update to those states, and `ifMissing` requires that field to be unset.
   */
  updateJob(jobId: string, patch: Partial<Omit<JobRecord, 'jobId'>>, condition?: UpdateCondition): Promise<'updated' | 'skipped'>
  getChunkResult(jobId: string, ordinal: number): Promise<ChunkResultRecord | undefined>
  /** Conditional put. Returns `duplicate` when a result for this chunk already exists. */
  putChunkResult(result: ChunkResultRecord): Promise<'written' | 'duplicate'>
  listChunkResults(jobId: string): Promise<ChunkResultRecord[]>
}

export interface PayloadStore {
  putJson(key: string, value: unknown): Promise<void>
  getJson<T>(key: string): Promise<T>
  putText(key: string, text: string): Promise<void>
  getText(key: string): Promise<string>
  presignGet(key: string, expiresInSeconds: number): Promise<string>
}

export type PublishFailure = { chunkId: string; error: string }

export interface ChunkPublisher {
  publish(messages: readonly ChunkTaskMessage[]): Promise<{ failures: PublishFailure[] }>
}

export interface CoordinatorTrigger {
  start(jobId: string): Promise<void>
}
