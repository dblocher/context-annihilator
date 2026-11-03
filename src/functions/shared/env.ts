import { DEFAULT_LIMITS, type RequestLimits } from '../../contracts/limits.js'

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') throw new Error(`missing required environment variable ${name}`)
  return value
}

export function intEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`environment variable ${name} must be an integer >= ${min}`)
  return value
}

export function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`environment variable ${name} must be true or false`)
}

/** Empty or unset means "not configured". */
export function optionalNumberEnv(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`environment variable ${name} must be a number in [${min}, ${max}]`)
  }
  return value
}

export function limitsFromEnv(): RequestLimits {
  return {
    maxChunks: intEnv('MAX_CHUNKS', DEFAULT_LIMITS.maxChunks, 1),
    maxChunkBytes: intEnv('MAX_CHUNK_BYTES', DEFAULT_LIMITS.maxChunkBytes, 1),
    maxTotalBytes: intEnv('MAX_TOTAL_BYTES', DEFAULT_LIMITS.maxTotalBytes, 1),
    maxCurrentPromptBytes: intEnv('MAX_CURRENT_PROMPT_BYTES', DEFAULT_LIMITS.maxCurrentPromptBytes, 1),
  }
}
