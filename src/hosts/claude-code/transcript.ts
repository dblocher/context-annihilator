import type { ContextChunk, ContextKind } from '../../contracts/context.js'
import { splitByBytes } from '../../domain/chunking/split.js'

/**
 * Converts a Claude Code transcript (JSONL) into ordered context chunks, following the
 * mapping in ADR 0002. The transcript is untrusted input: malformed lines are counted and
 * skipped, and no field is interpreted as an instruction.
 */

type Json = Record<string, unknown>

export type TranscriptStats = {
  lines: number
  invalidLines: number
  startLine: number
  compactBoundaryFound: boolean
  sidechainEntries: number
  thinkingBlocks: number
  imageBlocks: number
  skippedByType: Record<string, number>
  splitChunks: number
  unmatchedToolCalls: number
}

export type ParsedTranscript = {
  chunks: ContextChunk[]
  stats: TranscriptStats
  sessionId?: string
  gitBranch?: string
  cwd?: string
}

export type ParseOptions = {
  maxChunkBytes: number
  /** Command names whose invocation records are dropped, such as the handoff command itself. */
  ignoredCommands: readonly string[]
}

type Draft = {
  id: string
  kind: ContextKind
  source: string
  protected: boolean
  content: string
  humanPrompt: boolean
}

const BOOKKEEPING_TYPES = new Set([
  'summary',
  'file-history-snapshot',
  'progress',
  'queue-operation',
  'mode',
  'custom-title',
  'tag',
  'last-prompt',
])

const isObj = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** IDs and sources are metadata, so control characters are replaced rather than rejected. */
function sanitizeLabel(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, '?') || '?'
}

function count(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1
}

function renderInput(input: unknown): string {
  if (!isObj(input)) return JSON.stringify(input ?? null)
  return Object.entries(input)
    .map(([key, value]) => {
      if (typeof value === 'string') return value.includes('\n') ? `${key}:\n${value}` : `${key}: ${value}`
      return `${key}: ${JSON.stringify(value)}`
    })
    .join('\n')
}

