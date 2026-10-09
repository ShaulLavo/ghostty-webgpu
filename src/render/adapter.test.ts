import { describe, expect, it } from 'vitest'
import { isSoftwareWebGpuAdapter } from './adapter.js'

describe('automatic WebGPU adapter eligibility', () => {
  it.each([
    { isFallbackAdapter: true, info: {} },
    { info: { isFallbackAdapter: true } },
    { info: { description: 'Google SwiftShader' } },
    { info: { architecture: 'llvmpipe' } },
    { info: { device: 'softpipe' } },
    { info: { description: 'lavapipe' } },
    { info: { description: 'Microsoft Basic Render Driver' } },
    { info: { architecture: 'WARP' } },
  ])('identifies software adapters (%j)', (adapter) => {
    expect(isSoftwareWebGpuAdapter(adapter)).toBe(true)
  })

  it.each([
    { info: {} },
    { info: { description: 'Software Vulkan implementation' } },
    { info: { vendor: 'Example Software', description: 'Hardware GPU' } },
    { isFallbackAdapter: false, info: { isFallbackAdapter: false } },
    { info: { vendor: 'apple', architecture: 'metal', description: 'Apple M1' } },
    { info: { vendor: 'nvidia', description: 'NVIDIA GeForce RTX 3070, Vulkan' } },
    { info: { vendor: 'intel', description: 'Intel Iris Xe Graphics' } },
    { info: { vendor: 'amd', description: 'AMD Radeon RX 6800 XT' } },
  ])('keeps hardware and unidentified adapters eligible (%j)', (adapter) => {
    expect(isSoftwareWebGpuAdapter(adapter)).toBe(false)
  })
})
