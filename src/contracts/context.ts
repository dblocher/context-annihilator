export const CONTEXT_KINDS = [
  'system',
  'developer',
  'user',
  'assistant',
  'file',
  'tool-schema',
  'tool-result',
  'steering',
  'other',
] as const

export type ContextKind = (typeof CONTEXT_KINDS)[number]

/** Kinds that carry instructions with authority over the task. They are never classified. */
export const AUTHORITATIVE_KINDS: ReadonlySet<ContextKind> = new Set<ContextKind>([
  'system',
  'developer',
  'tool-schema',
  'steering',
])

export type ContextChunk = {
  id: string
  ordinal: number
  kind: ContextKind
  source?: string
  protected: boolean
  content: string
}

export type StartJobRequest = {
  requestId: string
  host: string
  /** The current user instruction. Always protected and never classified. */
  currentPrompt: string
  /** Sorted by ordinal. */
  chunks: ContextChunk[]
}
