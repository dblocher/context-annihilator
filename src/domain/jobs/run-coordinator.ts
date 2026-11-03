import type { StartJobRequest } from '../../contracts/context.js'
import type { ChunkTaskMessage } from '../../contracts/messages.js'
import { laterDuplicateOrdinals } from '../aggregation/duplicates.js'
import { describeError, failedDecision } from '../decisions/policy.js'
import { renderSummaryTranscript, type TaskSummarizer } from '../summarization/summarizer.js'
import { mapWithConcurrency } from '../util/concurrency.js'
import { contentHash } from '../util/hash.js'
import { payloadKeys } from './model.js'
import type { ChunkPublisher, JobStore, PayloadStore } from './ports.js'

export type CoordinatorDeps = {
  store: JobStore
  payloads: PayloadStore
  publisher: ChunkPublisher
  summarizer: TaskSummarizer
  now: () => Date
  settings: {
    /** Measured from dispatch. Missing results after this are reported as timed out. */
    decisionDeadlineMs: number
    summaryBudgetChars: number
    summaryPerChunkChars: number
    storeConcurrency: number
  }
}

export type CoordinatorOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; failure: string }
  | { status: 'dispatched'; eligible: number; published: number; publishFailures: number; summaryMs: number; dispatchMs: number }

/**
 * Summarizes the task, stores eligible chunk content, records the decision deadline, and
 * publishes one SNS message per eligible chunk. Chunks whose publish fails get a `failed`
 * result immediately, so the job does not wait for the deadline on their account.
 */
export async function runCoordinator(deps: CoordinatorDeps, jobId: string): Promise<CoordinatorOutcome> {
  const { store, payloads, settings } = deps
  const job = await store.getJob(jobId)
  if (!job) return { status: 'skipped', reason: 'job not found' }

  const startedAt = deps.now()
  const claimed = await store.updateJob(
    jobId,
    { status: 'summarizing', coordinatorStartedAt: startedAt.toISOString() },
    { fromStatuses: ['accepted'] },
  )
  if (claimed === 'skipped') return { status: 'skipped', reason: `job is already ${job.status}` }

  let request: StartJobRequest
  try {
    request = await payloads.getJson<StartJobRequest>(job.requestKey)
    const transcript = renderSummaryTranscript(request, settings.summaryBudgetChars, settings.summaryPerChunkChars)
    const summaryStarted = Date.now()
    const summary = await deps.summarizer.summarize({ currentPrompt: request.currentPrompt, transcript })
    const summaryMs = Date.now() - summaryStarted

    const eligible = request.chunks.filter((chunk) => !chunk.protected)
    await mapWithConcurrency(eligible, settings.storeConcurrency, (chunk) =>
      payloads.putText(payloadKeys.chunk(jobId, chunk.ordinal), chunk.content),
    )

    const dispatchedAt = deps.now()
    const deadlineAt = new Date(dispatchedAt.getTime() + settings.decisionDeadlineMs).toISOString()
    const dispatched = await store.updateJob(
      jobId,
      {
        status: 'dispatched',
        summary: summary.summary,
        summaryModelId: summary.modelId,
        summaryMs,
        ...(summary.usage !== undefined && { summaryUsage: summary.usage }),
        dispatchedAt: dispatchedAt.toISOString(),
        deadlineAt,
      },
      { fromStatuses: ['summarizing'] },
    )
    if (dispatched === 'skipped') return { status: 'skipped', reason: 'job left the summarizing state' }

    const duplicates = laterDuplicateOrdinals(request.chunks)
    const publishedAt = deps.now().toISOString()
    const messages: ChunkTaskMessage[] = eligible.map((chunk) => {
      const later = duplicates.get(chunk.ordinal)
      return {
        v: 1,
        jobId,
        chunkId: chunk.id,
        ordinal: chunk.ordinal,
        kind: chunk.kind,
        ...(chunk.source !== undefined && { source: chunk.source }),
        contentKey: payloadKeys.chunk(jobId, chunk.ordinal),
        contentHash: contentHash(chunk.content),
        summary: summary.summary,
        ...(later !== undefined && { laterDuplicateOrdinal: later }),
        publishedAt,
        deadlineAt,
      }
    })

    const publishStarted = Date.now()
    const { failures } = await deps.publisher.publish(messages)
    const dispatchMs = Date.now() - publishStarted

    const byId = new Map(messages.map((message) => [message.chunkId, message]))
    await mapWithConcurrency(failures, settings.storeConcurrency, async (failure) => {
      const message = byId.get(failure.chunkId)
      if (!message) return
      const now = deps.now().toISOString()
      await store.putChunkResult({
        ...failedDecision(message.chunkId, message.contentHash, `publish failed: ${failure.error}`),
        jobId,
        ordinal: message.ordinal,
        publishedAt,
        workerStartedAt: now,
        writtenAt: now,
      })
    })

    return {
      status: 'dispatched',
      eligible: eligible.length,
      published: messages.length - failures.length,
      publishFailures: failures.length,
      summaryMs,
      dispatchMs,
    }
  } catch (error) {
    const failure = describeError(error)
    await store.updateJob(jobId, { status: 'failed', failure }, { fromStatuses: ['summarizing'] })
    return { status: 'failed', failure }
  }
}
