// Offline check of the built artifacts (run `node scripts/build.mjs` first). No AWS access:
// credentials point at a profile that does not exist.
//
//   npx --yes node@22 test/smoke/bundles.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const fixture = JSON.parse(readFileSync(join(repo, 'test/fixtures/basic-task.json'), 'utf8'))
Object.assign(process.env, {
  TABLE_NAME: 'smoke-table',
  BUCKET_NAME: 'smoke-bucket',
  TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:smoke',
  COORDINATOR_FUNCTION_NAME: 'smoke-coordinator',
  SUMMARY_MODEL_ID: 'smoke-model',
  DECISION_MODEL_ID: 'smoke-model',
  DECISION_TEMPERATURE: '0',
  AWS_REGION: 'us-east-1',
  AWS_PROFILE: 'context-annihilator-nonexistent-profile',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_LAMBDA_FUNCTION_NAME: 'smoke',
})

// Capture stdout to check that logs never contain chunk content.
const captured = []
const originalWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...rest) => {
  captured.push(String(chunk))
  return originalWrite(chunk, ...rest)
}

const handlers = {}
for (const name of ['ingress', 'coordinator', 'decision-worker', 'result']) {
  const mod = await import(join(repo, `dist/functions/${name}/index.mjs`))
  assert.equal(typeof mod.handler, 'function', `${name} exports handler`)
  handlers[name] = mod.handler
}

const invalid = await handlers.ingress({ requestId: 'bad id!', chunks: [] })
assert.equal(invalid.ok, false)
assert.equal(invalid.error.code, 'invalid-request')

const internal = await handlers.ingress(fixture.request)
assert.equal(internal.ok, false)
assert.equal(internal.error.code, 'internal')

const badResult = await handlers.result({ jobId: 'nope' })
assert.equal(badResult.error.code, 'invalid-request')

await handlers['decision-worker']({ Records: [{ Sns: { Message: 'not json', MessageId: 'm-1' } }] })
await handlers.coordinator({ jobId: 'not-a-job-id' })

process.stdout.write = originalWrite
const logs = captured.join('')
for (const chunk of fixture.request.chunks) {
  assert.ok(!logs.includes(chunk.content), `logs contain content of ${chunk.id}`)
}
assert.ok(!logs.includes(fixture.request.currentPrompt), 'logs contain the current prompt')
const events = logs.trim().split('\n').map((line) => JSON.parse(line))
console.log('\nlog events:', events.map((e) => e.event ?? `EMF:${Object.keys(e).filter((k) => !['_aws', 'Service'].includes(k)).join(',')}`).join(' | '))
console.log('bundles: all four load and handle invalid input; ingress fails closed with internal error and no content in logs')

// ---------- hook bundle ----------
const work = mkdtempSync(join(tmpdir(), 'ca-smoke-'))
try {
  const transcriptPath = join(work, 'transcript.jsonl')
  writeFileSync(
    transcriptPath,
    [
      { type: 'user', uuid: 'u1', sessionId: 's1', cwd: work, message: { role: 'user', content: 'Fix the date bug' } },
      { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking now.' }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n'),
  )
  const event = JSON.stringify({
    session_id: 's1',
    transcript_path: transcriptPath,
    cwd: work,
    hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command',
    command_name: 'annihilate',
    command_args: 'keep going',
    command_source: 'plugin',
    prompt: '/annihilate keep going',
  })
  const hookEnv = {
    ...process.env,
    CLAUDE_PLUGIN_OPTION_STACK_NAME: 'smoke-stack',
    CLAUDE_PLUGIN_OPTION_AWS_REGION: 'us-east-1',
    CLAUDE_PLUGIN_OPTION_AWS_PROFILE: 'context-annihilator-nonexistent-profile',
    CLAUDE_PLUGIN_OPTION_CLAUDE_PATH: '/bin/false',
    CLAUDE_PLUGIN_DATA: work,
  }
  const runtimes = [['current node', process.execPath]]
  // An older system Node checks the version guard. Skipped where it does not exist.
  if (existsSync('/usr/bin/node') && process.execPath !== '/usr/bin/node') runtimes.push(['/usr/bin/node', '/usr/bin/node'])
  for (const [label, node] of runtimes) {
    const run = spawnSync(node, [join(repo, 'claude-plugin/dist/annihilate-hook.mjs')], { input: event, env: hookEnv, encoding: 'utf8', timeout: 60_000 })
    assert.equal(run.status, 0, `${label} hook exit status ${run.status}: ${run.stderr}`)
    const output = JSON.parse(run.stdout.trim())
    assert.equal(output.decision, 'block', `${label} hook did not block`)
    console.log(`${label} hook: decision=${output.decision} reason=${output.reason.split('\n')[0]}`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log('\nbundle checks passed')
