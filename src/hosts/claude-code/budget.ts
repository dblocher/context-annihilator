/**
 * Time budget for the `/annihilate` hook.
 *
 * hooks.json gives the hook 300 s. Claude Code kills it after that. A killed hook still
 * blocks the old session (`onFailure: "block"`), but a launch cut short could leave a new
 * session running that nobody was told about. So the hook stops polling early enough to
 * launch, look up the session ID, and answer before the timeout.
 */

/** Must match `timeout` in claude-plugin/hooks/hooks.json. */
export const HOOK_TIMEOUT_MS = 300_000
/**
 * Kept free at the end for writing the response. Also covers the launcher's 1 s SIGKILL
 * grace (`KILL_GRACE_MS`) when `claude` ignores SIGTERM at its timeout.
 */
export const RESPONSE_MARGIN_MS = 5_000
/** Upper bound for `claude --bg`, which returns as soon as the session is registered. */
export const LAUNCH_TIMEOUT_MS = 30_000
/** Upper bound for the `claude agents --json` fallback when the `--bg` output has no ID. */
export const SESSION_LOOKUP_MS = 8_000
/** The hook refuses to start a launch with less time than this left. */
export const MIN_LAUNCH_MS = 10_000
/** Default for the plugin's `poll_timeout_seconds` option. */
export const DEFAULT_POLL_TIMEOUT_MS = 240_000

export type HookBudget = {
  /** Epoch ms by which the hook must have written its response. */
  hookDeadline: number
  /** Epoch ms at which polling stops, leaving room for the launch and the session lookup. */
  pollDeadline: number
}

/** `startedAt` is when Claude Code spawned the hook process (epoch ms). */
export function hookBudget(startedAt: number): HookBudget {
  const hookDeadline = startedAt + HOOK_TIMEOUT_MS - RESPONSE_MARGIN_MS
  return { hookDeadline, pollDeadline: hookDeadline - LAUNCH_TIMEOUT_MS - SESSION_LOOKUP_MS }
}

/** Reads the `poll_timeout_seconds` option. Anything other than a positive number means the default. */
export function configuredPollTimeoutMs(raw: string | undefined): number {
  const seconds = Number(raw)
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_POLL_TIMEOUT_MS
}

/** The configured poll timeout, cut short so polling ends at the poll deadline. */
export function pollTimeoutMs(budget: HookBudget, configuredMs: number, now: number): number {
  return Math.max(0, Math.min(configuredMs, budget.pollDeadline - now))
}

/** Time allowed for `claude --bg`, cut short so it ends at the hook deadline. */
export function launchTimeoutMs(budget: HookBudget, now: number): number {
  return Math.max(0, Math.min(LAUNCH_TIMEOUT_MS, budget.hookDeadline - now))
}
