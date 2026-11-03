/**
 * Structured logs and CloudWatch Embedded Metric Format, written as raw stdout lines.
 *
 * Fields accept scalars only. That makes it awkward to log payloads by accident: chunk
 * content, prompts, and summaries must never be logged (the seed's "full context is absent
 * from normal logs" requirement).
 */
export type LogFields = Record<string, string | number | boolean | undefined>

type Unit = 'Count' | 'Milliseconds' | 'Percent' | 'None'

const NAMESPACE = process.env.METRICS_NAMESPACE ?? 'ContextAnnihilator'
const SERVICE = 'context-annihilator'

function write(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

export function logEvent(level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void {
  write({
    timestamp: new Date().toISOString(),
    level,
    event,
    function: process.env.AWS_LAMBDA_FUNCTION_NAME,
    ...fields,
  })
}

export function emitMetrics(metrics: Record<string, { value: number; unit: Unit }>, properties: LogFields = {}): void {
  const names = Object.keys(metrics)
  if (names.length === 0) return
  const values: Record<string, number> = {}
  for (const name of names) values[name] = (metrics[name] as { value: number }).value
  write({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [['Service']],
          Metrics: names.map((name) => ({ Name: name, Unit: (metrics[name] as { unit: Unit }).unit })),
        },
      ],
    },
    Service: SERVICE,
    ...values,
    ...properties,
  })
}
