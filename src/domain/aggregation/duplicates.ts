import type { ContextChunk } from '../../contracts/context.js'
import { contentHash } from '../util/hash.js'

/**
 * For each eligible chunk whose exact content appears again later, returns the ordinal of
 * the next copy. The last copy has no entry, so it is judged on its own merits.
 */
export function laterDuplicateOrdinals(chunks: readonly ContextChunk[]): Map<number, number> {
  const nextByHash = new Map<string, number>()
  const result = new Map<number, number>()
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i] as ContextChunk
    if (chunk.protected) continue
    const hash = contentHash(chunk.content)
    const later = nextByHash.get(hash)
    if (later !== undefined) result.set(chunk.ordinal, later)
    nextByHash.set(hash, chunk.ordinal)
  }
  return result
}
