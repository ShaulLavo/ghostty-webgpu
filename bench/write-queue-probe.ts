export interface QueueProbeSample {
  readonly elapsedMs: number
  readonly sent: number
  readonly parsed: number
  readonly acknowledged: number
  readonly rejected: number
  readonly pendingBytes: number
  readonly pendingBeforeBytes: number
  readonly submitted: number
}

export interface QueueProbeResult {
  readonly chunkBytes: number
  readonly maxBytes: number
  readonly byteLimit: number
  readonly durationMs: number
  readonly intervalMs: number
  readonly writesPerTick: number
  readonly samples: readonly QueueProbeSample[]
  readonly pendingPeak: number
  readonly final: QueueProbeSample
  readonly stopMs: number
  readonly drainMs: number
  readonly inputAckMs: readonly number[]
  readonly heartbeatDelayMs: readonly number[]
  readonly errors: readonly string[]
}

export function inspectQueueProbe(result: QueueProbeResult) {
  const issues = result.errors.slice()
  const end = result.final
  if (end.pendingBytes !== 0) issues.push('Queue did not drain')
  if (end.sent !== end.acknowledged + end.rejected) issues.push('Unsettled write promises')
  if (end.parsed !== end.acknowledged) issues.push('Parse receipts differ from acknowledgements')
  if (end.sent * result.chunkBytes > result.byteLimit) issues.push('Offered byte bound exceeded')
  if (result.pendingPeak > result.maxBytes) issues.push('Queue byte limit exceeded')
  if (end.submitted === 0) issues.push('No actual GPU queue submission')
  if (result.inputAckMs.length === 0) issues.push('No input acknowledgement')
  if (result.heartbeatDelayMs.length === 0) issues.push('No event-loop heartbeat')
  // Separate producer tasks must observe growth, not just one synchronous enqueue burst.
  const growth = result.samples.filter((sample, index, samples) => {
    const previous = samples[index - 1]
    return (
      previous &&
      sample.pendingBeforeBytes > previous.pendingBeforeBytes &&
      sample.pendingBeforeBytes > result.chunkBytes &&
      sample.parsed > 0
    )
  })
  const residual = result.samples.filter((sample) => sample.pendingBeforeBytes > result.chunkBytes)
  const residualPeak = result.samples.reduce(
    (peak, sample) => Math.max(peak, sample.pendingBeforeBytes),
    0,
  )
  return {
    issues,
    backlogObserved: growth.length > 0 && residual.length >= 2,
    growthSamples: growth.length,
    residualSamples: residual.length,
    residualPeak,
  }
}
