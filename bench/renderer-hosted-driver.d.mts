import type { BenchmarkBackend } from './renderer-benchmark-types.js'
export function createHostedDriver(options: {
  backend: BenchmarkBackend
  columns: number
  rows: number
  mount: HTMLElement
  worker: boolean
  doTrace: boolean
}): Promise<{
  adapter: unknown
  dispose(): Promise<void>
  metrics(): Readonly<Record<string, number>>
  output(): string
  scroll(delta: number): unknown
  write(data: string): unknown
  prepare(): Promise<void>
  diagnostics(): Promise<unknown>
}>
