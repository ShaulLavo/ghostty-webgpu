export const benchmarkBackends = [
  'dom',
  'canvas2d',
  'canvas2d-pixels',
  'webgl2',
  'webgpu',
  'ghostty-web',
] as const

export type BenchmarkBackend = (typeof benchmarkBackends)[number]
export type BenchmarkScenario =
  | 'settled-idle'
  | 'cursor-movement'
  | 'burst-output'
  | 'sparse-edit'
  | 'sustained-scroll'
  | 'glyph-churn'
  | 'sparse-edit'
  | 'dense-redraw'
  | 'warm-unicode'
  | 'cold-cache'
  | 'resize-dpr'
  | 'cursor-blink'
  | 'hidden-output'
  | 'external'

export interface BenchmarkResult {
  diagnostics: unknown
  callbackMilliseconds: readonly number[]
  elapsedMilliseconds: number
  frameRequests: number
  metrics: Readonly<Record<string, number>>
  pendingFrames: number
  steps: number
  writeMilliseconds: readonly number[]
  writtenBytes: number
}

export interface RendererBenchmark {
  dispose(): Promise<void> | void
  getPageInfo(): unknown
  output(): string
  run(
    scenario: BenchmarkScenario,
    steps: number,
    idleMilliseconds: number,
  ): Promise<BenchmarkResult>
}

declare global {
  interface Window {
    __rendererBench: RendererBenchmark
    __rendererBenchFailure?: string
  }
}
