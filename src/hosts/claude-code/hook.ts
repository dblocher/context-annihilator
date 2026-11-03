/**
 * Claude Code `UserPromptExpansion` hook for `/annihilate`.
 *
 * Reads the session transcript as untrusted input, submits it to the Context Annihilator
 * service, waits for the ordered keep/drop result, and starts a fresh background session
 * from the reduced seed with `claude --bg`. It always answers `decision: "block"`, so the
 * command never expands into a model turn in the old session, whether the handoff succeeds
 * or fails.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { AnnihilatorClient } from '../../client/service-client.js'
import type { JobResult } from '../../contracts/api.js'
import type { StartJobRequest } from '../../contracts/context.js'
import { DEFAULT_LIMITS, REQUEST_ID_PATTERN } from '../../contracts/limits.js'
import { utf8Bytes } from '../../contracts/validation.js'
import { configuredPollTimeoutMs, hookBudget, launchTimeoutMs, MIN_LAUNCH_MS, pollTimeoutMs, SESSION_LOOKUP_MS } from './budget.js'
import { launchBackgroundSession, LaunchTimeoutError } from './launcher.js'
import { planLaunch, renderSeed } from './seed.js'
import { parseClaudeTranscript } from './transcript.js'

const MAX_HOOK_INPUT_BYTES = 1024 * 1024
const MAX_TRANSCRIPT_BYTES = 100 * 1024 * 1024
const COMMAND_NAMES = ['annihilate', 'context-annihilator:annihilate']
const DEFAULT_NEXT_ACTION = 'Continue the current task from where the earlier session stopped.'

type HookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  prompt_id?: string
  command_args?: string
}

function option(name: string, fallback: string): string {
  const value = process.env[`CLAUDE_PLUGIN_OPTION_${name}`]?.trim()
  return value ? value : fallback
}

function respond(reason: string): void {
  process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_HOOK_INPUT_BYTES) throw new Error('hook input is larger than 1 MiB')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseHookInput(raw: string): HookInput {
  const value: unknown = JSON.parse(raw)
  if (typeof value !== 'object' || value === null) throw new Error('hook input is not a JSON object')
  const input = value as Record<string, unknown>
  if (input.hook_event_name !== 'UserPromptExpansion') {
    throw new Error(`expected a UserPromptExpansion event, got ${String(input.hook_event_name)}`)
  }
  const { session_id, transcript_path, cwd, prompt_id, command_args } = input
  if (typeof session_id !== 'string' || session_id === '') throw new Error('hook input has no session_id')
  if (typeof transcript_path !== 'string' || !isAbsolute(transcript_path)) throw new Error('hook input has no absolute transcript_path')
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('hook input has no absolute cwd')
  return {
    session_id,
    transcript_path,
    cwd,
    ...(typeof prompt_id === 'string' && { prompt_id }),
    ...(typeof command_args === 'string' && { command_args }),
  }
}

/** The transcript is written asynchronously; wait briefly for its size to settle. */
async function waitForStableFile(path: string): Promise<void> {
  let previous = -1
  let stableReads = 0
  for (let i = 0; i < 14 && stableReads < 2; i++) {
    const { size } = await stat(path)
    stableReads = size === previous ? stableReads + 1 : 0
    previous = size
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

function requestIdFor(input: HookInput): string {
  const raw = `cc:${input.session_id}:${input.prompt_id ?? Date.now().toString(36)}`
  const id = raw.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128)
  if (!REQUEST_ID_PATTERN.test(id)) throw new Error('could not derive a valid requestId')
  return id
}

function successReason(result: JobResult, launch: { name: string; sessionId?: string; stdout: string }, mode: string): string {
  const metrics = result.metrics
  const lines = ['Context Annihilator started a fresh background session. This session received no model turn.']
  if (launch.sessionId) {
    lines.push(`  Session: ${launch.sessionId} (${launch.name})`, `  Attach:  claude attach ${launch.sessionId}   or open: claude agents`)
  } else {
    lines.push(
      `  Session name: ${launch.name}`,
      `  Attach:  claude attach ${launch.name}   (works while it runs) or open: claude agents`,
      `  claude --bg output: ${launch.stdout || '(none)'}`,
    )
  }
  if (metrics) {
    lines.push(
      `  Retained ${metrics.chunks.retained} of ${metrics.chunks.total} records; ` +
        `eligible context reduced ${(metrics.tokens.eligibleReduction * 100).toFixed(1)}% ` +
        `(about ${metrics.tokens.eligibleInput.toLocaleString('en-US')} to ${metrics.tokens.eligibleRetained.toLocaleString('en-US')} estimated tokens)` +
        (metrics.chunks.duplicate > 0 ? `; ${metrics.chunks.duplicate} earlier duplicates dropped.` : '.'),
      `  Kept by policy: ${metrics.chunks.uncertain} uncertain, ${metrics.chunks.failed} failed, ${metrics.chunks.timedOut} timed out.`,
    )
  }
  lines.push(`  Job: ${result.jobId}; seed passed ${mode === 'inline' ? 'inline' : 'as a file plus inline summary'}.`)
  return lines.join('\n')
}

async function run(): Promise<string> {
  // Claude Code's hook timeout started when it spawned this process, not when this code began.
  const budget = hookBudget(Date.now() - process.uptime() * 1000)
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) throw new Error(`Node.js 22 or later is required (found ${process.versions.node}); set the plugin's node_path option`)

  const input = parseHookInput(await readStdin())
  const stackName = option('STACK_NAME', 'context-annihilator')
  const region = option('AWS_REGION', process.env.AWS_REGION ?? '')
  const profile = option('AWS_PROFILE', '')
  const claudeBin = option('CLAUDE_PATH', 'claude')
  const configuredPollMs = configuredPollTimeoutMs(option('POLL_TIMEOUT_SECONDS', ''))

  await waitForStableFile(input.transcript_path)
  const { size } = await stat(input.transcript_path)
  if (size > MAX_TRANSCRIPT_BYTES) throw new Error(`transcript is ${Math.round(size / 1048576)} MiB; limit is 100 MiB`)
  const transcript = parseClaudeTranscript(await readFile(input.transcript_path, 'utf8'), {
    maxChunkBytes: DEFAULT_LIMITS.maxChunkBytes,
    ignoredCommands: COMMAND_NAMES,
  })

  const nextAction = input.command_args?.trim() || DEFAULT_NEXT_ACTION
  const request: StartJobRequest = {
    requestId: requestIdFor(input),
    host: 'claude-code',
    currentPrompt: nextAction,
    chunks: transcript.chunks,
  }
  const totalBytes = request.chunks.reduce((sum, chunk) => sum + utf8Bytes(chunk.content), utf8Bytes(nextAction))
  if (request.chunks.length > DEFAULT_LIMITS.maxChunks) {
    throw new Error(`the live context has ${request.chunks.length} records; the service limit is ${DEFAULT_LIMITS.maxChunks}`)
  }
  if (totalBytes > DEFAULT_LIMITS.maxTotalBytes) {
    throw new Error(`the live context is ${Math.round(totalBytes / 1024)} KiB; the service limit is ${DEFAULT_LIMITS.maxTotalBytes / 1024} KiB`)
  }

  const client = new AnnihilatorClient({ stackName, ...(region && { region }), ...(profile && { profile }) })
  const started = await client.startJob(request)
  const timeoutMs = pollTimeoutMs(budget, configuredPollMs, Date.now())
  if (timeoutMs < started.pollAfterMs) throw new Error(`job ${started.jobId} was submitted, but no time is left in the hook budget to wait for it`)
  const result = await client.waitForResult(started.jobId, { pollIntervalMs: started.pollAfterMs, timeoutMs })
  if (result.status !== 'complete') {
    throw new Error(`job ${result.jobId} ${result.status}: ${result.failure ?? 'no detail'}`)
  }
  if (result.manifest?.some((entry) => entry.protected && !entry.keep)) {
    throw new Error(`job ${result.jobId} dropped protected context; refusing to launch`)
  }

  const seed = renderSeed(result, {
    nextAction,
    cwd: input.cwd,
    ...(transcript.gitBranch !== undefined && { gitBranch: transcript.gitBranch }),
    originalSessionId: input.session_id,
  })
  const seedDir = join(process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), '.claude', 'context-annihilator'), 'seeds')
  const seedPath = join(seedDir, `${result.jobId}.md`)
  const plan = planLaunch(seed, seedPath)
  if (plan.mode === 'file') {
    await mkdir(seedDir, { recursive: true, mode: 0o700 })
    await writeFile(seedPath, plan.fileContent, { encoding: 'utf8', mode: 0o600 })
  }

  const launchMs = launchTimeoutMs(budget, Date.now())
  if (launchMs < MIN_LAUNCH_MS) {
    throw new Error(`job ${result.jobId} finished, but only ${Math.round(launchMs / 1000)} s of the hook budget is left, too little to launch safely`)
  }
  const launch = await launchBackgroundSession({
    claudeBin,
    cwd: input.cwd,
    name: `annihilated-${result.jobId.slice(0, 8)}`,
    prompt: plan.prompt,
    addDirs: plan.mode === 'file' ? [seedDir] : [],
    timeoutMs: launchMs,
    lookupMs: SESSION_LOOKUP_MS,
    deadline: budget.hookDeadline,
  })
  return successReason(result, launch, plan.mode)
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof LaunchTimeoutError) {
    return (
      `Context Annihilator could not confirm the new session: ${message}\n` +
      `A background session named ${error.sessionName} may have started anyway; check claude agents.\n` +
      'This session is unchanged and received no model turn.'
    )
  }
  return `Context Annihilator did not start a new session: ${message}\nThis session is unchanged and received no model turn.`
}

run()
  .then((reason) => respond(reason))
  .catch((error: unknown) => respond(failureReason(error)))
  .catch(() => {
    process.stderr.write('Context Annihilator hook failed to write its response\n')
    process.exitCode = 2
  })
