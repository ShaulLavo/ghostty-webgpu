import comparison from '../../docs/benchmarks/mac-m1/comparison.json'

export const SHOW_MEASUREMENTS = false

interface SummaryRow {
  readonly variant: string
  readonly path: string
  readonly count: number
  readonly metric: string
  readonly unit: string
  readonly median: number
}

const measures = [
  ['parse/ascii', 'ASCII parse throughput (higher is better)'],
  ['parse/logs', 'Logs parse throughput (higher is better)'],
  ['idle/cpu', 'Idle CPU (lower is better)'],
  ['memory/10k', 'Memory per 10k history rows (lower is better)'],
  ['write/p50', 'Write latency p50 (lower is better)'],
  ['input/p95', 'Input latency p95 (lower is better)'],
] as const

export function measurementRows(summary: readonly SummaryRow[]) {
  function value(variant: string, metric: string): string {
    const row = summary.find(
      (entry) =>
        entry.variant === variant &&
        entry.path === 'bytes' &&
        entry.count === 1 &&
        entry.metric === metric,
    )
    if (!row || !Number.isFinite(row.median))
      throw new TypeError(`Missing measurement: ${variant}/${metric}`)
    return `${row.median.toFixed(2)} ${row.unit}`
  }

  return measures.map(([metric, label]) => ({
    label,
    ghostty: value('ghostty-webgpu', metric),
    xterm: value('xterm-webgl', metric),
  }))
}

export const measurements = measurementRows(comparison.summary)
const { environment } = comparison
export const measurementEnvironment = `${environment.cpu} · ${environment.os} · Chromium ${environment.browser} · headed hardware GPU · AC power`
