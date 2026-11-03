import { createHash, randomBytes } from 'node:crypto'

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Hash used to verify that a worker classified exactly the content the job holds. */
export function contentHash(content: string): string {
  return `sha256:${sha256Hex(content)}`
}

/** Deterministic job ID, so resubmitting the same request maps to the same job. */
export function jobIdFor(host: string, requestId: string): string {
  return sha256Hex(`${host}\n${requestId}`).slice(0, 32)
}

export function randomToken(bytes = 8): string {
  return randomBytes(bytes).toString('hex')
}
