import type { JobMetrics, LatencyStats, ManifestEntry } from '../contracts/api.js'
import type { ReasonCode } from '../contracts/decisions.js'
import { latencyStats } from '../domain/util/stats.js'
import type { FixtureLabel } from './fixture.js'
import type { CheckOutcome, TaskAnswer } from './task.js'

const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : numerator / denominator)
const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length)

/** Sum that is null when any part is unknown, so a partial cost is never shown as a total. */
function sumOrNull(values: ReadonlyArray<number | null | undefined>): number | null {
  let total = 0
  for (const value of values) {
    if (value === null || value === undefined) return null
    total += value
  }
  return total
}

// ---------- labels ----------

export type LabelCounts = {
  required: { total: number; kept: number }
  supporting: { total: number; kept: number }
  irrelevant: { total: number; dropped: number }
}

export type LabelMetrics = {
  eligible: number
  labeled: number
  unlabeledEligible: number
  /** Kept required chunks / labeled required chunks. */
  requiredRecall: number | null
  supportingRecall: number | null
  /** Required and supporting together. */
  relevantRecall: number | null
  /** Kept chunks labeled required or supporting / all kept labeled chunks. Protected chunks are excluded. */
  retainedPrecision: number | null
  /** Dropped irrelevant chunks / labeled irrelevant chunks. */
  irrelevantDropRate: number | null
  /** Eligible-token reduction a perfect filter would reach on this fixture (irrelevant tokens / eligible tokens). */
  oracleEligibleReduction: number | null
  counts: LabelCounts
  falseDrops: Array<{ chunkId: string; label: 'required' | 'supporting'; reason: string; reasonCode?: ReasonCode }>
  /** Irrelevant chunks that were kept. `outcome` separates model verdicts from fail-open keeps. */
  falseKeeps: Array<{ chunkId: string; outcome: ManifestEntry['outcome']; decision: ManifestEntry['decision']; reason: string }>
  protectedDrops: string[]
}

/** Scores a result manifest against hand labels. Reads `outcome`, not only `decision` (ADR 0002). */
export function scoreLabels(manifest: readonly ManifestEntry[], labels: Readonly<Record<string, FixtureLabel>>): LabelMetrics {
  const counts: LabelCounts = { required: { total: 0, kept: 0 }, supporting: { total: 0, kept: 0 }, irrelevant: { total: 0, dropped: 0 } }
  const falseDrops: LabelMetrics['falseDrops'] = []
  const falseKeeps: LabelMetrics['falseKeeps'] = []
  const protectedDrops: string[] = []
  let eligible = 0
  let unlabeledEligible = 0
  let keptLabeled = 0
  let keptRelevant = 0
  let eligibleTokens = 0
  let irrelevantTokens = 0

  for (const entry of manifest) {
    if (entry.protected) {
      if (!entry.keep) protectedDrops.push(entry.chunkId)
      continue
    }
    eligible++
    eligibleTokens += entry.estimatedTokens
    const label = labels[entry.chunkId]?.label
    if (label === undefined) {
      unlabeledEligible++
      continue
    }
    if (entry.keep) keptLabeled++
    if (label === 'irrelevant') {
      irrelevantTokens += entry.estimatedTokens
      counts.irrelevant.total++
      if (entry.keep) falseKeeps.push({ chunkId: entry.chunkId, outcome: entry.outcome, decision: entry.decision, reason: entry.reason })
      else counts.irrelevant.dropped++
    } else {
      counts[label].total++
      if (entry.keep) {
        counts[label].kept++
        keptRelevant++
      } else {
        falseDrops.push({ chunkId: entry.chunkId, label, reason: entry.reason, ...(entry.reasonCode && { reasonCode: entry.reasonCode }) })
      }
    }
  }

  return {
    eligible,
    labeled: eligible - unlabeledEligible,
    unlabeledEligible,
    requiredRecall: ratio(counts.required.kept, counts.required.total),
    supportingRecall: ratio(counts.supporting.kept, counts.supporting.total),
    relevantRecall: ratio(counts.required.kept + counts.supporting.kept, counts.required.total + counts.supporting.total),
    retainedPrecision: ratio(keptRelevant, keptLabeled),
    irrelevantDropRate: ratio(counts.irrelevant.dropped, counts.irrelevant.total),
    oracleEligibleReduction: ratio(irrelevantTokens, eligibleTokens),
    counts,
    falseDrops,
    falseKeeps,
    protectedDrops,
  }
}

