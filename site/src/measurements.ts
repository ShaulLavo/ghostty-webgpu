import snapshot from '../../docs/benchmarks/mac-m1-2026-10-08/scores.json'

interface MeasurementScore {
  readonly renderer: string
  readonly workload: string
  readonly energy: number
  readonly instructions: number
  readonly status: string
}

const workloads: Readonly<Record<string, string>> = {
  'rolling-logs': 'Heavy log output',
  'rolling-unicode-logs': 'Heavy Unicode output',
  'unicode-emoji': 'One Unicode line per tick',
  'line-scroll': 'One ASCII line per tick',
  'interactive-edits': 'Typing-like edits',
}

export function measurementRows(scores: readonly MeasurementScore[]) {
  return scores
    .filter((row) => row.status.startsWith('reviewed:'))
    .map((row) => ({
      renderer: row.renderer.replace('ghostty ', ''),
      workload: workloads[row.workload] ?? row.workload,
      energy: row.energy.toFixed(3),
      instructions: row.instructions.toFixed(3),
    }))
}

export const measurements = measurementRows(snapshot.scores)
const { conditions } = snapshot
export const measurementEnvironment = `Reviewed ${snapshot.generated}. ${conditions.host}. ${conditions.browser}. Frozen ghostty-webgpu ${conditions.versions['ghostty-webgpu']} vs xterm.js ${conditions.versions['@xterm/xterm']}, WebGL addon ${conditions.versions['@xterm/addon-webgl']}.`
