import type { LatencyStats } from '../../contracts/api.js'

/** Nearest-rank percentiles. Returns undefined for an empty sample. */
export function latencyStats(values: readonly number[]): LatencyStats | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number
  return { count: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1] as number }
}
