import { expect, test } from 'vitest'
import { measurementRows, measurements, SHOW_MEASUREMENTS } from './measurements'

const metrics = ['parse/ascii', 'parse/logs', 'idle/cpu', 'memory/10k', 'write/p50', 'input/p95']
const sample = metrics.flatMap((metric) =>
  ['ghostty-webgpu', 'xterm-webgl'].map((variant) => ({
    variant,
    path: 'bytes',
    count: 1,
    metric,
    unit: 'ms',
    median: variant === 'ghostty-webgpu' ? 9 : 3,
  })),
)

test('publishes a placeholder while all six comparison rows remain available', () => {
  expect(SHOW_MEASUREMENTS).toBe(false)
  expect(measurements).toHaveLength(6)
  expect(measurements.map((row) => row.label)).toEqual(
    measurementRows(sample).map((row) => row.label),
  )
})

test('selects one-terminal byte measurements and keeps losing rows', () => {
  const distractor = { ...sample[0]!, path: 'string', median: 100 }
  const manyTerminals = { ...sample[0]!, count: 17, median: 200 }
  const rows = measurementRows([distractor, manyTerminals, ...sample])
  expect(rows).toHaveLength(6)
  expect(rows[0]).toMatchObject({ ghostty: '9.00 ms', xterm: '3.00 ms' })
  expect(rows[4]).toMatchObject({ ghostty: '9.00 ms', xterm: '3.00 ms' })
  expect(rows[5]).toMatchObject({ ghostty: '9.00 ms', xterm: '3.00 ms' })
})

test('requires complete, finite measurements before publishing', () => {
  expect(() => measurementRows([])).toThrow('Missing measurement')
  expect(() => measurementRows([{ ...sample[0]!, median: NaN }, ...sample.slice(1)])).toThrow(
    'Missing measurement',
  )
})