export function parseClaudeTranscript(jsonl: string, options: ParseOptions): ParsedTranscript {
  const stats: TranscriptStats = {
    lines: 0,
    invalidLines: 0,
    startLine: 0,
    compactBoundaryFound: false,
    sidechainEntries: 0,
    thinkingBlocks: 0,
    imageBlocks: 0,
    skippedByType: {},
    splitChunks: 0,
    unmatchedToolCalls: 0,
  }

  const entries: Array<{ line: number; entry: Json }> = []
  jsonl.split('\n').forEach((raw, line) => {
    if (raw.trim() === '') return
    stats.lines++
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isObj(parsed)) entries.push({ line, entry: parsed })
      else stats.invalidLines++
    } catch {
      stats.invalidLines++
    }
  })

  // Only entries after the latest compaction are in the live context.
  let start = 0
  entries.forEach(({ entry }, index) => {
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      start = index + 1
      stats.compactBoundaryFound = true
    }
  })
  stats.startLine = entries[start]?.line ?? 0

  const drafts: Draft[] = []
  const pendingTools = new Map<string, number>()
  let sessionId: string | undefined
  let gitBranch: string | undefined
  let cwd: string | undefined

  const ignored = options.ignoredCommands.map((name) => `<command-name>/${name}</command-name>`)

  const addText = (id: string, kind: ContextKind, source: string, content: string, extra: Partial<Draft> = {}) => {
    if (content.trim() === '') return
    drafts.push({ id, kind, source, protected: false, content, humanPrompt: false, ...extra })
  }

  const textOfBlocks = (blocks: unknown[]): string =>
    blocks
      .map((block) => {
        if (!isObj(block)) return ''
        if (block.type === 'text') return str(block.text) ?? ''
        if (block.type === 'image') {
          stats.imageBlocks++
          return '[image from the earlier session; not carried over]'
        }
        return ''
      })
      .filter((text) => text !== '')
      .join('\n')

  const classifyUserText = (entry: Json, id: string, text: string) => {
    if (ignored.some((marker) => text.includes(marker))) return
    if (entry.isCompactSummary === true) {
      addText(id, 'other', 'compact-summary', text, { protected: true })
    } else if (entry.isMeta === true) {
      addText(id, 'other', 'meta', text)
    } else if (text.includes('<local-command-stdout>') || text.includes('<local-command-stderr>')) {
      addText(id, 'other', 'local-command-output', text)
    } else if (text.includes('<command-name>')) {
      addText(id, 'user', 'slash-command', text)
    } else if (text.startsWith('[Request interrupted by user')) {
      addText(id, 'other', 'interruption', text)
    } else {
      addText(id, 'user', 'user', text, { humanPrompt: true })
    }
  }

  for (const { line, entry } of entries.slice(start)) {
    const type = str(entry.type) ?? '<none>'
    if (entry.isSidechain === true) {
      stats.sidechainEntries++
      continue
    }
    sessionId = str(entry.sessionId) ?? sessionId
    gitBranch = str(entry.gitBranch) ?? gitBranch
    cwd = str(entry.cwd) ?? cwd
    const baseId = str(entry.uuid) ?? `line${line}`
    const message = isObj(entry.message) ? entry.message : undefined
    const content = message?.content

    if (type === 'user' && message) {
      if (typeof content === 'string') {
        classifyUserText(entry, baseId, content)
        continue
      }
      if (!Array.isArray(content)) continue
      const text = textOfBlocks(content.filter((b) => isObj(b) && b.type !== 'tool_result'))
      if (text) classifyUserText(entry, `${baseId}:text`, text)
      for (const block of content) {
        if (!isObj(block) || block.type !== 'tool_result') continue
        const toolUseId = str(block.tool_use_id)
        const resultText =
          typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? textOfBlocks(block.content) : ''
        const header = block.is_error === true ? 'Result (error):' : 'Result:'
        const index = toolUseId !== undefined ? pendingTools.get(toolUseId) : undefined
        if (index !== undefined) {
          const draft = drafts[index] as Draft
          draft.content = `${draft.content}\n${header}\n${resultText || '[empty result]'}`
          pendingTools.delete(toolUseId as string)
        } else {
          addText(`tool-result:${toolUseId ?? baseId}`, 'tool-result', 'tool-result', `${header}\n${resultText}`)
        }
      }
      continue
    }

    if (type === 'assistant' && message && Array.isArray(content)) {
      const texts: string[] = []
      const flushText = (suffix: string) => {
        if (texts.length > 0) addText(`${baseId}:${suffix}`, 'assistant', 'assistant', texts.join('\n'))
        texts.length = 0
      }
      content.forEach((block, i) => {
        if (!isObj(block)) return
        if (block.type === 'text') texts.push(str(block.text) ?? '')
        else if (block.type === 'thinking' || block.type === 'redacted_thinking') stats.thinkingBlocks++
        else if (block.type === 'tool_use') {
          flushText(`text${i}`)
          const name = str(block.name) ?? 'unknown-tool'
          const toolUseId = str(block.id) ?? `${baseId}:${i}`
          const input = isObj(block.input) ? block.input : {}
          const filePath = str(input.file_path) ?? str(input.notebook_path)
          const kind: ContextKind = name === 'Read' ? 'file' : 'tool-result'
          const source = name === 'Read' && filePath ? filePath : filePath ? `${name} ${filePath}` : name
          drafts.push({
            id: `tool:${toolUseId}`,
            kind,
            source,
            protected: false,
            content: `Tool call: ${name}\n${renderInput(input)}`,
            humanPrompt: false,
          })
          pendingTools.set(toolUseId, drafts.length - 1)
        }
      })
      flushText('text')
      continue
    }

    if (type === 'system') {
      const text = str(entry.content)
      if (text) addText(baseId, 'other', `system:${str(entry.subtype) ?? 'message'}`, text)
      else count(stats.skippedByType, 'system')
      continue
    }

    if (type === 'attachment' && isObj(entry.attachment)) {
      const attachment = entry.attachment
      const text = str(attachment.content) ?? str(attachment.text)
      if (text) addText(baseId, 'other', `attachment:${str(attachment.type) ?? 'unknown'}`, text)
      else count(stats.skippedByType, 'attachment')
      continue
    }

    count(stats.skippedByType, BOOKKEEPING_TYPES.has(type) ? type : `other:${type}`)
  }

  for (const index of pendingTools.values()) {
    const draft = drafts[index] as Draft
    draft.content = `${draft.content}\nResult:\n[no result recorded]`
    stats.unmatchedToolCalls++
  }

  // The most recent human-typed prompt is protected: it is the latest instruction in the session.
  for (let i = drafts.length - 1; i >= 0; i--) {
    const draft = drafts[i] as Draft
    if (draft.humanPrompt) {
      draft.protected = true
      break
    }
  }

  const chunks: ContextChunk[] = []
  const seenIds = new Set<string>()
  for (const draft of drafts) {
    const parts = splitByBytes(draft.content, options.maxChunkBytes)
    if (parts.length > 1) stats.splitChunks++
    parts.forEach((part, i) => {
      let id = sanitizeLabel(parts.length > 1 ? `${draft.id}#${i + 1}` : draft.id).slice(0, 200)
      while (seenIds.has(id)) id = `${id.slice(0, 190)}~${chunks.length}`
      seenIds.add(id)
      chunks.push({
        id,
        ordinal: chunks.length,
        kind: draft.kind,
        source: sanitizeLabel(parts.length > 1 ? `${draft.source} [part ${i + 1}/${parts.length}]` : draft.source).slice(0, 1024),
        protected: draft.protected,
        content: part,
      })
    })
  }

  return {
    chunks,
    stats,
    ...(sessionId !== undefined && { sessionId }),
    ...(gitBranch !== undefined && { gitBranch }),
    ...(cwd !== undefined && { cwd }),
  }
}