// ---------- prices ----------

export type ModelPrice = { inputPerMTok: number; outputPerMTok: number }
export type PriceTable = { source?: string; checkedOn?: string; models: Record<string, ModelPrice> }

export function parsePriceTable(value: unknown, path: string): PriceTable {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  const models = record?.models
  if (typeof models !== 'object' || models === null) throw new Error(`${path}: expected an object with a "models" map`)
  const parsed: Record<string, ModelPrice> = {}
  for (const [modelId, price] of Object.entries(models as Record<string, unknown>)) {
    const p = price as Partial<ModelPrice> | null
    if (!p || typeof p.inputPerMTok !== 'number' || typeof p.outputPerMTok !== 'number' || p.inputPerMTok < 0 || p.outputPerMTok < 0) {
      throw new Error(`${path}: models["${modelId}"] needs non-negative inputPerMTok and outputPerMTok`)
    }
    parsed[modelId] = { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok }
  }
  return {
    ...(typeof record?.source === 'string' && { source: record.source }),
    ...(typeof record?.checkedOn === 'string' && { checkedOn: record.checkedOn }),
    models: parsed,
  }
}

/** USD for one model's usage, or null when the model has no price in the table. */
export function costUsd(prices: PriceTable, modelId: string | undefined, inputTokens: number, outputTokens: number): number | null {
  if (inputTokens === 0 && outputTokens === 0) return 0
  const price = modelId ? prices.models[modelId] : undefined
  if (!price) return null
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000
}

// ---------- task runs ----------

export type TaskVariant = 'baseline' | 'filtered'

export type TaskRunRecord = {
  variant: TaskVariant
  run: number
  modelId?: string
  latencyMs?: number
  usage?: { inputTokens: number; outputTokens: number }
  costUsd?: number | null
  passed?: boolean
  checks?: CheckOutcome[]
  answer?: TaskAnswer
  /** Set when the model call failed. Such runs count as errors, not as task failures. */
  error?: string
}

export type VariantSummary = {
  runs: number
  errors: number
  passed: number
  /** Passed runs / runs without errors. */
  successRate: number | null
  checkPassRates: Record<string, number | null>
  meanInputTokens: number | null
  meanOutputTokens: number | null
  latencyMs?: LatencyStats
  meanCostUsd: number | null
}

export function summarizeVariant(records: readonly TaskRunRecord[], checkIds: readonly string[]): VariantSummary {
  const ok = records.filter((r) => r.error === undefined)
  const checkPassRates: Record<string, number | null> = {}
  for (const id of checkIds) {
    checkPassRates[id] = ratio(ok.filter((r) => r.checks?.find((c) => c.id === id)?.passed).length, ok.length)
  }
  const latency = latencyStats(ok.flatMap((r) => (r.latencyMs === undefined ? [] : [r.latencyMs])))
  const costs = ok.map((r) => r.costUsd)
  return {
    runs: records.length,
    errors: records.length - ok.length,
    passed: ok.filter((r) => r.passed).length,
    successRate: ratio(ok.filter((r) => r.passed).length, ok.length),
    checkPassRates,
    meanInputTokens: mean(ok.map((r) => r.usage?.inputTokens ?? 0)),
    meanOutputTokens: mean(ok.map((r) => r.usage?.outputTokens ?? 0)),
    ...(latency && { latencyMs: latency }),
    meanCostUsd: costs.length === 0 || costs.some((c) => c === null || c === undefined) ? null : mean(costs as number[]),
  }
}

