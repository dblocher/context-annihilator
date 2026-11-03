// Offline smoke test. Exercises the real domain use cases and the real Strands adapter with
// in-memory ports and a fake DecisionModel. No AWS calls.
//
//   npx --yes node@22 node_modules/tsx/dist/cli.mjs test/smoke/pipeline.mts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DecisionModel, Uncertain } from '@strands-agents/sdk'

const src = (path: string) => new URL(`../../src/${path}`, import.meta.url).href
const { validateStartJobRequest } = await import(src('contracts/validation.ts'))
const { DEFAULT_LIMITS } = await import(src('contracts/limits.ts'))
const { startJob } = await import(src('domain/jobs/start-job.ts'))
const { runCoordinator } = await import(src('domain/jobs/run-coordinator.ts'))
const { processChunkTask, parseChunkTaskMessage } = await import(src('domain/jobs/process-chunk.ts'))
const { getResult } = await import(src('domain/jobs/get-result.ts'))
const { StrandsRelevanceClassifier } = await import(src('adapters/strands/relevance-classifier.ts'))
const { parseClaudeTranscript } = await import(src('hosts/claude-code/transcript.ts'))
const { renderSeed, planLaunch } = await import(src('hosts/claude-code/seed.ts'))
const { buildBackgroundArgs } = await import(src('hosts/claude-code/launcher.ts'))
const { splitByBytes } = await import(src('domain/chunking/split.ts'))

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`ok - ${name}`)
}

// ---------- validation ----------
const fixture = JSON.parse(readFileSync(new URL('../fixtures/basic-task.json', import.meta.url), 'utf8'))
const base = fixture.request
const codes = (input: unknown) => {
  const r = validateStartJobRequest(input, DEFAULT_LIMITS)
  return r.ok ? [] : r.issues.map((i: { code: string }) => i.code)
}
check('fixture request is valid', () => assert.deepEqual(codes(base), []))
check('rejects duplicate chunk ids', () => {
  const chunks = structuredClone(base.chunks)
  chunks[2].id = chunks[1].id
  assert.ok(codes({ ...base, chunks }).includes('duplicate'))
})
check('rejects non-increasing and invalid ordinals', () => {
  const chunks = structuredClone(base.chunks)
  chunks[3].ordinal = 1
  chunks[4].ordinal = -2
  const c = codes({ ...base, chunks })
  assert.ok(c.includes('order') && c.includes('format'))
})
check('rejects unknown kinds', () => {
  const chunks = structuredClone(base.chunks)
  chunks[1].kind = 'memo'
  assert.ok(codes({ ...base, chunks }).includes('unknown-kind'))
})
check('rejects oversized content', () => {
  const chunks = structuredClone(base.chunks)
  chunks[1].content = 'x'.repeat(DEFAULT_LIMITS.maxChunkBytes + 1)
  assert.ok(codes({ ...base, chunks }).includes('too-large'))
})
check('rejects authoritative kinds marked removable', () => {
  const chunks = structuredClone(base.chunks)
  chunks[0].protected = false
  assert.ok(codes({ ...base, chunks }).includes('authoritative-removable'))
})
check('rejects unknown fields', () => assert.ok(codes({ ...base, extra: 1 }).includes('unknown-field')))

// ---------- in-memory ports ----------
let clock = Date.parse('2026-10-29T12:00:00.000Z')
const now = () => new Date(clock)

class MemoryStore {
  jobs = new Map<string, any>()
  results = new Map<string, any>()
  async getJob(id: string) { return this.jobs.has(id) ? structuredClone(this.jobs.get(id)) : undefined }
  async createJob(job: any) { if (this.jobs.has(job.jobId)) return 'exists'; this.jobs.set(job.jobId, structuredClone(job)); return 'created' }
  async updateJob(id: string, patch: any, cond: any = {}) {
    const job = this.jobs.get(id)
    if (!job) return 'skipped'
    if (cond.fromStatuses && !cond.fromStatuses.includes(job.status)) return 'skipped'
    if (cond.ifMissing && job[cond.ifMissing] !== undefined) return 'skipped'
    Object.assign(job, structuredClone(patch))
    return 'updated'
  }
  async getChunkResult(id: string, ordinal: number) { return this.results.get(`${id}#${ordinal}`) }
  async putChunkResult(r: any) {
    const key = `${r.jobId}#${r.ordinal}`
    if (this.results.has(key)) return 'duplicate'
    this.results.set(key, structuredClone(r))
    return 'written'
  }
  async listChunkResults(id: string) { return [...this.results.values()].filter((r) => r.jobId === id) }
}
class MemoryPayloads {
  objects = new Map<string, string>()
  async putJson(k: string, v: unknown) { this.objects.set(k, JSON.stringify(v)) }
  async getJson(k: string) { const v = this.objects.get(k); if (v === undefined) throw new Error(`NoSuchKey ${k}`); return JSON.parse(v) }
  async putText(k: string, t: string) { this.objects.set(k, t) }
  async getText(k: string) { const v = this.objects.get(k); if (v === undefined) throw new Error(`NoSuchKey ${k}`); return v }
  async presignGet(k: string) { return `https://example.invalid/${k}` }
}

