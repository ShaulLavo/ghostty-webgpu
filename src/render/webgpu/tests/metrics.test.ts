import { describe, expect, it, vi } from 'vitest'
import { WebGpuTerminalRenderer } from '../renderer.js'

describe('WebGpuTerminalRenderer metrics deferral', () => {
  it('defers shared-atlas metrics reads until renderer.metrics is accessed', () => {
    const sharedAtlas = {
      metrics: vi.fn(() => ({ cacheHits: 4, cacheMisses: 2, evictions: 1, pages: 3 })),
    }
    const renderer = Object.create(WebGpuTerminalRenderer.prototype) as {
      disposed: boolean
      sharedAtlas: typeof sharedAtlas
      previousAtlasMetrics: { cacheHits: number; cacheMisses: number; evictions: number }
      atlasUploadedBytesValue: number
      atlasUploadOperationsValue: number
      textPass: { drawCount: number; frameUploadedBytes: number }
      metricsValue: WebGpuTerminalRenderer['metrics']
      readonly metrics: WebGpuTerminalRenderer['metrics']
      recordFrame(rebuiltRows: number, instanceUploadOperations: number): void
    }
    renderer.disposed = false
    renderer.sharedAtlas = sharedAtlas
    renderer.previousAtlasMetrics = { cacheHits: 10, cacheMisses: 5, evictions: 2 }
    renderer.atlasUploadedBytesValue = 256
    renderer.atlasUploadOperationsValue = 2
    renderer.textPass = { drawCount: 2, frameUploadedBytes: 512 }
    renderer.metricsValue = {
      zigFrames: 0,
      atlasCacheHits: 0,
      atlasCacheMisses: 0,
      atlasEvictions: 0,
      atlasPages: 0,
      atlasUploadedBytes: 0,
      atlasUploadOperations: 0,
      deviceRestores: 0,
      draws: 0,
      instanceUploadOperations: 0,
      rebuiltRows: 0,
      submittedFrames: 0,
      uploadedBytes: 0,
    }

    renderer.recordFrame(1, 1)
    expect(sharedAtlas.metrics).not.toHaveBeenCalled()

    const metrics = renderer.metrics
    expect(sharedAtlas.metrics).toHaveBeenCalledTimes(1)
    expect(metrics).toMatchObject({
      atlasCacheHits: 14,
      atlasCacheMisses: 7,
      atlasEvictions: 3,
      atlasPages: 3,
      atlasUploadedBytes: 256,
      atlasUploadOperations: 2,
      draws: 2,
      instanceUploadOperations: 1,
      rebuiltRows: 1,
      submittedFrames: 1,
      uploadedBytes: 512,
    })

    // Disposed renderers retain their last synced counts without touching a detached atlas.
    renderer.disposed = true
    expect(renderer.metrics.atlasPages).toBe(3)
    expect(sharedAtlas.metrics).toHaveBeenCalledTimes(1)
  })
})
