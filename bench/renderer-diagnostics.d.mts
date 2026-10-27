import type { ComparisonTracing } from './comparison-tracing.js'
import type { GhosttyRuntime } from '../src/core/runtime.js'
import type { GhosttyTerminal } from '../src/core/terminal.js'
import type { GhosttyRenderState } from '../src/core/render-state.js'
import type { createBenchmarkRenderer } from './renderer-factory.js'
type Renderer = Awaited<ReturnType<typeof createBenchmarkRenderer>>['renderer']
export const tracing: ComparisonTracing
export const startup: readonly unknown[]
export function attachNative(
  id: number,
  runtime: GhosttyRuntime,
  core: GhosttyTerminal,
  state: GhosttyRenderState,
): void
export function attachRenderer(id: number, renderer: Renderer): void
export function snapshot(runtime: GhosttyRuntime, renderer: Renderer): unknown
export function completion(renderer: Renderer): Promise<unknown>