// ---------- fake DecisionModel behind the real Strands adapter ----------
const labels: Record<string, { label: string }> = fixture.labels
const contentById = new Map<string, string>(base.chunks.map((c: any) => [c.id, c.content]))
const askedQuestions: any[] = []
class FakeDecisionModel extends DecisionModel {
  protected async _ask(state: any, questions: any): Promise<any> {
    askedQuestions.push(questions)
    const text = String(state)
    let id = [...contentById.entries()].find(([, content]) => text.includes(content))?.[0]
    // c07 and c10 have identical content; only the earlier copy carries the duplicate hint.
    if (id === 'c07-test-failure-first' && !text.includes('identical copy')) id = 'c10-test-failure-latest'
    if (id === 'c03-read-date-ts') throw new Error('ThrottlingException: simulated')
    if (id === 'c11-assistant-next') return { answers: { relevance: new Uncertain('not enough information'), reasonCode: new Uncertain() }, metadata: { latencyMs: 7 } }
    const label = id ? labels[id]?.label ?? 'supporting' : 'supporting'
    const reason = label === 'irrelevant' ? (id === 'c07-test-failure-first' ? 'duplicate' : 'unrelated') : label === 'required' ? 'direct-dependency' : 'continuity'
    return { answers: { relevance: label, reasonCode: reason }, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, metadata: { latencyMs: 12 } }
  }
}
const classifier = new StrandsRelevanceClassifier(
  { modelId: 'fake-model', region: 'us-east-1', maxTokens: 300, requestTimeoutMs: 1000, allowUncertain: true },
  new FakeDecisionModel(),
)

// ---------- pipeline ----------
const store = new MemoryStore()
const payloads = new MemoryPayloads()
const published: any[] = []
const workerDeps = { store, payloads, classifier, now, settings: { staleGraceMs: 5_000 } }
const publisher = {
  async publish(messages: any[]) {
    for (const m of messages) published.push(parseChunkTaskMessage(JSON.stringify(m)))
    const failures = messages.filter((m) => m.chunkId === 'c06-revised-plan').map((m) => ({ chunkId: m.chunkId, error: 'InternalError: simulated' }))
    const deliver = messages.filter((m) => m.chunkId !== 'c06-revised-plan' && m.chunkId !== 'c09-read-test')
    // Parallel fan-out, with a concurrent duplicate delivery of c05.
    const dup = deliver.find((m) => m.chunkId === 'c05-stale-error')
    await Promise.all([...deliver, dup].map((m) => processChunkTask(workerDeps, parseChunkTaskMessage(JSON.stringify(m)))))
    return { failures }
  },
}
const summarizer = { async summarize() { return { summary: 'Goal: fix parseIsoDate offset handling. Constraint: Node 18, no new deps.', modelId: 'fake-summary', latencyMs: 30, usage: { inputTokens: 900, outputTokens: 60 } } } }
const startDeps = {
  store, payloads, now, limits: DEFAULT_LIMITS,
  trigger: { async start() {} },
  settings: { coordinatorDeadlineMs: 180_000, jobTtlSeconds: 86_400, pollAfterMs: 1_000 },
}

