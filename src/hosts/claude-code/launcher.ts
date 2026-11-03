import { execFile } from 'node:child_process'

export type LaunchRequest = {
  claudeBin: string
  cwd: string
  name: string
  prompt: string
  addDirs: readonly string[]
  /** Time allowed for `claude --bg` itself. */
  timeoutMs: number
  /** Time allowed for the `claude agents --json` fallback lookup after `claude --bg` returns. */
  lookupMs: number
  /** Epoch ms after which nothing new starts, whatever time the steps above have left. */
  deadline: number
}

export type LaunchResult = {
  name: string
  sessionId?: string
  stdout: string
}

/**
 * `claude --bg` did not return in time. It may have started the session before it was
 * killed, so callers must not report that no session was started.
 */
export class LaunchTimeoutError extends Error {
  constructor(
    message: string,
    readonly sessionName: string,
  ) {
    super(message)
    this.name = 'LaunchTimeoutError'
  }
}

class CommandError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

/** Flags that would reuse the old conversation. The launcher refuses to pass any of them. */
const FORBIDDEN_FLAGS = new Set(['--resume', '-r', '--continue', '-c', '--fork-session', '--session-id', '--from-pr'])

/** Session-scoped variables from the hook's parent session that the new session must not inherit. */
const SCRUBBED_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_ENV_FILE',
  'CLAUDE_JOB_DIR',
]

/** Shortest wait worth starting for one `claude agents --json` call. */
const MIN_LOOKUP_CALL_MS = 1_000
const MAX_LOOKUP_CALL_MS = 5_000

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of SCRUBBED_ENV) delete env[key]
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_PLUGIN_OPTION_')) delete env[key]
  return env
}

/** How long a timed-out child gets to exit after SIGTERM before it is killed and abandoned. */
export const KILL_GRACE_MS = 1_000

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let backstop: NodeJS.Timeout | undefined
    const child = execFile(
      bin,
      args,
      { cwd, env: childEnv(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        clearTimeout(backstop)
        if (settled) return
        settled = true
        if (error) {
          // execFile sets `killed` when it stopped the child because the timeout expired.
          const timedOut = error.killed === true
          const detail = timedOut
            ? `did not finish within ${Math.round(timeoutMs / 1000)} s`
            : `failed: ${(stderr || stdout || error.message).toString().trim().slice(0, 600)}`
          reject(new CommandError(`${bin} ${args[0] ?? ''} ${detail}`, timedOut))
        } else {
          resolve({ stdout: stdout.toString(), stderr: stderr.toString() })
        }
      },
    )
    // execFile only sends SIGTERM at the timeout and then waits for the child to exit. A child
    // that ignores or delays SIGTERM would hold the hook past its own timeout, so kill it and
    // stop waiting shortly after.
    backstop = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new CommandError(`${bin} ${args[0] ?? ''} did not finish within ${Math.round(timeoutMs / 1000)} s and ignored SIGTERM`, true))
    }, timeoutMs + KILL_GRACE_MS)
  })
}

export function buildBackgroundArgs(request: Pick<LaunchRequest, 'name' | 'prompt' | 'addDirs'>): string[] {
  const flags = ['--bg', '--name', request.name, ...request.addDirs.flatMap((dir) => ['--add-dir', dir])]
  for (const flag of flags) {
    if (FORBIDDEN_FLAGS.has(flag)) throw new Error(`refusing to pass ${flag}: the handoff must start a fresh session`)
  }
  // `--` ends option parsing, so the seed is always read as the prompt, never as a flag.
  return [...flags, '--', request.prompt]
}

/** ANSI color and cursor sequences, in case Claude Code colors its output. */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const SESSION_ID = '([A-Za-z0-9][A-Za-z0-9._-]{0,63})'

/**
 * Reads the session ID from `claude --bg` output. Claude Code 2.1.316 prints
 * `backgrounded · <id> · <name>` followed by hints such as `claude attach <id>`.
 */
export function parseBackgroundSessionId(output: string): string | undefined {
  const text = output.replace(ANSI_ESCAPE, '')
  const match = new RegExp(`backgrounded\\s+\\u00b7\\s+${SESSION_ID}`).exec(text) ?? new RegExp(`claude attach\\s+${SESSION_ID}`).exec(text)
  return match?.[1]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fallback: finds the new session's ID in `claude agents --json` by its unique name, until `until` (epoch ms). */
async function findSessionId(request: LaunchRequest, until: number): Promise<string | undefined> {
  for (;;) {
    const remaining = until - Date.now()
    if (remaining < MIN_LOOKUP_CALL_MS) return undefined
    try {
      const { stdout } = await run(request.claudeBin, ['agents', '--json', '--all'], request.cwd, Math.min(MAX_LOOKUP_CALL_MS, remaining))
      const sessions: unknown = JSON.parse(stdout)
      if (Array.isArray(sessions)) {
        const match = sessions.find(
          (s): s is { id?: string; name?: string } => typeof s === 'object' && s !== null && (s as { name?: unknown }).name === request.name,
        )
        if (typeof match?.id === 'string' && match.id !== '') return match.id
      }
    } catch {
      // The session list can lag the launch; retry until the deadline.
    }
    await sleep(Math.max(0, Math.min(500, until - Date.now())))
  }
}

/**
 * Starts a fresh background session with `claude --bg`. Never resumes, continues, or forks
 * the old session, and passes no old session ID.
 */
export async function launchBackgroundSession(request: LaunchRequest): Promise<LaunchResult> {
  let output: { stdout: string; stderr: string }
  try {
    output = await run(request.claudeBin, buildBackgroundArgs(request), request.cwd, request.timeoutMs)
  } catch (error) {
    if (error instanceof CommandError && error.timedOut) throw new LaunchTimeoutError(error.message, request.name)
    throw error
  }
  const sessionId =
    parseBackgroundSessionId(`${output.stdout}\n${output.stderr}`) ??
    (await findSessionId(request, Math.min(Date.now() + request.lookupMs, request.deadline)))
  return {
    name: request.name,
    stdout: output.stdout.replace(ANSI_ESCAPE, '').trim().slice(0, 1000),
    ...(sessionId !== undefined && { sessionId }),
  }
}