// ---------- reports ----------

export type FixtureLatency = {
  clientSubmitMs: number
  clientWaitMs: number
  clientWallMs: number
  ingressToDispatchMs?: number
  summaryMs?: number
  fanOutLagMs?: LatencyStats
  decisionLatencyMs?: LatencyStats
  ingressToLastResultMs?: number
  baselineTaskMs?: LatencyStats
  filteredTaskMs?: LatencyStats
}

export type FixtureCost = {
  summaryUsd: number | null
  decisionsUsd: number | null
  /** Summary plus decisions: what one handoff costs in model calls. Lambda, SNS, DynamoDB, and S3 are not included. */
  serviceUsd: number | null
  baselineRunUsd: number | null
  filteredRunUsd: number | null
  /** Baseline minus filtered cost of one task turn. Negative when the seed is larger than the full context. */
  savingsPerTurnUsd: number | null
  /** Task turns at this context size before the savings repay the service cost. Null when there are no savings. */
  breakEvenTurns: number | null
}

export type FixtureReport = {
  name: string
  path: string
  requestId: string
  jobId?: string
  status: 'complete' | 'failed' | 'running' | 'error'
  failure?: string
  chunks?: JobMetrics['chunks']
  labels?: LabelMetrics
  tokens?: {
    /** Service estimates (characters / 4). */
    estimated: JobMetrics['tokens']
    /** Input tokens the task model was billed for, mean per run. */
    taskInput?: { baseline: number | null; filtered: number | null; reduction: number | null }
  }
  task?: { checkIds: string[]; baseline: VariantSummary; filtered: VariantSummary; runs: TaskRunRecord[] }
  latency?: FixtureLatency
  cost?: FixtureCost
  summary?: string
  problems: string[]
}

export function fixtureCost(input: {
  summaryUsd: number | null
  decisionsUsd: number | null
  baseline?: VariantSummary
  filtered?: VariantSummary
}): FixtureCost {
  const serviceUsd = sumOrNull([input.summaryUsd, input.decisionsUsd])
  const baselineRunUsd = input.baseline?.meanCostUsd ?? null
  const filteredRunUsd = input.filtered?.meanCostUsd ?? null
  const savingsPerTurnUsd = baselineRunUsd !== null && filteredRunUsd !== null ? baselineRunUsd - filteredRunUsd : null
  return {
    summaryUsd: input.summaryUsd,
    decisionsUsd: input.decisionsUsd,
    serviceUsd,
    baselineRunUsd,
    filteredRunUsd,
    savingsPerTurnUsd,
    breakEvenTurns: serviceUsd !== null && savingsPerTurnUsd !== null && savingsPerTurnUsd > 0 ? serviceUsd / savingsPerTurnUsd : null,
  }
}

/**
 * Invariant violations that make the evaluation exit non-zero: the job did not complete,
 * protected context was dropped, a required chunk was dropped, a task run errored, or the
 * filtered variant passed fewer runs than the baseline.
 */
export function fixtureProblems(report: FixtureReport): string[] {
  const problems: string[] = []
  if (report.status !== 'complete') problems.push(`job ${report.status}${report.failure ? `: ${report.failure}` : ''}`)
  for (const id of report.labels?.protectedDrops ?? []) problems.push(`protected chunk ${id} was dropped`)
  for (const drop of report.labels?.falseDrops ?? []) {
    if (drop.label === 'required') problems.push(`required chunk ${drop.chunkId} was dropped (${drop.reason})`)
  }
  if (report.task) {
    const { baseline, filtered } = report.task
    if (baseline.errors + filtered.errors > 0) problems.push(`${baseline.errors + filtered.errors} task run(s) failed with an error`)
    if (filtered.passed < baseline.passed) {
      problems.push(`filtered context passed ${filtered.passed} of ${filtered.runs} task runs; baseline passed ${baseline.passed} of ${baseline.runs}`)
    }
  }
  return problems
}

