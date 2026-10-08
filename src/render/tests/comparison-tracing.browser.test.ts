import { expect, it, onTestFinished, vi } from 'vitest'
import { ComparisonTracing } from '../../../bench/comparison-tracing.js'
import type { RowInstanceUpdate } from '../instances/types.js'
import { WebGpuTerminalRenderer } from '../renderer.js'
import { WebGpuTextPass } from '../text-pass.js'
import { fittedFont } from '../canvas/tests/font.js'
import { TestClock } from '../webgl/tests/fixture.js'
import { createNativeTestState } from './native-state.js'

function counterTotal(
  counters: readonly { operation: string; value: number }[],
  operation: string,
): number {
  return counters
    .filter((counter) => counter.operation === operation)
    .reduce((sum, counter) => sum + counter.value, 0)
}

const uploadCases = [
  {
    name: 'full native frame',
    updates: [
      {
        row: 0,
        cell: { byteOffset: 0, byteLength: 1536 },
        glyph: { byteOffset: 0, byteLength: 2304 },
      },
    ],
    actualBytes: 3840,
    canonicalBytes: 3840,
  },
  {
    name: 'coalesced separated ranges',
    updates: [
      {
        row: 0,
        cell: { byteOffset: 256, byteLength: 64 },
        glyph: { byteOffset: 480, byteLength: 96 },
      },
      {
        row: 0,
        cell: { byteOffset: 64, byteLength: 64 },
        glyph: { byteOffset: 192, byteLength: 96 },
      },
    ],
    actualBytes: 640,
    canonicalBytes: 320,
  },
]

for (const { name, updates, actualBytes, canonicalBytes } of uploadCases) {
  it(`traces actual WebGPU upload bytes for ${name} and resets empty frames`, async (context) => {
    if (!navigator.gpu) {
      context.skip('WebGPU is unavailable in this browser')
      return
    }
    const oldUrl = location.href
    onTestFinished(() => history.replaceState(null, '', oldUrl))
    const tracedUrl = new URL(oldUrl)
    tracedUrl.searchParams.set('trace', '')
    history.replaceState(null, '', tracedUrl)
    const native = await createNativeTestState(12, 2)
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) {
      context.skip('No WebGPU adapter is available on this backend')
      return
    }
    const device = await adapter.requestDevice()
    device.pushErrorScope('validation')
    const renderer = await WebGpuTerminalRenderer.create({
      canvas: document.createElement('canvas'),
      columns: 12,
      rows: 2,
      font: fittedFont(),
      renderState: native.state,
      schedulerClock: new TestClock(),
      deviceFactory: async () => device,
    })
    try {
      const pass = Reflect.get(renderer, 'textPass')
      if (!(pass instanceof WebGpuTextPass))
        throw new TypeError('Expected the actual WebGPU text pass')
      const writes = vi.spyOn(device.queue, 'writeBuffer')
      const tracing = new ComparisonTracing()
      tracing.renderer(3, renderer)
      const data = { cellData: new Float32Array(24 * 16), glyphData: new Float32Array(24 * 24) }
      tracing.begin()
      expect(pass.uploadFrame(data, updates satisfies readonly RowInstanceUpdate[])).toBe(2)
      await device.queue.onSubmittedWorkDone()
      const trace = tracing.end()
      const actualWriteBytes = writes.mock.calls.reduce((sum, call) => sum + Number(call[4]), 0)
      expect(actualWriteBytes).toBe(actualBytes)
      expect(pass.frameUploadedBytes).toBe(actualBytes)
      expect(counterTotal(trace.counters, 'bufferBytes')).toBe(actualWriteBytes)
      expect(counterTotal(trace.counters, 'canonicalRangeBytes')).toBe(canonicalBytes)
      expect(counterTotal(trace.counters, 'buffersWritten')).toBe(writes.mock.calls.length)
      expect(trace.counters.every((counter) => counter.terminal === 3)).toBe(true)
      writes.mockClear()
      tracing.begin()
      expect(pass.uploadFrame(data, [])).toBe(0)
      const empty = tracing.end()
      expect(writes).not.toHaveBeenCalled()
      expect(pass.frameUploadedBytes).toBe(0)
      expect(counterTotal(empty.counters, 'bufferBytes')).toBe(0)
      expect(counterTotal(empty.counters, 'canonicalRangeBytes')).toBe(0)
      expect(counterTotal(empty.counters, 'buffersWritten')).toBe(0)
      expect(await device.popErrorScope()).toBeNull()
      writes.mockRestore()
    } finally {
      renderer.dispose()
      vi.restoreAllMocks()
    }
  })
}
