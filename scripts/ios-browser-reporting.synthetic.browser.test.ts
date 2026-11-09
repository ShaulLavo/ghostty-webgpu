import { afterEach, aroundEach, beforeEach, describe, expect, test } from 'vitest'
import { reportingSyntheticCases } from './ios-browser-reporting-cases.ts'
import { reportingSyntheticNames } from './ios-browser-reporting-manifest.ts'

function trace(): string[] {
  const value: unknown = Reflect.get(globalThis, '__reportingHooks')
  if (!Array.isArray(value)) throw new Error('Missing installed hook observer')
  return value
}
beforeEach((context) => {
  const start = performance.now()
  trace().push('beforeEach')
  recordClock('beforeEach', context.task.name, start, context.task.timeout)
})
afterEach((context) => {
  const start = performance.now()
  trace().push('afterEach')
  recordClock('afterEach', context.task.name, start, context.task.timeout)
})
aroundEach(async (runTest, context) => {
  const start = performance.now()
  trace().push('aroundEach:before')
  await runTest()
  trace().push('aroundEach:after')
  recordClock('aroundEach', context.task.name, start, context.task.timeout)
})
async function body(row: (typeof reportingSyntheticCases)[number]): Promise<void> {
  const bodies: unknown = Reflect.get(globalThis, '__reportingBodies')
  if (!Array.isArray(bodies)) throw new Error('Missing installed body observer')
  bodies.push(row.name)
  expect(reportingSyntheticCases.map((row) => row.name)).toEqual(reportingSyntheticNames)
  const start = performance.now()
  try {
    await row.run()
  } finally {
    recordClock('body', row.name, start, 15000)
  }
}
function recordClock(kind: string, name: string, start: number, taskTimeout: number): void {
  const values: unknown = Reflect.get(globalThis, '__reportingClocks')
  const worker: unknown = Reflect.get(globalThis, '__vitest_worker__')
  if (
    !Array.isArray(values) ||
    !worker ||
    typeof worker !== 'object' ||
    !('config' in worker) ||
    !worker.config ||
    typeof worker.config !== 'object' ||
    !('hookTimeout' in worker.config)
  )
    throw new Error('Missing actual clock observer')
  const end = performance.now()
  values.push({
    kind,
    name,
    start,
    end,
    elapsed: end - start,
    taskTimeout,
    hookTimeout: worker.config.hookTimeout,
  })
}
for (const row of reportingSyntheticCases) {
  if ('group' in row) continue
  test(row.name, () => body(row), 15000)
}
describe('nested', () => {
  for (const row of reportingSyntheticCases) {
    if (!('group' in row) || row.group !== 'nested') continue
    test(row.name, () => body(row), 15000)
  }
})
describe.concurrent('concurrent', () => {
  for (const row of reportingSyntheticCases) {
    if (!('group' in row) || row.group !== 'concurrent') continue
    test(row.name, () => body(row), 15000)
  }
})