export type EvaluationAggregate = {
  fixtures: number
  completed: number
  labels: {
    counts: LabelCounts
    requiredRecall: number | null
    supportingRecall: number | null
    relevantRecall: number | null
    retainedPrecision: number | null
    irrelevantDropRate: number | null
    unlabeledEligible: number
    falseDrops: number
    falseKeeps: number
    protectedDrops: number
  }
  tokens: {
    estimatedTotalInput: number
    estimatedTotalRetained: number
    estimatedTotalReduction: number | null
    meanEligibleReduction: number | null
    meanOracleEligibleReduction: number | null
    taskInputBaseline: number | null
    taskInputFiltered: number | null
    taskInputReduction: number | null
  }
  task: {
    baseline: { runs: number; errors: number; passed: number; successRate: number | null }
    filtered: { runs: number; errors: number; passed: number; successRate: number | null }
    regressions: string[]
    improvements: string[]
  }
  latency: {
    clientWallMs?: LatencyStats
    ingressToDispatchMs?: LatencyStats
    summaryMs?: LatencyStats
    ingressToLastResultMs?: LatencyStats
    fanOutLagP95Ms?: LatencyStats
    decisionLatencyP95Ms?: LatencyStats
    baselineTaskMs?: LatencyStats
    filteredTaskMs?: LatencyStats
  }
  cost: { serviceUsd: number | null; baselineTaskUsd: number | null; filteredTaskUsd: number | null }
}

