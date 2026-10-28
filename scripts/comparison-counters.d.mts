export interface CounterProcess {
  id: number
  type: string
  cpuTime: number
}

export type CounterReader =
  | {
      skipped: true
      reason: string
      snapshot?: undefined
      close?: undefined
    }
  | {
      skipped?: false
      reason?: string
      snapshot(processes: readonly CounterProcess[]): Promise<unknown>
      close(): Promise<void>
    }

export function createCounterReader(
  session: { send(method: string): Promise<unknown> },
  options?: { platform?: string; timeoutMilliseconds?: number },
): Promise<CounterReader>
