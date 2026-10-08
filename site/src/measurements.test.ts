import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import snapshot from '../../docs/benchmarks/mac-m1-2026-10-08/scores.json'
import { measurementRows, measurements } from './measurements'

test('uses all nine reviewed scores, including the losing workloads', () => {
  expect(measurements).toHaveLength(9)
  expect(measurements).toEqual(measurementRows(snapshot.scores))
  expect(measurements).toContainEqual({
    renderer: 'WebGL',
    workload: 'One Unicode line per tick',
    energy: '1.320',
    instructions: '1.348',
  })
  expect(measurements).toContainEqual({
    renderer: 'DOM',
    workload: 'Typing-like edits',
    energy: '1.147',
    instructions: '1.151',
  })
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
      energy: '2.000',
      instructions: '3.000',
    },
  ])
})