/** Pools counts across fixtures (micro averages), so large fixtures weigh more than small ones. */
export function aggregateReports(reports: readonly FixtureReport[]): EvaluationAggregate {
  const counts: LabelCounts = { required: { total: 0, kept: 0 }, supporting: { total: 0, kept: 0 }, irrelevant: { total: 0, dropped: 0 } }
  let keptLabeled = 0
  let unlabeledEligible = 0
  let falseDrops = 0
  let falseKeeps = 0
  let protectedDrops = 0
  for (const report of reports) {
    const labels = report.labels
    if (!labels) continue
    for (const key of ['required', 'supporting'] as const) {
      counts[key].total += labels.counts[key].total
      counts[key].kept += labels.counts[key].kept
    }
    counts.irrelevant.total += labels.counts.irrelevant.total
    counts.irrelevant.dropped += labels.counts.irrelevant.dropped
    keptLabeled += labels.counts.required.kept + labels.counts.supporting.kept + labels.falseKeeps.length
    unlabeledEligible += labels.unlabeledEligible
    falseDrops += labels.falseDrops.length
    falseKeeps += labels.falseKeeps.length
    protectedDrops += labels.protectedDrops.length
  }
  const keptRelevant = counts.required.kept + counts.supporting.kept

  const estimated = reports.flatMap((r) => (r.tokens ? [r.tokens.estimated] : []))
  const estimatedTotalInput = estimated.reduce((sum, t) => sum + t.totalInput, 0)
  const estimatedTotalRetained = estimated.reduce((sum, t) => sum + t.totalRetained, 0)
  const taskInputs = reports.flatMap((r) => (r.tokens?.taskInput ? [r.tokens.taskInput] : []))
  const taskInputBaseline = taskInputs.length > 0 ? sumOrNull(taskInputs.map((t) => t.baseline)) : null
  const taskInputFiltered = taskInputs.length > 0 ? sumOrNull(taskInputs.map((t) => t.filtered)) : null

  const variantTotals = (variant: 'baseline' | 'filtered') => {
    const summaries = reports.flatMap((r) => (r.task ? [r.task[variant]] : []))
    const runs = summaries.reduce((sum, s) => sum + s.runs, 0)
    const errors = summaries.reduce((sum, s) => sum + s.errors, 0)
    const passed = summaries.reduce((sum, s) => sum + s.passed, 0)
    return { runs, errors, passed, successRate: ratio(passed, runs - errors) }
  }
  const withTask = reports.filter((r) => r.task)

  const stat = (values: Array<number | undefined>) => latencyStats(values.filter((v): v is number => v !== undefined))
  const runLatencies = (variant: TaskVariant) =>
    stat(reports.flatMap((r) => r.task?.runs.filter((run) => run.variant === variant && run.error === undefined).map((run) => run.latencyMs) ?? []))
  const latency: EvaluationAggregate['latency'] = {}
  const put = (key: keyof EvaluationAggregate['latency'], value: LatencyStats | undefined) => {
    if (value) latency[key] = value
  }
  put('clientWallMs', stat(reports.map((r) => r.latency?.clientWallMs)))
  put('ingressToDispatchMs', stat(reports.map((r) => r.latency?.ingressToDispatchMs)))
  put('summaryMs', stat(reports.map((r) => r.latency?.summaryMs)))
  put('ingressToLastResultMs', stat(reports.map((r) => r.latency?.ingressToLastResultMs)))
  put('fanOutLagP95Ms', stat(reports.map((r) => r.latency?.fanOutLagMs?.p95)))
  put('decisionLatencyP95Ms', stat(reports.map((r) => r.latency?.decisionLatencyMs?.p95)))
  put('baselineTaskMs', runLatencies('baseline'))
  put('filteredTaskMs', runLatencies('filtered'))

  const taskCost = (variant: TaskVariant) =>
    withTask.length === 0 ? null : sumOrNull(reports.flatMap((r) => r.task?.runs.filter((run) => run.variant === variant && run.error === undefined).map((run) => run.costUsd) ?? []))

  return {
    fixtures: reports.length,
    completed: reports.filter((r) => r.status === 'complete').length,
    labels: {
      counts,
      requiredRecall: ratio(counts.required.kept, counts.required.total),
      supportingRecall: ratio(counts.supporting.kept, counts.supporting.total),
      relevantRecall: ratio(keptRelevant, counts.required.total + counts.supporting.total),
      retainedPrecision: ratio(keptRelevant, keptLabeled),
      irrelevantDropRate: ratio(counts.irrelevant.dropped, counts.irrelevant.total),
      unlabeledEligible,
      falseDrops,
      falseKeeps,
      protectedDrops,
    },
    tokens: {
      estimatedTotalInput,
      estimatedTotalRetained,
      estimatedTotalReduction: estimatedTotalInput === 0 ? null : 1 - estimatedTotalRetained / estimatedTotalInput,
      meanEligibleReduction: mean(estimated.map((t) => t.eligibleReduction)),
      meanOracleEligibleReduction: mean(reports.flatMap((r) => (r.labels?.oracleEligibleReduction != null ? [r.labels.oracleEligibleReduction] : []))),
      taskInputBaseline,
      taskInputFiltered,
      taskInputReduction: taskInputBaseline && taskInputFiltered !== null ? 1 - taskInputFiltered / taskInputBaseline : null,
    },
    task: {
      baseline: variantTotals('baseline'),
      filtered: variantTotals('filtered'),
      regressions: withTask.filter((r) => r.task && r.task.filtered.passed < r.task.baseline.passed).map((r) => r.name),
      improvements: withTask.filter((r) => r.task && r.task.filtered.passed > r.task.baseline.passed).map((r) => r.name),
    },
    latency,
    cost: {
      serviceUsd: reports.some((r) => r.cost) ? sumOrNull(reports.flatMap((r) => (r.cost ? [r.cost.serviceUsd] : []))) : null,
      baselineTaskUsd: taskCost('baseline'),
      filteredTaskUsd: taskCost('filtered'),
    },
  }
}
