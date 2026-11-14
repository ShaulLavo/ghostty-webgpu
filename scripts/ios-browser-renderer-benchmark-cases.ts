import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const rendererBenchmarkFile = fileURLToPath(
  new URL('../bench/renderer-benchmark.browser.test.ts', import.meta.url),
)

export const rendererBenchmarkCases = [
  {
    file: rendererBenchmarkFile,
    fullName: 'benchmarks webgl2 with native frames and no idle work',
    sourceKey: 'bench/renderer-benchmark.browser.test.ts:14:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: rendererBenchmarkFile,
    fullName: 'benchmarks webgpu with native frames and no idle work',
    sourceKey: 'bench/renderer-benchmark.browser.test.ts:14:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: rendererBenchmarkFile,
    fullName: 'selects and paints canvas2d in the benchmark factory',
    sourceKey: 'bench/renderer-benchmark.browser.test.ts:73:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: rendererBenchmarkFile,
    fullName: 'selects and paints canvas2d-pixels in the benchmark factory',
    sourceKey: 'bench/renderer-benchmark.browser.test.ts:73:1',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
