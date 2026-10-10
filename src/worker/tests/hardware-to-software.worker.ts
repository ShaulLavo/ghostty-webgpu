import '../../../dist/worker/entry.js'

Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
Object.defineProperty(navigator, 'userAgentData', {
  configurable: true,
  value: { platform: 'macOS' },
})

const parameters = new URL(import.meta.url).searchParams
const channelName = parameters.get('channel')!
const channel = new BroadcastChannel(channelName)
const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu)
let requests = 0
let initialDevice: GPUDevice | undefined
navigator.gpu.requestAdapter = async (options) => {
  const request = ++requests
  channel.postMessage({ type: 'adapter', request })
  if (request > 1 && parameters.get('replacement') === 'missing') return null
  const adapter = await requestAdapter(options)
  if (!adapter) return null
  return {
    isFallbackAdapter: request > 1,
    info: { description: request > 1 ? 'SwiftShader' : 'Apple M1' },
    requestDevice: async () => {
      const device = await adapter.requestDevice()
      if (request === 1) initialDevice = device
      channel.postMessage({ type: 'device', request })
      return device
    },
  } as unknown as GPUAdapter
}
channel.onmessage = ({ data }) => {
  if (data === 'destroy') initialDevice?.destroy()
}
