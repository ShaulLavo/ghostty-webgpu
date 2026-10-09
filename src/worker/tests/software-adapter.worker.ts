import '../../../dist/worker/entry.js'

const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu)
navigator.gpu.requestAdapter = async (options) => {
  const adapter = await requestAdapter(options)
  if (!adapter) return null
  return {
    isFallbackAdapter: true,
    info: { description: 'SwiftShader' },
    requestDevice: adapter.requestDevice.bind(adapter),
  } as unknown as GPUAdapter
}
