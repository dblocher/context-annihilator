/**
 * Evaluation command. For each labeled fixture it runs the deployed service, scores the
 * keep/drop decisions against the hand labels, and compares task runs on the full context
 * (baseline) with task runs on the seed a fresh `/annihilate` session would receive
 * (filtered). Writes one JSON report and prints a summary table.
 *
 *   npx --yes node@22 node_modules/tsx/dist/cli.mjs scripts/evaluate.ts --region us-east-1 --profile david-dev
 *
 * Options:
 *   --fixtures <file|dir>    Repeatable. Default: test/fixtures
 *   --stack <name>           Default: $STACK_NAME or context-annihilator
 *   --region, --profile      AWS settings for the service and the task model
 *   --timeout <seconds>      Wait per job. Default: 240
 *   --task-model <id>        Default: $TASK_MODEL_ID or global.anthropic.claude-sonnet-4-6
 *   --task-max-tokens <n>    Default: 2000
 *   --task-temperature <t>   Default: 0
 *   --repeats <n>            Task runs per variant and fixture. Default: 1
 *   --skip-task-runs         Score labels, tokens, latency, and service cost only
 *   --prices <file>          Default: test/evaluation/prices.json
 *   --out <file>             Default: test/evaluation/runs/eval-<timestamp>.json
 *
 * Exit code 1 when the run fails or any fixture has a problem: the job did not complete,
 * protected or required context was dropped, a task run errored, or the filtered variant
 * passed fewer task runs than the baseline.
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import { BedrockTaskRunner } from '../src/adapters/bedrock/task-runner.js'
import { AnnihilatorClient } from '../src/client/service-client.js'
import type { JobResult } from '../src/contracts/api.js'
import { type LoadedFixture, parseFixture } from '../src/evaluation/fixture.js'
import {
  aggregateReports,
  costUsd,
  type FixtureLatency,
  type FixtureReport,
  fixtureCost,
  fixtureProblems,
  type PriceTable,
  parsePriceTable,
  scoreLabels,
  summarizeVariant,
  type TaskRunRecord,
  type TaskVariant,
} from '../src/evaluation/scoring.js'
import { evaluateChecks, renderBaselineContext, renderFilteredContext, TASK_SYSTEM_PROMPT, type TaskRunner } from '../src/evaluation/task.js'

const { values } = parseArgs({
  options: {
    fixtures: { type: 'string', multiple: true },
    stack: { type: 'string', default: process.env.STACK_NAME ?? 'context-annihilator' },
    region: { type: 'string' },
    profile: { type: 'string' },
    timeout: { type: 'string', default: '240' },
    'task-model': { type: 'string', default: process.env.TASK_MODEL_ID ?? 'global.anthropic.claude-sonnet-4-6' },
    'task-max-tokens': { type: 'string', default: '2000' },
    'task-temperature': { type: 'string', default: '0' },
    repeats: { type: 'string', default: '1' },
    'skip-task-runs': { type: 'boolean', default: false },
    prices: { type: 'string', default: 'test/evaluation/prices.json' },
    out: { type: 'string' },
  },
})

function numberOption(name: string, raw: string, min: number, max: number, integer: boolean): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`)
  }
  return value
}

const settings = {
  timeoutMs: numberOption('timeout', values.timeout as string, 10, 900, false) * 1000,
  taskModelId: values['task-model'] as string,
  taskMaxTokens: numberOption('task-max-tokens', values['task-max-tokens'] as string, 256, 16_000, true),
  taskTemperature: numberOption('task-temperature', values['task-temperature'] as string, 0, 1, false),
  repeats: numberOption('repeats', values.repeats as string, 1, 20, true),
  skipTaskRuns: values['skip-task-runs'] as boolean,
}

async function fixturePaths(inputs: readonly string[]): Promise<string[]> {
  const paths: string[] = []
  for (const input of inputs) {
    if ((await stat(input)).isDirectory()) {
      const names = (await readdir(input)).filter((name) => name.endsWith('.json')).sort()
      paths.push(...names.map((name) => join(input, name)))
    } else {
      paths.push(input)
    }
  }
  if (paths.length === 0) throw new Error(`no fixture files found in ${inputs.join(', ')}`)
  return paths
}

async function loadFixtures(paths: readonly string[]): Promise<LoadedFixture[]> {
  const fixtures: LoadedFixture[] = []
  const errors: string[] = []
  for (const path of paths) {
    try {
      fixtures.push(parseFixture(JSON.parse(await readFile(path, 'utf8')), basename(path, '.json'), path))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (errors.length > 0) throw new Error(errors.join('\n'))
  const requestIds = new Set<string>()
  for (const fixture of fixtures) {
    if (requestIds.has(fixture.request.requestId)) throw new Error(`two fixtures share requestId ${fixture.request.requestId}`)
    requestIds.add(fixture.request.requestId)
  }
  return fixtures
}

type Context = {
  client: AnnihilatorClient
  runner?: TaskRunner
  prices: PriceTable
  runTag: string
  unpriced: Set<string>
}

function price(ctx: Context, modelId: string | undefined, inputTokens: number, outputTokens: number): number | null {
  const usd = costUsd(ctx.prices, modelId, inputTokens, outputTokens)
  if (usd === null) ctx.unpriced.add(modelId ?? '(unknown model)')
  return usd
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runTasks(fixture: LoadedFixture, result: JobResult, runner: TaskRunner, ctx: Context): Promise<TaskRunRecord[]> {
  const contexts: Record<TaskVariant, string> = {
    baseline: renderBaselineContext(fixture.request),
    filtered: renderFilteredContext(result, fixture.request.currentPrompt),
  }
  const records: TaskRunRecord[] = []
  for (let run = 1; run <= settings.repeats; run++) {
    for (const variant of ['baseline', 'filtered'] as const) {
      process.stderr.write(`  task run ${run}/${settings.repeats} ${variant}\n`)
      try {
        const output = await runner.run({ system: TASK_SYSTEM_PROMPT, context: contexts[variant] })
        const checks = evaluateChecks(output.answer, fixture.checks)
        records.push({
          variant,
          run,
          modelId: output.modelId,
          latencyMs: output.latencyMs,
          usage: output.usage,
          costUsd: price(ctx, output.modelId, output.usage.inputTokens, output.usage.outputTokens),
          passed: checks.every((check) => check.passed),
          checks,
          answer: output.answer,
        })
      } catch (error) {
        records.push({ variant, run, error: errorMessage(error) })
      }
    }
  }
  return records
}

async function evaluateFixture(fixture: LoadedFixture, ctx: Context): Promise<FixtureReport> {
  const requestId = `${fixture.request.requestId}.eval-${ctx.runTag}`.slice(0, 128)
  const report: FixtureReport = { name: fixture.name, path: fixture.path, requestId, status: 'error', problems: [] }
  try {
    const submitStart = Date.now()
    const started = await ctx.client.startJob({ ...fixture.request, requestId })
    const submitted = Date.now()
    report.jobId = started.jobId
    process.stderr.write(`  job ${started.jobId}: ${started.eligibleCount} eligible, ${started.protectedCount} protected\n`)
    const result = await ctx.client.waitForResult(started.jobId, { pollIntervalMs: started.pollAfterMs, timeoutMs: settings.timeoutMs })
    const finished = Date.now()

    report.status = result.status
    if (result.failure) report.failure = result.failure
    if (result.summary) report.summary = result.summary
    const metrics = result.metrics
    if (metrics) {
      report.chunks = metrics.chunks
      report.tokens = { estimated: metrics.tokens }
    }
    if (result.manifest) report.labels = scoreLabels(result.manifest, fixture.labels)

    const timings = metrics?.timings
    const latency: FixtureLatency = { clientSubmitMs: submitted - submitStart, clientWaitMs: finished - submitted, clientWallMs: finished - submitStart }
    if (timings?.ingressToDispatchMs !== undefined) latency.ingressToDispatchMs = timings.ingressToDispatchMs
    if (timings?.summaryMs !== undefined) latency.summaryMs = timings.summaryMs
    if (timings?.fanOutLagMs) latency.fanOutLagMs = timings.fanOutLagMs
    if (timings?.decisionLatencyMs) latency.decisionLatencyMs = timings.decisionLatencyMs
    if (timings?.ingressToLastResultMs !== undefined) latency.ingressToLastResultMs = timings.ingressToLastResultMs

    let baseline: ReturnType<typeof summarizeVariant> | undefined
    let filtered: ReturnType<typeof summarizeVariant> | undefined
    if (ctx.runner && result.status === 'complete' && fixture.checks.length > 0) {
      if (!result.retained) throw new Error('the result has no retained content, so the filtered seed cannot be built')
      const runs = await runTasks(fixture, result, ctx.runner, ctx)
      const checkIds = fixture.checks.map((check) => check.id)
      baseline = summarizeVariant(runs.filter((r) => r.variant === 'baseline'), checkIds)
      filtered = summarizeVariant(runs.filter((r) => r.variant === 'filtered'), checkIds)
      report.task = { checkIds, baseline, filtered, runs }
      if (report.tokens) {
        const reduction = baseline.meanInputTokens && filtered.meanInputTokens !== null ? 1 - filtered.meanInputTokens / baseline.meanInputTokens : null
        report.tokens.taskInput = { baseline: baseline.meanInputTokens, filtered: filtered.meanInputTokens, reduction }
      }
      if (baseline.latencyMs) latency.baselineTaskMs = baseline.latencyMs
      if (filtered.latencyMs) latency.filteredTaskMs = filtered.latencyMs
    }
    report.latency = latency

    const usage = metrics?.usage
    const decisionModelId =
      result.manifest?.find((entry) => entry.outcome === 'decided' && entry.modelId)?.modelId ?? result.manifest?.find((entry) => entry.modelId)?.modelId
    report.cost = fixtureCost({
      summaryUsd: usage ? price(ctx, result.summaryModelId, usage.summaryInputTokens ?? 0, usage.summaryOutputTokens ?? 0) : null,
      decisionsUsd: usage ? price(ctx, decisionModelId, usage.decisionInputTokens, usage.decisionOutputTokens) : null,
      ...(baseline && { baseline }),
      ...(filtered && { filtered }),
    })
  } catch (error) {
    report.status = 'error'
    report.failure = errorMessage(error)
  }
  report.problems = fixtureProblems(report)
  return report
}

const pct = (value: number | null | undefined) => (value === null || value === undefined ? '-' : `${(value * 100).toFixed(0)}%`)
const usd = (value: number | null | undefined) => (value === null || value === undefined ? '-' : `$${value.toFixed(4)}`)
const pad = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width))

function printTable(reports: readonly FixtureReport[]): void {
  const columns: Array<[string, number]> = [
    ['fixture', 24], ['status', 9], ['req', 5], ['sup', 5], ['prec', 5], ['irr drop', 9], ['elig red', 9], ['oracle', 7],
    ['base', 5], ['filt', 5], ['wall s', 7], ['service', 9],
  ]
  console.log(columns.map(([name, width]) => pad(name, width)).join(' '))
  for (const r of reports) {
    const cells = [
      r.name,
      r.status,
      pct(r.labels?.requiredRecall),
      pct(r.labels?.supportingRecall),
      pct(r.labels?.retainedPrecision),
      pct(r.labels?.irrelevantDropRate),
      pct(r.tokens?.estimated.eligibleReduction),
      pct(r.labels?.oracleEligibleReduction),
      r.task ? `${r.task.baseline.passed}/${r.task.baseline.runs}` : '-',
      r.task ? `${r.task.filtered.passed}/${r.task.filtered.runs}` : '-',
      r.latency ? (r.latency.clientWallMs / 1000).toFixed(1) : '-',
      usd(r.cost?.serviceUsd),
    ]
    console.log(cells.map((cell, i) => pad(cell, columns[i]?.[1] ?? 8)).join(' '))
  }
}

async function main() {
  const startedAt = new Date()
  const fixtures = await loadFixtures(await fixturePaths(values.fixtures?.length ? values.fixtures : ['test/fixtures']))
  const prices = parsePriceTable(JSON.parse(await readFile(values.prices as string, 'utf8')), values.prices as string)
  const region = values.region ?? process.env.AWS_REGION
  const aws = { ...(region && { region }), ...(values.profile && { profile: values.profile }) }
  const ctx: Context = {
    client: new AnnihilatorClient({ stackName: values.stack as string, ...aws }),
    ...(!settings.skipTaskRuns && {
      runner: new BedrockTaskRunner(new BedrockRuntimeClient(aws), {
        modelId: settings.taskModelId,
        maxTokens: settings.taskMaxTokens,
        temperature: settings.taskTemperature,
      }),
    }),
    prices,
    runTag: startedAt.getTime().toString(36),
    unpriced: new Set(),
  }

  // Sequential on purpose: parallel jobs would compete for Lambda concurrency and Bedrock
  // quotas and distort the latency numbers.
  const reports: FixtureReport[] = []
  for (const fixture of fixtures) {
    process.stderr.write(`${fixture.name}\n`)
    reports.push(await evaluateFixture(fixture, ctx))
  }

  const aggregate = aggregateReports(reports)
  const problems = reports.flatMap((r) => r.problems.map((p) => `${r.name}: ${p}`))
  const out = values.out ?? join('test', 'evaluation', 'runs', `eval-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(
    out,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        config: {
          stack: values.stack,
          region: region ?? null,
          taskModelId: settings.skipTaskRuns ? null : settings.taskModelId,
          taskMaxTokens: settings.taskMaxTokens,
          taskTemperature: settings.taskTemperature,
          repeats: settings.skipTaskRuns ? 0 : settings.repeats,
          timeoutSeconds: settings.timeoutMs / 1000,
          prices: { path: values.prices, source: prices.source ?? null, checkedOn: prices.checkedOn ?? null },
          fixtures: fixtures.map((f) => f.path),
        },
        aggregate,
        unpricedModels: [...ctx.unpriced].sort(),
        problems,
        fixtures: reports,
      },
      null,
      2,
    )}\n`,
  )

  console.log('')
  printTable(reports)
  const a = aggregate
  console.log('')
  console.log(
    `labels: required recall ${pct(a.labels.requiredRecall)}, supporting recall ${pct(a.labels.supportingRecall)}, ` +
      `retained precision ${pct(a.labels.retainedPrecision)}, irrelevant dropped ${pct(a.labels.irrelevantDropRate)}`,
  )
  const taskReduction = a.tokens.taskInputReduction
  console.log(
    `tokens: estimated total reduction ${pct(a.tokens.estimatedTotalReduction)}; task-model input ${a.tokens.taskInputBaseline ?? '-'} baseline, ` +
      `${a.tokens.taskInputFiltered ?? '-'} filtered` +
      (taskReduction === null ? '' : taskReduction >= 0 ? ` (${pct(taskReduction)} smaller)` : ` (seed is ${pct(-taskReduction)} larger)`),
  )
  console.log(
    `task success: baseline ${a.task.baseline.passed}/${a.task.baseline.runs - a.task.baseline.errors}, ` +
      `filtered ${a.task.filtered.passed}/${a.task.filtered.runs - a.task.filtered.errors}` +
      (a.task.regressions.length > 0 ? `; regressions: ${a.task.regressions.join(', ')}` : ''),
  )
  console.log(`cost: service ${usd(a.cost.serviceUsd)}, baseline task runs ${usd(a.cost.baselineTaskUsd)}, filtered task runs ${usd(a.cost.filteredTaskUsd)}`)
  if (ctx.unpriced.size > 0) console.log(`no price in ${values.prices} for: ${[...ctx.unpriced].join(', ')}`)
  console.log(`\nwrote ${out}`)
  if (problems.length > 0) {
    console.error(`\nproblems:\n- ${problems.join('\n- ')}`)
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error))
  process.exitCode = 1
})