const started = await startJob(startDeps, base)
assert.equal(started.ok, true)
const jobId = started.value.jobId
check('ingress counts eligible and protected chunks', () => {
  assert.equal(started.value.eligibleCount, 11)
  assert.equal(started.value.protectedCount, 1)
  assert.equal(started.value.duplicate, false)
})
const again = await startJob(startDeps, base)
check('resubmitting the same request is idempotent', () => assert.ok(again.ok && again.value.jobId === jobId && again.value.duplicate))
const changed = await startJob(startDeps, { ...base, currentPrompt: 'something else' })
check('same requestId with different content is a conflict', () => assert.ok(!changed.ok && changed.error.code === 'conflict'))

const running = await getResult({ store, payloads, now, settings: { inlineMaxBytes: 5_000_000, urlTtlSeconds: 300 } }, { jobId })
check('result is running before dispatch', () => assert.equal(running.response.value.status, 'running'))

const coordinatorDeps = {
  store, payloads, publisher, summarizer, now,
  settings: { decisionDeadlineMs: 60_000, summaryBudgetChars: 400_000, summaryPerChunkChars: 6_000, storeConcurrency: 4 },
}
const outcome = await runCoordinator(coordinatorDeps, jobId)
check('coordinator dispatched with one publish failure', () => {
  assert.equal(outcome.status, 'dispatched')
  assert.equal(outcome.publishFailures, 1)
})
const second = await runCoordinator(coordinatorDeps, jobId)
check('duplicate coordinator invocation is skipped', () => assert.equal(second.status, 'skipped'))
check('every published message parses and carries no chunk content', () => {
  assert.equal(published.length, 11)
  for (const m of published) {
    assert.ok(m, 'message failed to parse')
    assert.ok(!JSON.stringify(m).includes(contentById.get(m.chunkId)!), `message for ${m.chunkId} contains content`)
  }
})
check('earlier duplicate gets a later-duplicate hint', () => {
  assert.equal(published.find((m) => m.chunkId === 'c07-test-failure-first').laterDuplicateOrdinal, 10)
  assert.equal(published.find((m) => m.chunkId === 'c10-test-failure-latest').laterDuplicateOrdinal, undefined)
})
check('Strands ask accepted the question map', () => {
  assert.ok(askedQuestions.length >= 9)
  assert.deepEqual(Object.keys(askedQuestions[0]), ['relevance', 'reasonCode'])
})

const c08 = published.find((m) => m.chunkId === 'c08-injection')
const redelivery = await processChunkTask(workerDeps, c08)
check('sequential duplicate delivery is detected before the model call', () => assert.equal(redelivery.status, 'duplicate-delivery'))

const resultDeps = { store, payloads, now, settings: { inlineMaxBytes: 5_000_000, urlTtlSeconds: 300 } }
const beforeDeadline = await getResult(resultDeps, { jobId })
check('job keeps running while a chunk is missing before the deadline', () => {
  assert.equal(beforeDeadline.response.value.status, 'running')
  assert.equal(beforeDeadline.response.value.progress.pending, 1)
})

clock += 61_000
const final = await getResult(resultDeps, { jobId })
const result = final.response.value
const byId = new Map(result.manifest.map((m: any) => [m.chunkId, m]))
check('job completes after the deadline and freezes the result', () => {
  assert.equal(result.status, 'complete')
  assert.equal(final.frozeNow, true)
})
check('manifest is in original order and complete', () => assert.deepEqual(result.manifest.map((m: any) => m.ordinal), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))
check('protected chunk is kept', () => assert.equal((byId.get('c00-steering') as any).outcome, 'protected'))
check('classifier failure is kept', () => assert.deepEqual([(byId.get('c03-read-date-ts') as any).outcome, (byId.get('c03-read-date-ts') as any).keep], ['failed', true]))
check('publish failure is kept', () => assert.deepEqual([(byId.get('c06-revised-plan') as any).outcome, (byId.get('c06-revised-plan') as any).keep], ['failed', true]))
check('lost message is timed out and kept', () => assert.deepEqual([(byId.get('c09-read-test') as any).outcome, (byId.get('c09-read-test') as any).keep], ['timed-out', true]))
check('uncertain answer is kept', () => assert.deepEqual([(byId.get('c11-assistant-next') as any).decision, (byId.get('c11-assistant-next') as any).keep], ['uncertain', true]))
check('only decided irrelevant chunks are dropped', () => {
  const dropped = result.manifest.filter((m: any) => !m.keep).map((m: any) => m.chunkId).sort()
  assert.deepEqual(dropped, ['c02-plan-temporal', 'c04-read-format-ts', 'c05-stale-error', 'c07-test-failure-first', 'c08-injection'])
})
check('retained content is in order and matches the manifest', () => {
  assert.deepEqual(result.retained.map((r: any) => r.chunkId), result.manifest.filter((m: any) => m.keep).map((m: any) => m.chunkId))
})
check('metrics count outcomes', () => {
  const c = result.metrics.chunks
  assert.deepEqual([c.total, c.protected, c.eligible, c.dropped, c.retained, c.failed, c.timedOut, c.uncertain], [12, 1, 11, 5, 7, 2, 1, 1])
  assert.ok(result.metrics.tokens.eligibleReduction > 0 && result.metrics.tokens.eligibleReduction < 1)
  assert.equal(result.metrics.usage.summaryInputTokens, 900)
})

