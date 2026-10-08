import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import snapshot from '../../docs/benchmarks/mac-m1-2026-10-08/scores.json'
import { benchTabs, measurementRows, measurements, rowNote } from './measurements'
import results from '../../docs/correctness-results.json'
import { correctness, correctnessScores } from './correctness'

test('uses all nine reviewed scores, including the losing workloads', () => {
  expect(measurements).toHaveLength(9)
  expect(measurements).toEqual(measurementRows(snapshot.scores))
  expect(measurements).toContainEqual({
    renderer: 'WebGL',
    workload: 'One Unicode line per tick',
    history: 'Equal by construction',
    energy: 1.3202,
    instructions: 1.3476,
    verdict: 'loss',
  })
  expect(measurements).toContainEqual({
    renderer: 'DOM',
    workload: 'Typing-like edits',
    history: 'Equal by construction',
    energy: 1.1475,
    instructions: 1.1514,
    verdict: 'loss',
  })
})

test('charts every reviewed row under its renderer tab and labels the losses', () => {
  const charted = benchTabs.flatMap((tab) => (tab.kind === 'measured' ? tab.rows : []))
  expect(charted).toHaveLength(measurements.length)
  const losses = charted.filter((row) => row.verdict === 'loss').map(rowNote)
  expect(losses).toEqual([
    'Loss: about 32% more CPU energy.',
    'Loss: about 36% more CPU energy.',
    'Loss: about 15% more CPU energy.',
  ])
  expect(charted.find((row) => row.verdict === 'even')?.workload).toBe('Typing-like edits')
})

test('counts correctness results from the saved run', () => {
  expect(correctness.scores).toEqual(correctnessScores(results.results, results.versions))
  expect(correctness.scores).toEqual([
    { terminal: 'ghostty-webgpu', version: '0.3.20', pass: 167, fail: 2 },
    { terminal: 'xterm.js', version: '6.0.0', pass: 126, fail: 43 },
    { terminal: 'ghostty-web', version: '0.4.0', pass: 161, fail: 8 },
  ])
  expect(correctness.upstreamCases).toBe(132)
  expect(correctness.localCases).toBe(37)
  expect(correctness.ourFailures).toEqual(['test_CHA_RespectsOriginMode', 'test_TBC_Default'])
})

test('recomputes the evidence and checks the generated public tables', () => {
  const root = new URL('../../docs/benchmarks/mac-m1-2026-10-08/', import.meta.url)
  const verify = execFileSync(process.execPath, [fileURLToPath(new URL('verify.mjs', root))], {
    encoding: 'utf8',
  })
  const report = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('report.mjs', root)), '--check'],
    { encoding: 'utf8' },
  )
  expect(verify).toContain('9 reviewed rows reproduce')
  expect(report).toContain('README match reviewed data')
})

test('omits experimental rows and preserves reviewed losses', () => {
  const reviewed = { ...snapshot.scores[0]!, energy: 2, instructions: 3 }
  const experiment = { ...reviewed, renderer: 'ghostty Canvas', status: 'descriptive only' }
  expect(measurementRows([experiment, reviewed])).toEqual([
    {
      renderer: 'WebGL',
      workload: 'Heavy log output',
      history: '8,841 final rows',
      energy: 2,
      instructions: 3,
      verdict: 'loss',
    },
  ])
})

test('refreshes the README WebGL table without replacing product copy', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ghostty-report-'))
  const reportDirectory = path.join(directory, 'docs/benchmarks/mac-m1-2026-10-08')
  const source = new URL('../../docs/benchmarks/mac-m1-2026-10-08/', import.meta.url)
  const before =
    '# Ghostty browser terminal\n\n## Measured wins and losses\n\nKeep the reviewed method and limits.\n\n'
  const after =
    '\nKeep the workload qualifications.\n\n### Correctness\n\nKeep the correctness results.\n\n## Quick start\n\nKeep the source setup.\n'
  try {
    mkdirSync(reportDirectory, { recursive: true })
    for (const file of ['report.mjs', 'scores.json'])
      copyFileSync(fileURLToPath(new URL(file, source)), path.join(reportDirectory, file))
    writeFileSync(
      path.join(directory, 'README.md'),
      `${before}| WebGL vs xterm.js WebGL | CPU energy ratio | Instruction ratio |\n| --- | ---: | ---: |\n| Stale workload | 999 | 999 |\n${after}`,
    )
    const script = path.join(reportDirectory, 'report.mjs')
    execFileSync(process.execPath, [script])
    const updated = readFileSync(path.join(directory, 'README.md'), 'utf8')
    expect(updated.startsWith(before)).toBe(true)
    expect(updated.endsWith(after)).toBe(true)
    expect(updated).toContain('| Heavy log output | 0.751 | 0.690 |')
    expect(updated).toContain('| One ASCII line per tick | 1.361 | 1.417 |')
    expect(updated).not.toContain('Stale workload')
    expect(updated.split('\n').filter((line) => line.startsWith('|'))).toHaveLength(7)
    expect(execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' })).toContain(
      'README match reviewed data',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
