import type { ContextChunk } from '../../contracts/context.js'
import { contentHash } from '../util/hash.js'

/**
 * For each eligible chunk whose exact content appears again later among eligible chunks,
 * returns the ordinal of the last copy. The last copy has no entry: it is the only one
 * classified, and the earlier copies are dropped without a model call. Protected chunks are
 * skipped, so they are never deduplicated.
 */
export function earlierDuplicates(chunks: readonly ContextChunk[]): Map<number, number> {
  const lastByHash = new Map<string, number>()
  const result = new Map<number, number>()
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i] as ContextChunk
    if (chunk.protected) continue
    const hash = contentHash(chunk.content)
    const last = lastByHash.get(hash)
    if (last === undefined) lastByHash.set(hash, chunk.ordinal)
    else result.set(chunk.ordinal, last)
  }
  return result
}
