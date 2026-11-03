import type { StartJobRequest } from '../contracts/context.js'
import { RELEVANCE_LABELS, type RelevanceLabel } from '../contracts/decisions.js'
import { DEFAULT_LIMITS } from '../contracts/limits.js'
import { validateStartJobRequest } from '../contracts/validation.js'

/** Fields of the structured answer a task run returns. Checks match against these. */
export const ANSWER_FIELDS = ['plan', 'filesToRead', 'filesToEdit', 'commands', 'patch', 'questions'] as const
export type AnswerField = (typeof ANSWER_FIELDS)[number]

/**
 * A deterministic check on a task-run answer. `present` passes when the pattern matches at
 * least one value in the named fields; `absent` passes when it matches none. Array fields
 * are tested element by element, so `^` anchors to the start of each command or path.
 */
export type TaskCheck = {
  id: string
  description: string
  fields: AnswerField[]
  pattern: string
  /** Regular expression flags. Only `i`, `m`, `s`, and `u` are allowed. Default: none. */
  flags?: string
  expect: 'present' | 'absent'
}

export type CompiledCheck = TaskCheck & { regex: RegExp }

export type FixtureLabel = { label: RelevanceLabel; note?: string }

/** File format of test/fixtures/*.json. */
export type Fixture = {
  version: number
  description?: string
  /** Hand labels by chunk ID. Protected chunks need no label; they are never classified. */
  labels: Record<string, FixtureLabel>
  /** Task-success checks. A task run succeeds when every check passes. */
  task?: { checks: TaskCheck[] }
  request: StartJobRequest
}

export type LoadedFixture = {
  name: string
  path: string
  description?: string
  labels: Record<string, FixtureLabel>
  checks: CompiledCheck[]
  request: StartJobRequest
}

const LABEL_SET: ReadonlySet<string> = new Set(RELEVANCE_LABELS)
const FIELD_SET: ReadonlySet<string> = new Set(ANSWER_FIELDS)
const ALLOWED_FLAGS = /^[imsu]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates a parsed fixture file. Throws one error that lists every problem found. */
export function parseFixture(value: unknown, name: string, path: string): LoadedFixture {
  const problems: string[] = []
  if (!isRecord(value)) throw new Error(`${path}: fixture must be a JSON object`)

  const validated = validateStartJobRequest(value.request, DEFAULT_LIMITS)
  if (!validated.ok) {
    for (const issue of validated.issues) problems.push(`request.${issue.path}: ${issue.message}`)
  }
  const request = validated.ok ? validated.value : undefined
  const chunkIds = new Set(request?.chunks.map((chunk) => chunk.id) ?? [])
  const protectedIds = new Set(request?.chunks.filter((chunk) => chunk.protected).map((chunk) => chunk.id) ?? [])

  const labels: Record<string, FixtureLabel> = {}
  if (!isRecord(value.labels)) {
    problems.push('labels must be an object keyed by chunk ID')
  } else {
    for (const [id, entry] of Object.entries(value.labels)) {
      if (request && !chunkIds.has(id)) problems.push(`labels.${id}: no chunk has this ID`)
      if (protectedIds.has(id)) problems.push(`labels.${id}: chunk is protected and is never classified; remove the label`)
      if (!isRecord(entry) || typeof entry.label !== 'string' || !LABEL_SET.has(entry.label)) {
        problems.push(`labels.${id}.label must be one of: ${RELEVANCE_LABELS.join(', ')}`)
        continue
      }
      labels[id] = { label: entry.label as RelevanceLabel, ...(typeof entry.note === 'string' && { note: entry.note }) }
    }
  }

  const checks: CompiledCheck[] = []
  const task = value.task
  if (task !== undefined) {
    if (!isRecord(task) || !Array.isArray(task.checks)) {
      problems.push('task.checks must be an array')
    } else {
      const ids = new Set<string>()
      task.checks.forEach((raw: unknown, index) => {
        const at = `task.checks[${index}]`
        if (!isRecord(raw)) {
          problems.push(`${at} must be an object`)
          return
        }
        const { id, description, fields, pattern, flags, expect } = raw
        const before = problems.length
        if (typeof id !== 'string' || id === '') problems.push(`${at}.id must be a non-empty string`)
        else if (ids.has(id)) problems.push(`${at}.id "${id}" is a duplicate`)
        else ids.add(id)
        if (typeof description !== 'string' || description === '') problems.push(`${at}.description must be a non-empty string`)
        if (!Array.isArray(fields) || fields.length === 0 || !fields.every((f) => typeof f === 'string' && FIELD_SET.has(f))) {
          problems.push(`${at}.fields must be a non-empty array of: ${ANSWER_FIELDS.join(', ')}`)
        }
        if (expect !== 'present' && expect !== 'absent') problems.push(`${at}.expect must be "present" or "absent"`)
        if (flags !== undefined && (typeof flags !== 'string' || !ALLOWED_FLAGS.test(flags))) problems.push(`${at}.flags may contain only i, m, s, u`)
        let regex: RegExp | undefined
        if (typeof pattern !== 'string' || pattern === '') {
          problems.push(`${at}.pattern must be a non-empty string`)
        } else {
          try {
            regex = new RegExp(pattern, typeof flags === 'string' ? flags : '')
          } catch (error) {
            problems.push(`${at}.pattern is not a valid regular expression: ${(error as Error).message}`)
          }
        }
        if (problems.length === before && regex) {
          checks.push({
            id: id as string,
            description: description as string,
            fields: fields as AnswerField[],
            pattern: pattern as string,
            ...(typeof flags === 'string' && { flags }),
            expect: expect as 'present' | 'absent',
            regex,
          })
        }
      })
    }
  }

  if (problems.length > 0 || !request) {
    throw new Error(`${path}: invalid fixture\n- ${problems.join('\n- ')}`)
  }
  return {
    name,
    path,
    ...(typeof value.description === 'string' && { description: value.description }),
    labels,
    checks,
    request,
  }
}
