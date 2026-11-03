import { randomToken } from './hash.js'

/** Rough token estimate used for reduction metrics. Not tokenizer output. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Keeps the head and tail of long text, marking how much was removed from the middle. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const keep = Math.max(0, maxChars - 40)
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  const removed = text.length - head - tail
  return `${text.slice(0, head)}\n[... ${removed} characters omitted ...]\n${text.slice(text.length - tail)}`
}

/**
 * Wraps untrusted text between boundary lines that contain a random token, so text
 * inside the block cannot forge the closing boundary.
 */
export function delimitUntrusted(label: string, content: string): string {
  let token = randomToken()
  while (content.includes(token)) token = randomToken()
  return `----- BEGIN ${label} ${token} -----\n${content}\n----- END ${label} ${token} -----`
}
