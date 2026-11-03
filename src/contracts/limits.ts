export type RequestLimits = {
  maxChunks: number
  maxChunkBytes: number
  maxTotalBytes: number
  maxCurrentPromptBytes: number
}

/**
 * Defaults from ADR 0002. `maxTotalBytes` stays under the 6 MB synchronous Lambda
 * invoke payload limit, because clients call the ingress function directly.
 */
export const DEFAULT_LIMITS: RequestLimits = {
  maxChunks: 1000,
  maxChunkBytes: 64 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
  maxCurrentPromptBytes: 32 * 1024,
}

export const MAX_CHUNK_ID_LENGTH = 200
export const MAX_SOURCE_LENGTH = 1024
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
export const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const JOB_ID_PATTERN = /^[a-f0-9]{32}$/
