export const queueProbeInputCount = 4

export class QueueProbeInputs {
  private readonly keyTimes: number[] = []
  readonly acknowledgementMs: number[] = []
  settled = 0
  recorded = 0

  keydown(at: number): void {
    this.keyTimes.push(at)
    this.recorded += 1
  }

  async acknowledge(now: () => number, echo: () => unknown): Promise<void> {
    const at = this.keyTimes.shift()
    if (at === undefined) throw new Error('Input callback has no matching keydown')
    try {
      await echo()
      this.acknowledgementMs.push(now() - at)
    } finally {
      this.settled += 1
    }
  }
}
