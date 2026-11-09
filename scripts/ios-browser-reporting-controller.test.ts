import { expect, test } from 'vitest'
import { ReportingFixtureController } from './ios-browser-reporting-controller.ts'
import type { FrameworkEvent } from 'waffle/testing/page-runner/framework'

function state(bodies: string[] = [], messages: string[] = []) {
  return { bodies, messages, hooks: [], clocks: [], flush: null, errorTrace: null }
}
const signal = new AbortController().signal

test('final bytes do not close live decisions before both final-gate reads and the 60 ms hold', async () => {
  const fixture = new ReportingFixtureController('matrix')
  let current = state()
  let reads = 0
  fixture.arm({
    checkpoint: async () => {
      reads++
      return { kind: 'checkpoint', text: JSON.stringify(current) }
    },
    releaseOriginalRpc: async () => {},
  })
  const controls = fixture.run()
  const events: FrameworkEvent[] = [
    {
      kind: 'collected',
      tasks: [
        {
          id: 'suite',
          parentId: null,
          type: 'suite',
          file: 'fixture',
          fullName: 'suite',
          mode: 'run',
          timeoutMs: 15000,
          retries: 0,
        },
        {
          id: 'test',
          parentId: 'suite',
          type: 'test',
          file: 'fixture',
          fullName: 'case',
          mode: 'run',
          timeoutMs: 15000,
          retries: 0,
        },
      ],
    },
    { kind: 'task-started', id: 'suite' },
    { kind: 'task-started', id: 'test' },
    { kind: 'case-settled', updates: [] },
    { kind: 'execution-flushed' },
    { kind: 'tester-cleanup-settled' },
    { kind: 'cleanup-response-received' },
  ]
  for (const event of events) {
    if (event.kind === 'case-settled') current = state(['body'])
    if (event.kind === 'cleanup-response-received') current = state(['body'], ['response:cleanup'])
    const start = performance.now()
    const previous = reads
    expect(await fixture.collectorResponse({ event, status: 200, accepted: true }, signal)).toBe(
      'unchanged',
    )
    expect(reads - previous).toBe(2)
    expect(performance.now() - start).toBeGreaterThanOrEqual(55)
  }
  await controls
  expect(fixture.reads.filter((read) => read.gate === 'cleanup-response-received')).toHaveLength(2)
})

test('cancellation releases collector gates without releasing independent original RPC', async () => {
  const fixture = new ReportingFixtureController('flush')
  const abort = new AbortController()
  let releases = 0
  fixture.arm({
    checkpoint: async () => ({
      kind: 'checkpoint',
      text: JSON.stringify({
        ...state(),
        flush: { rpcHeld: true, bodyFinished: false, rpcReleased: false, calls: 1 },
      }),
    }),
    releaseOriginalRpc: async () => {
      releases++
    },
  })
  const answer = fixture.collectorResponse(
    { event: { kind: 'task-update', updates: [] }, status: 200, accepted: true },
    abort.signal,
  )
  await fixture.gates.get('task-update')?.reached.promise
  abort.abort()
  expect(await answer).toBe('unchanged')
  expect(releases).toBe(0)
  expect(fixture.gates.get('execution-flushed')?.status).toBe('cancelled')
  await expect(fixture.state()).rejects.toThrow('cancelled')
})

test('malformed delivery selects corruption without modifying actual collector acceptance', async () => {
  const fixture = new ReportingFixtureController('malformed')
  const observation = Object.freeze({
    event: { kind: 'task-update', updates: [] } as const,
    status: 200,
    accepted: true,
  })
  expect(await fixture.collectorResponse(observation, signal)).toBe('malformed-ack')
  expect(observation).toEqual({
    event: { kind: 'task-update', updates: [] },
    status: 200,
    accepted: true,
  })
})
