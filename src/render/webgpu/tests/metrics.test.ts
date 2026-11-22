import { describe, expect, it, vi } from 'vitest'
import { WebGpuTerminalRenderer } from '../renderer.js'

describe('WebGpuTerminalRenderer metrics deferral', () => {
  it('defers shared-atlas metrics reads even when a caller holds renderer.metrics across frames', () => {
    let atlasState = { cacheHits: 4, cacheMisses: 2, evictions: 1, pages: 3 }
    const sharedAtlas = {
      metrics: vi.fn(() => atlasState),
    }
    const renderer = Object.create(WebGpuTerminalRenderer.prototype) as {
      disposed: boolean
      sharedAtlas: typeof sharedAtlas
      previousAtlasMetrics: { cacheHits: number; cacheMisses: number; evictions: number }
      atlasMetricsSnapshot: {
        cacheHits: number
        cacheMisses: number
        evictions: number
        pages: number
      }
      atlasUploadedBytesValue: number
      atlasUploadOperationsValue: number
      textPass: { drawCount: number; frameUploadedBytes: number }
      metricsValue: WebGpuTerminalRenderer['metrics']
      readonly metrics: WebGpuTerminalRenderer['metrics']
      createMetricsObject(): WebGpuTerminalRenderer['metrics']
      recordFrame(rebuiltRows: number, instanceUploadOperations: number): void
    }
    renderer.disposed = false
    renderer.sharedAtlas = sharedAtlas
    renderer.previousAtlasMetrics = { cacheHits: 10, cacheMisses: 5, evictions: 2 }
    renderer.atlasMetricsSnapshot = { cacheHits: 0, cacheMisses: 0, evictions: 0, pages: 0 }
    renderer.atlasUploadedBytesValue = 256
    renderer.atlasUploadOperationsValue = 2
    renderer.textPass = { drawCount: 2, frameUploadedBytes: 512 }
    renderer.metricsValue = renderer.createMetricsObject()

    // Holding a reference to renderer.metrics before drawing must not scan on recordFrame().
    const held = renderer.metrics
    renderer.recordFrame(1, 1)
    expect(sharedAtlas.metrics).not.toHaveBeenCalled()
    expect(held.submittedFrames).toBe(1)
    expect(sharedAtlas.metrics).not.toHaveBeenCalled()

    expect(held.atlasPages).toBe(3)
    expect(sharedAtlas.metrics).toHaveBeenCalledTimes(1)

    // Subsequent atlas changes stay visible through the held reference.
    atlasState = { cacheHits: 9, cacheMisses: 3, evictions: 2, pages: 4 }
    renderer.recordFrame(1, 1)
    expect(sharedAtlas.metrics).toHaveBeenCalledTimes(1)
    expect(held).toMatchObject({
      atlasCacheHits: 19,
      atlasCacheMisses: 8,
      atlasEvictions: 4,
      atlasPages: 4,
      submittedFrames: 2,
    })

    // The four atlas counters remain writable in strict mode and resync on the next submitted frame.
    held.atlasCacheHits = 0
    held.atlasCacheMisses = 0
    held.atlasEvictions = 0
    held.atlasPages = 0
    expect(held.atlasCacheHits).toBe(0)
    expect(held.atlasPages).toBe(0)
    renderer.recordFrame(1, 1)
    expect(held.atlasPages).toBe(4)

    // Disposed renderers retain their last synced counts without touching a detached atlas.
    const callsBeforeDispose = sharedAtlas.metrics.mock.calls.length
    renderer.disposed = true
    expect(held.atlasPages).toBe(4)
    expect(sharedAtlas.metrics).toHaveBeenCalledTimes(callsBeforeDispose)
  })
})
