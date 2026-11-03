/**
 * Local harness: submit a fixture or a Claude Code transcript, poll until the job finishes,
 * and print the ordered decisions. Writes machine-readable JSON with --out.
 *
 *   npm run harness -- --fixture test/fixtures/basic-task.json
 *   npm run harness -- --transcript ~/.claude/projects/<dir>/<session>.jsonl --prompt "next step"
 *
 * Options: --stack (default $STACK_NAME or context-annihilator), --region, --profile,
 * --timeout <seconds> (default 240), --out <file>, --reuse (keep the fixture requestId
 * instead of adding a run suffix, to test idempotent resubmission).
 *
 * Exit code 1 when the job fails, protected context is dropped, or a labeled
 * required/supporting chunk is dropped.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { AnnihilatorClient } from '../src/client/service-client.js'
import type { JobResult } from '../src/contracts/api.js'
import type { StartJobRequest } from '../src/contracts/context.js'
import { DEFAULT_LIMITS } from '../src/contracts/limits.js'
import { parseClaudeTranscript } from '../src/hosts/claude-code/transcript.js'

type Label = 'required' | 'supporting' | 'irrelevant'
type Fixture = { version?: number; description?: string; labels?: Record<string, { label: Label; note?: string }>; request: StartJobRequest }

const { values } = parseArgs({
  options: {
    fixture: { type: 'string' },
    transcript: { type: 'string' },
    prompt: { type: 'string' },
    stack: { type: 'string', default: process.env.STACK_NAME ?? 'context-annihilator' },
    region: { type: 'string' },
    profile: { type: 'string' },
    timeout: { type: 'string', default: '240' },
    out: { type: 'string' },
    reuse: { type: 'boolean', default: false },
  },
})

function pad(text: string, width: number): string {
  const clipped = text.length > width ? `${text.slice(0, width - 1)}…` : text
  return clipped.padEnd(width)
}

async function loadRequest(): Promise<{ request: StartJobRequest; labels: Fixture['labels'] }> {
  if (values.fixture) {
    const parsed = JSON.parse(await readFile(values.fixture, 'utf8')) as Fixture | StartJobRequest
    const fixture: Fixture = 'request' in parsed ? parsed : { request: parsed }
    const request = { ...fixture.request }
    if (!values.reuse) request.requestId = `${request.requestId}.${Date.now().toString(36)}`
    return { request, labels: fixture.labels }
  }
  if (values.transcript) {
    const transcript = parseClaudeTranscript(await readFile(values.transcript, 'utf8'), {
      maxChunkBytes: DEFAULT_LIMITS.maxChunkBytes,
      ignoredCommands: ['annihilate', 'context-annihilator:annihilate'],
    })
    console.error(`parsed ${transcript.chunks.length} chunks`, JSON.stringify(transcript.stats))
    return {
      request: {
        requestId: `harness.${Date.now().toString(36)}`,
        host: 'harness',
        currentPrompt: values.prompt ?? 'Continue the current task from where the earlier session stopped.',
        chunks: transcript.chunks,
      },
      labels: undefined,
    }
  }
  throw new Error('pass --fixture <file> or --transcript <file>')
}

function report(result: JobResult, labels: Fixture['labels']): { problems: string[] } {
  const problems: string[] = []
  console.log(`job ${result.jobId}  status ${result.status}${result.failure ? `  failure: ${result.failure}` : ''}`)
  console.log('')
  console.log(`${pad('ord', 4)} ${pad('keep', 5)} ${pad('decision', 11)} ${pad('outcome', 10)} ${pad('kind', 12)} ${pad('source', 30)} ${pad('label', 11)} reason`)
  for (const entry of result.manifest ?? []) {
    const label = labels?.[entry.chunkId]?.label
    let flag = ''
    if (entry.protected && !entry.keep) {
      flag = '  << PROTECTED DROP'
      problems.push(`protected chunk ${entry.chunkId} was dropped`)
    } else if (label && label !== 'irrelevant' && !entry.keep) {
      flag = '  << FALSE DROP'
      problems.push(`labeled ${label} chunk ${entry.chunkId} was dropped`)
    } else if (label === 'irrelevant' && entry.keep && entry.outcome === 'decided') {
      flag = '  (false keep)'
    }
    console.log(
      `${pad(String(entry.ordinal), 4)} ${pad(entry.keep ? 'yes' : 'NO', 5)} ${pad(entry.decision, 11)} ${pad(entry.outcome, 10)} ` +
        `${pad(entry.kind, 12)} ${pad(entry.source ?? '', 30)} ${pad(label ?? '-', 11)} ${entry.reason}${flag}`,
    )
  }
  console.log('\nTask summary:\n')
  console.log(result.summary ?? '(none)')
  console.log('\nMetrics:\n')
  console.log(JSON.stringify(result.metrics, null, 2))
  if (result.status !== 'complete') problems.push(`job status is ${result.status}`)
  return { problems }
}

async function main() {
  const { request, labels } = await loadRequest()
  const client = new AnnihilatorClient({
    stackName: values.stack as string,
    ...(values.region && { region: values.region }),
    ...(values.profile && { profile: values.profile }),
  })
  const startedAt = Date.now()
  const started = await client.startJob(request)
  console.error(`started job ${started.jobId} (${started.eligibleCount} eligible, ${started.protectedCount} protected, duplicate=${started.duplicate})`)
  const result = await client.waitForResult(started.jobId, {
    pollIntervalMs: started.pollAfterMs,
    timeoutMs: Number(values.timeout) * 1000,
    onProgress: (r) => console.error(`  ${r.status}: ${r.progress.resolved}/${r.progress.eligible} resolved`),
  })
  const clientWallMs = Date.now() - startedAt
  const { problems } = report(result, labels)
  console.log(`\nclient wall-clock: ${clientWallMs} ms`)
  if (values.out) {
    await writeFile(values.out, JSON.stringify({ request: { requestId: request.requestId, host: request.host }, clientWallMs, problems, result }, null, 2))
    console.error(`wrote ${values.out}`)
  }
  if (problems.length > 0) {
    console.error(`\nproblems:\n- ${problems.join('\n- ')}`)
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
