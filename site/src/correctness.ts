import results from '../../docs/correctness-results.json'
import provenance from '../../ghostty-vt.provenance.json'

interface CorrectnessCase {
  readonly suite: string
  readonly name: string
  readonly status: string
  readonly variant: string
  readonly inputHex?: string
}

export interface TerminalScore {
  readonly terminal: string
  readonly version: string
  readonly pass: number
  readonly fail: number
}

export function correctnessScores(
  cases: readonly CorrectnessCase[],
  versions: Readonly<Record<string, string>>,
): TerminalScore[] {
  const scores = new Map<string, { pass: number; fail: number }>()
  for (const item of cases) {
    const score = scores.get(item.variant) ?? { pass: 0, fail: 0 }
    if (item.status === 'pass') score.pass += 1
    else score.fail += 1
    scores.set(item.variant, score)
  }
  return [...scores].map(([terminal, score]) => ({
    terminal,
    version: versions[terminal] ?? '',
    ...score,
  }))
}

const cases: readonly CorrectnessCase[] = results.results
const ours = cases.filter((item) => item.variant === 'ghostty-webgpu')

export const correctness = {
  date: results.date.slice(0, 10),
  scores: correctnessScores(cases, results.versions),
  upstreamCases: ours.filter((item) => item.inputHex !== undefined).length,
  localCases: ours.filter((item) => item.inputHex === undefined).length,
  ourFailures: ours.filter((item) => item.status !== 'pass').map((item) => item.name),
  chromium: results.versions.chromium,
  doc: 'https://github.com/ShaulLavo/ghostty-webgpu/blob/main/docs/correctness.md',
}

export const core = {
  revision: provenance.source.revision.slice(0, 7),
  revisionUrl: `https://github.com/ghostty-org/ghostty/tree/${provenance.source.revision}`,
  patched: provenance.source.patched,
  zig: provenance.compiler.version,
}
