import { utf8Bytes } from '../../contracts/validation.js'

/**
 * Splits text into ordered parts of at most `maxBytes` UTF-8 bytes. Prefers line
 * boundaries and never splits a code point. Joining the parts reproduces the input.
 */
export function splitByBytes(text: string, maxBytes: number): string[] {
  if (maxBytes < 4) throw new RangeError('maxBytes must be at least 4')
  if (utf8Bytes(text) <= maxBytes) return [text]

  const parts: string[] = []
  let current = ''
  let currentBytes = 0
  const flush = () => {
    if (current.length > 0) parts.push(current)
    current = ''
    currentBytes = 0
  }

  for (const line of text.split(/(?<=\n)/)) {
    const lineBytes = utf8Bytes(line)
    if (currentBytes + lineBytes <= maxBytes) {
      current += line
      currentBytes += lineBytes
      continue
    }
    flush()
    if (lineBytes <= maxBytes) {
      current = line
      currentBytes = lineBytes
      continue
    }
    for (const char of line) {
      const charBytes = utf8Bytes(char)
      if (currentBytes + charBytes > maxBytes) flush()
      current += char
      currentBytes += charBytes
    }
  }
  flush()
  return parts
}
