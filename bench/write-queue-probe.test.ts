import { describe, expect, it } from 'vitest'
import { inspectQueueProbe, type QueueProbeResult } from './write-queue-probe.js'

function fixture(): QueueProbeResult {
  const samples = [0, 1, 2, 3].map((index) => ({
    elapsedMs: index * 4,
    sent: index * 4,
    parsed: index,
    acknowledged: index,
    rejected: 0,
    pendingBytes: index * 2 * 1024,
    pendingBeforeBytes: index * 2 * 1024,
    submitted: index,
  }))
  return {
    chunkBytes: 1024,
    maxBytes: 8192,
    byteLimit: 16384,
    durationMs: 750,
    intervalMs: 4,
    writesPerTick: 4,
    samples,
    pendingPeak: 8192,
    final: {
      elapsedMs: 50,
      sent: 12,
      parsed: 12,
      acknowledged: 12,
      rejected: 0,
      pendingBytes: 0,
      pendingBeforeBytes: 0,
      submitted: 4,
    },
    stopMs: 16,
    drainMs: 34,
    inputAckMs: [4],
    heartbeatDelayMs: [2],
    errors: [],
  }
}

describe('bounded write queue evidence', () => {
  it('requires backlog growth across producer tasks with actual parsed work', () => {
    expect(inspectQueueProbe(fixture())).toMatchObject({ issues: [], backlogObserved: true })
    expect(
      inspectQueueProbe({ ...fixture(), samples: fixture().samples.slice(-1) }).backlogObserved,
    ).toBe(false)
    expect(
      inspectQueueProbe({
        ...fixture(),
        samples: fixture().samples.map((sample) => ({ ...sample, parsed: 0 })),
      }).backlogObserved,
    ).toBe(false)
  })

  it('does not turn a historical unloaded run into overload evidence', () => {
    const result = fixture()
    expect(
      inspectQueueProbe({
        ...result,
        samples: result.samples.map((sample) => ({
          ...sample,
          pendingBytes: 1024,
          pendingBeforeBytes: 0,
        })),
      }).backlogObserved,
    ).toBe(false)
  })

  it.each([
    ['Queue did not drain', { pendingBytes: 1 }],
    ['Unsettled write promises', { acknowledged: 11 }],
    ['Parse receipts differ from acknowledgements', { parsed: 11 }],
    ['No actual GPU queue submission', { submitted: 0 }],
  ])('rejects %s', (issue, final) => {
    const result = fixture()
    expect(inspectQueueProbe({ ...result, final: { ...result.final, ...final } }).issues).toContain(
      issue,
    )
  })

  it('rejects repeated enqueue bursts that fully drain before the next producer task', () => {
    const result = fixture()
    const pending = [4096, 3072, 4096, 3072, 4096]
    const samples = pending.map((pendingBytes, index) => ({
      elapsedMs: index * 4,
      sent: (index + 1) * 4,
      parsed: (index + 1) * 4 - pendingBytes / 1024,
      acknowledged: (index + 1) * 4 - pendingBytes / 1024,
      rejected: 0,
      pendingBytes,
      pendingBeforeBytes: 0,
      submitted: index,
    }))
    expect(inspectQueueProbe({ ...result, samples }).backlogObserved).toBe(false)
  })

  it('recognizes a persistent capped backlog after its initial growth', () => {
    const result = fixture()
    const samples = result.samples.map((sample, index) => ({
      ...sample,
      pendingBeforeBytes: index === 0 ? 0 : 4096,
    }))
    expect(inspectQueueProbe({ ...result, samples }).backlogObserved).toBe(true)
  })

  it('rejects bound violations and missing responsiveness controls', () => {
    const result = fixture()
    const invalid = {
      ...result,
      byteLimit: 1,
      pendingPeak: 8193,
      inputAckMs: [],
      heartbeatDelayMs: [],
    }
    expect(inspectQueueProbe(invalid).issues).toEqual([
      'Offered byte bound exceeded',
      'Queue byte limit exceeded',
      'No input acknowledgement',
      'No event-loop heartbeat',
    ])
  })
})
