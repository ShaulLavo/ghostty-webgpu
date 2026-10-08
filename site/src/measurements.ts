import snapshot from '../../docs/benchmarks/mac-m1-2026-10-08/scores.json'

const evidence = 'https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks'

interface MeasurementScore {
  readonly renderer: string
  readonly workload: string
  readonly history: string
  readonly energy: number
  readonly instructions: number
  readonly status: string
}

type Verdict = 'win' | 'even' | 'loss'

export interface MeasurementRow {
  readonly renderer: string
  readonly workload: string
  readonly history: string
  readonly energy: number
  readonly instructions: number
  readonly verdict: Verdict
}

interface BenchSeries {
  readonly name: string
  readonly version: string
  readonly ours: boolean
}

interface MeasuredTab {
  readonly kind: 'measured'
  readonly id: string
  readonly label: string
  readonly title: string
  readonly status: string
  readonly method: string
  readonly series: readonly [BenchSeries, BenchSeries]
  readonly rows: readonly MeasurementRow[]
}

interface PendingTab {
  readonly kind: 'pending'
  readonly id: string
  readonly label: string
  readonly title: string
  readonly status: string
  readonly method: string
}

export type BenchTab = MeasuredTab | PendingTab

const workloads: Readonly<Record<string, string>> = {
  'rolling-logs': 'Heavy log output',
  'rolling-unicode-logs': 'Heavy Unicode output',
  'unicode-emoji': 'One Unicode line per tick',
  'line-scroll': 'One ASCII line per tick',
  'interactive-edits': 'Typing-like edits',
}

const boundedRows = /\(([\d,]+) rows\)/.exec(snapshot.conditions.history['equal ~9k'])![1]
const histories: Readonly<Record<string, string>> = {
  'equal ~9k': `${boundedRows} final rows`,
  'full-stream': 'Full stream',
  'equal 889/0': 'Equal by construction',
}

function verdictOf(row: MeasurementScore): Verdict {
  if (row.status.includes('loss')) return 'loss'
  if (row.status.includes('even')) return 'even'
  return row.energy < 1 ? 'win' : 'loss'
}

export function measurementRows(scores: readonly MeasurementScore[]): MeasurementRow[] {
  return scores
    .filter((row) => row.status.startsWith('reviewed:'))
    .map((row) => ({
      renderer: row.renderer.replace('ghostty ', ''),
      workload: workloads[row.workload] ?? row.workload,
      history: histories[row.history] ?? row.history,
      energy: row.energy,
      instructions: row.instructions,
      verdict: verdictOf(row),
    }))
}

export const measurements = measurementRows(snapshot.scores)

export function rowNote(row: MeasurementRow) {
  if (row.verdict === 'even') return 'Roughly even.'
  if (row.verdict === 'win') return ''
  return `Loss: about ${Math.round((row.energy - 1) * 100)}% more CPU energy.`
}

const { conditions } = snapshot
const versions = conditions.versions
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
const measuredMethod = [
  sentence(conditions.setup),
  `CPU energy: ${conditions.energy}.`,
  `${conditions.host}, ${conditions.browser}.`,
  `Run ${conditions.acquisitionDate}.`,
].join(' ')

function measuredTab(renderer: string, counterpartNote: string): MeasuredTab {
  return {
    kind: 'measured',
    id: renderer.toLowerCase(),
    label: renderer,
    title: `CPU energy, ${renderer} against xterm.js ${renderer}`,
    status: snapshot.status,
    method: `${measuredMethod}${counterpartNote}`,
    series: [
      { name: 'ghostty-webgpu', version: versions['ghostty-webgpu'], ours: true },
      { name: 'xterm.js', version: versions['@xterm/xterm'], ours: false },
    ],
    rows: measurements.filter((row) => row.renderer === renderer),
  }
}

export const benchTabs: readonly BenchTab[] = [
  measuredTab('WebGL', ` xterm.js WebGL addon ${versions['@xterm/addon-webgl']}.`),
  measuredTab('DOM', ''),
  {
    kind: 'pending',
    id: 'parsing',
    label: 'Parsing',
    title: 'Parse throughput',
    status: 'Being re-measured on the current release.',
    method:
      'The 1 Oct parser numbers measured an older release, so they are withdrawn until a reviewed run on the current release.',
  },
  {
    kind: 'pending',
    id: 'latency',
    label: 'Latency',
    title: 'Write and keystroke to screen',
    status: 'Being re-measured.',
    method:
      'The earlier latency rows used a capture clock that distorted the result, so they were retired. The new run takes at least 100 samples per case, at 1 and 17 terminals.',
  },
]

export const benchLinks = {
  results: 'https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/benchmarks.md',
  recompute: `${evidence}/mac-m1-2026-10-08/README.md#recompute-without-a-browser`,
  recomputeCommand: 'node docs/benchmarks/mac-m1-2026-10-08/verify.mjs',
}
