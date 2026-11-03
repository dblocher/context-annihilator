import type { ValidationIssue } from './api.js'
import { AUTHORITATIVE_KINDS, CONTEXT_KINDS, type ContextChunk, type ContextKind, type StartJobRequest } from './context.js'
import {
  HOST_PATTERN,
  MAX_CHUNK_ID_LENGTH,
  MAX_SOURCE_LENGTH,
  REQUEST_ID_PATTERN,
  type RequestLimits,
} from './limits.js'

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] }

const MAX_ISSUES = 50
const REQUEST_KEYS = new Set(['requestId', 'host', 'currentPrompt', 'chunks'])
const CHUNK_KEYS = new Set(['id', 'ordinal', 'kind', 'source', 'protected', 'content'])
const KIND_SET: ReadonlySet<string> = new Set(CONTEXT_KINDS)
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validates an untrusted start-job request and returns a normalized copy containing only
 * known fields. Rejects duplicate IDs, unsorted or invalid ordinals, unknown kinds,
 * oversized content, and authoritative kinds marked removable.
 */
export function validateStartJobRequest(input: unknown, limits: RequestLimits): ValidationResult<StartJobRequest> {
  const issues: ValidationIssue[] = []
  const add = (path: string, code: string, message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ path, code, message })
  }

  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: '$', code: 'type', message: 'request must be a JSON object' }] }
  }
  for (const key of Object.keys(input)) {
    if (!REQUEST_KEYS.has(key)) add(key, 'unknown-field', `unknown field "${key}"`)
  }

  const { requestId, host, currentPrompt, chunks } = input
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    add('requestId', 'format', 'requestId must match ^[A-Za-z0-9._:-]{1,128}$')
  }
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) {
    add('host', 'format', 'host must be 1-64 characters: letters, digits, ".", "_", "-"')
  }
  let totalBytes = 0
  if (typeof currentPrompt !== 'string' || currentPrompt.trim().length === 0) {
    add('currentPrompt', 'required', 'currentPrompt must be a non-empty string')
  } else {
    const bytes = utf8Bytes(currentPrompt)
    totalBytes += bytes
    if (bytes > limits.maxCurrentPromptBytes) {
      add('currentPrompt', 'too-large', `currentPrompt is ${bytes} bytes; limit is ${limits.maxCurrentPromptBytes}`)
    }
  }

  const normalized: ContextChunk[] = []
  if (!Array.isArray(chunks)) {
    add('chunks', 'type', 'chunks must be an array')
  } else {
    if (chunks.length > limits.maxChunks) {
      add('chunks', 'too-many', `${chunks.length} chunks; limit is ${limits.maxChunks}`)
    }
    const ids = new Set<string>()
    let previousOrdinal = -1
    chunks.forEach((raw: unknown, index) => {
      const path = `chunks[${index}]`
      if (!isRecord(raw)) {
        add(path, 'type', 'chunk must be an object')
        return
      }
      for (const key of Object.keys(raw)) {
        if (!CHUNK_KEYS.has(key)) add(`${path}.${key}`, 'unknown-field', `unknown field "${key}"`)
      }
      const { id, ordinal, kind, source, content } = raw
      const isProtected = raw.protected

      let chunkValid = true
      const fail = (field: string, code: string, message: string) => {
        chunkValid = false
        add(`${path}.${field}`, code, message)
      }

      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CHUNK_ID_LENGTH || CONTROL_CHARS.test(id)) {
        fail('id', 'format', `id must be 1-${MAX_CHUNK_ID_LENGTH} characters with no control characters`)
      } else if (ids.has(id)) {
        fail('id', 'duplicate', `duplicate chunk id "${id}"`)
      } else {
        ids.add(id)
      }

      if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0) {
        fail('ordinal', 'format', 'ordinal must be a non-negative integer')
      } else if (ordinal <= previousOrdinal) {
        fail('ordinal', 'order', `ordinal ${ordinal} is not greater than the previous ordinal ${previousOrdinal}`)
      } else {
        previousOrdinal = ordinal
      }

      if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
        fail('kind', 'unknown-kind', `kind must be one of: ${CONTEXT_KINDS.join(', ')}`)
      }

      if (source !== undefined && (typeof source !== 'string' || source.length > MAX_SOURCE_LENGTH || CONTROL_CHARS.test(source))) {
        fail('source', 'format', `source must be a string of at most ${MAX_SOURCE_LENGTH} characters with no control characters`)
      }

      if (typeof isProtected !== 'boolean') {
        fail('protected', 'type', 'protected must be a boolean')
      } else if (typeof kind === 'string' && AUTHORITATIVE_KINDS.has(kind as ContextKind) && !isProtected) {
        fail('protected', 'authoritative-removable', `kind "${kind}" is authoritative and must be protected`)
      }

      if (typeof content !== 'string') {
        fail('content', 'type', 'content must be a string')
      } else {
        const bytes = utf8Bytes(content)
        totalBytes += bytes
        if (bytes > limits.maxChunkBytes) {
          fail('content', 'too-large', `content is ${bytes} bytes; limit is ${limits.maxChunkBytes}`)
        }
      }

      if (chunkValid) {
        normalized.push({
          id: id as string,
          ordinal: ordinal as number,
          kind: kind as ContextKind,
          ...(source !== undefined && { source: source as string }),
          protected: isProtected as boolean,
          content: content as string,
        })
      }
    })
  }

  if (totalBytes > limits.maxTotalBytes) {
    add('$', 'too-large', `request content is ${totalBytes} bytes; limit is ${limits.maxTotalBytes}`)
  }

  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    value: {
      requestId: requestId as string,
      host: host as string,
      currentPrompt: currentPrompt as string,
      chunks: normalized,
    },
  }
}
