import '../../../dist/worker/entry.js'

Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
Object.defineProperty(navigator, 'userAgentData', {
  configurable: true,
  value: { platform: 'macOS' },
})

const channelName = new URL(import.meta.url).searchParams.get('channel')
const channel = channelName ? new BroadcastChannel(channelName) : undefined
const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu)
navigator.gpu.requestAdapter = async (options) => {
  channel?.postMessage('adapter')
  const adapter = await requestAdapter(options)
  if (!adapter) return null
  return {
    isFallbackAdapter: true,
    info: { description: 'SwiftShader' },
    requestDevice: async () => {
      channel?.postMessage('device')
      return adapter.requestDevice()
    },
  } as unknown as GPUAdapter
}