// Late delivery of the lost message, past the deadline plus the 5 s stale grace.
clock += 10_000
const late = await processChunkTask(workerDeps, published.find((m) => m.chunkId === 'c09-read-test'))
check('late delivery after the deadline is skipped as stale', () => assert.equal(late.status, 'stale'))
await store.putChunkResult({ ...result.manifest[9], jobId, ordinal: 9, outcome: 'decided', decision: 'irrelevant', keep: false, workerStartedAt: now().toISOString(), writtenAt: now().toISOString() })
const frozen = await getResult(resultDeps, { jobId })
check('frozen result does not change after a late result', () => {
  assert.equal(frozen.frozeNow, false)
  assert.equal(frozen.response.value.manifest[9].outcome, 'timed-out')
})
const withoutContent = await getResult(resultDeps, { jobId, includeContent: false })
check('includeContent=false omits retained content', () => assert.equal(withoutContent.response.value.retained, undefined))
const tiny = await getResult({ ...resultDeps, settings: { inlineMaxBytes: 1_024, urlTtlSeconds: 300 } }, { jobId })
check('oversized result is returned as a URL', () => {
  assert.equal(tiny.response.value.retained, undefined)
  assert.ok(tiny.response.value.fullResultUrl.startsWith('https://'))
})

// Coordinator failure path: summarizer throws, job fails open.
const failStore = new MemoryStore()
const failPayloads = new MemoryPayloads()
const failStart = await startJob({ ...startDeps, store: failStore, payloads: failPayloads }, { ...base, requestId: 'fail-case' })
const failOutcome = await runCoordinator({ ...coordinatorDeps, store: failStore, payloads: failPayloads, summarizer: { async summarize() { throw new Error('AccessDeniedException: no model access') } } }, failStart.value.jobId)
const failResult = (await getResult({ ...resultDeps, store: failStore, payloads: failPayloads }, { jobId: failStart.value.jobId })).response.value
check('summarizer failure fails the job and keeps every chunk', () => {
  assert.equal(failOutcome.status, 'failed')
  assert.equal(failResult.status, 'failed')
  assert.ok(failResult.manifest.every((m: any) => m.keep))
})

