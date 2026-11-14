import { afterEach, expect, it, vi } from 'vitest'
import { requireWebGpu } from './webgpu-capability.js'

afterEach(() => vi.unstubAllGlobals())

it('excludes a required GPU case only when the WebGPU API is absent', () => {
  vi.stubGlobal('navigator', {})
  const skip = (reason?: string): never => {
    throw new Error(reason)
  }
  expect(() => requireWebGpu({ skip })).toThrow('This browser does not expose the WebGPU API')
})

it('leaves adapter and device acquisition to the test when WebGPU exists', () => {
  const requestAdapter = vi.fn().mockRejectedValue(new Error('Adapter failed'))
  vi.stubGlobal('navigator', { gpu: { requestAdapter } })
  const skip = (reason?: string): never => {
    throw new Error(reason)
  }
  expect(() => requireWebGpu({ skip })).not.toThrow()
  expect(requestAdapter).not.toHaveBeenCalled()
})