// ---------- transcript parsing ----------
const lines = [
  { type: 'user', uuid: 'u0', message: { role: 'user', content: 'request before compaction' } },
  { type: 'system', subtype: 'compact_boundary', uuid: 's1', content: 'Conversation compacted' },
  { type: 'user', uuid: 'u2', isCompactSummary: true, message: { role: 'user', content: 'Summary of earlier work: parser rewrite abandoned.' } },
  { type: 'user', uuid: 'u3', cwd: '/repo', gitBranch: 'fix/date', sessionId: 'sess-1', message: { role: 'user', content: 'Please fix the bug in a.ts' } },
  { type: 'assistant', uuid: 'a4', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 'x' }, { type: 'text', text: "I'll read the file." }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }] } },
  { type: 'user', uuid: 'u5', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '1 const x = 1' }] } },
  { type: 'assistant', uuid: 'a6', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
  { type: 'progress', uuid: 'p7', data: {} },
  { type: 'assistant', uuid: 'a8', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', uuid: 'u9', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'FAIL a.test.ts' }] }] } },
  { type: 'user', uuid: 'u10', message: { role: 'user', content: '<command-name>/annihilate</command-name>\n<command-args>keep going</command-args>' } },
  { type: 'user', uuid: 'u11', message: { role: 'user', content: 'Also keep Node 18 support' } },
  { type: 'assistant', uuid: 'a12', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'x = 1', new_string: 'x = 2' } }] } },
]
const jsonl = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{not json\n`
const parsed = parseClaudeTranscript(jsonl, { maxChunkBytes: DEFAULT_LIMITS.maxChunkBytes, ignoredCommands: ['annihilate', 'context-annihilator:annihilate'] })
check('transcript keeps only post-compaction live context', () => {
  assert.deepEqual(parsed.chunks.map((c: any) => [c.kind, c.source, c.protected]), [
    ['other', 'compact-summary', true],
    ['user', 'user', false],
    ['assistant', 'assistant', false],
    ['file', '/repo/a.ts', false],
    ['tool-result', 'Bash', false],
    ['user', 'user', true],
    ['tool-result', 'Edit /repo/a.ts', false],
  ])
})
check('tool calls are paired with their results', () => {
  assert.ok(parsed.chunks[3].content.includes('Tool call: Read') && parsed.chunks[3].content.includes('1 const x = 1'))
  assert.ok(parsed.chunks[4].content.includes('Result (error):\nFAIL a.test.ts'))
  assert.ok(parsed.chunks[6].content.includes('[no result recorded]'))
})
check('transcript stats count skipped material', () => {
  const s = parsed.stats
  assert.deepEqual([s.compactBoundaryFound, s.thinkingBlocks, s.sidechainEntries, s.invalidLines, s.unmatchedToolCalls, s.skippedByType.progress], [true, 1, 1, 1, 1, 1])
  assert.equal(parsed.gitBranch, 'fix/date')
})
check('thinking text is not carried over', () => assert.ok(!parsed.chunks.some((c: any) => c.content.includes('secret'))))
check('parsed transcript passes service validation', () => {
  assert.deepEqual(codes({ requestId: 'cc:sess-1:p1', host: 'claude-code', currentPrompt: 'keep going', chunks: parsed.chunks }), [])
})
check('oversized content is split losslessly', () => {
  const big = 'é'.repeat(50_000) + '\n' + 'line\n'.repeat(20_000)
  const parts = splitByBytes(big, 64 * 1024)
  assert.ok(parts.length > 1 && parts.every((p: string) => Buffer.byteLength(p) <= 64 * 1024))
  assert.equal(parts.join(''), big)
})

// ---------- seed and launch args ----------
const seed = renderSeed(result, { nextAction: base.currentPrompt, cwd: '/repo', gitBranch: 'fix/date', originalSessionId: 'sess-1' })
const plan = planLaunch(seed, '/tmp/seed.md')
check('seed carries next action, summary, retained records, and omissions', () => {
  assert.equal(plan.mode, 'inline')
  assert.ok(plan.prompt.includes(base.currentPrompt))
  assert.ok(plan.prompt.includes('Goal: fix parseIsoDate'))
  assert.ok(plan.prompt.includes(contentById.get('c10-test-failure-latest')!))
  assert.ok(!plan.prompt.includes(contentById.get('c04-read-format-ts')!))
  assert.ok(plan.prompt.includes('#4 file · src/utils/datetime-format.ts'))
})
check('large seeds move retained context into a file', () => {
  const bigResult = { ...result, retained: result.retained.map((r: any) => ({ ...r, content: r.content + 'y'.repeat(20_000) })) }
  const bigPlan = planLaunch(renderSeed(bigResult, { nextAction: 'x', cwd: '/repo', originalSessionId: 's' }), '/tmp/seed.md')
  assert.equal(bigPlan.mode, 'file')
  assert.ok(Buffer.byteLength(bigPlan.prompt) < 96 * 1024 && bigPlan.prompt.includes('/tmp/seed.md'))
})
check('launch args start a fresh background session', () => {
  const args = buildBackgroundArgs({ name: 'annihilated-1234', prompt: plan.prompt, addDirs: ['/data/seeds'] })
  assert.deepEqual(args.slice(0, 6), ['--bg', '--name', 'annihilated-1234', '--add-dir', '/data/seeds', '--'])
  assert.equal(args.at(-1), plan.prompt)
  for (const forbidden of ['--resume', '--continue', '--fork-session', '-r', '-c', '--session-id']) assert.ok(!args.slice(0, -1).includes(forbidden))
  assert.throws(() => buildBackgroundArgs({ name: '--resume', prompt: 'x', addDirs: [] }))
})

console.log(`\n${passed} checks passed`)
