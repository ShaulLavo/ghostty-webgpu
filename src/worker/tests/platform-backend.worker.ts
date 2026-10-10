import { rendererPlatforms } from '../../render/tests/platforms.js'
import { TerminalWorkerRuntime } from '../../../dist/worker/runtime.js'
import type { WorkerInitialize } from '../protocol.js'

const parameters = new URL(import.meta.url).searchParams
const platform = rendererPlatforms.find((value) => value.name === parameters.get('platform'))!
for (const key of ['platform', 'userAgent', 'userAgentData'] as const) {
  Object.defineProperty(navigator, key, { configurable: true, value: platform.navigator[key] })
}

const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu)
navigator.gpu.requestAdapter = async (options) => {
  const adapter = await requestAdapter(options)
  if (!adapter) return null
  return {
    isFallbackAdapter: false,
    info: { description: 'Test hardware adapter' },
    requestDevice: adapter.requestDevice.bind(adapter),
  } as unknown as GPUAdapter
}

if (parameters.has('unavailableWebGl')) {
  const getContext = OffscreenCanvas.prototype.getContext
  OffscreenCanvas.prototype.getContext = function (
    this: OffscreenCanvas,
    contextId: string,
    attributes?: unknown,
  ) {
    if (contextId === 'webgl2') return null
    return Reflect.apply(getContext, this, [contextId, attributes])
  } as typeof getContext
}

if (parameters.has('allocationFailure')) {
  const allocation = parameters.get('allocationFailure')!
  Object.defineProperty(WebGL2RenderingContext.prototype, allocation, {
    configurable: true,
    value: () => null,
  })
}

if (parameters.has('shaderFailure')) {
  WebGL2RenderingContext.prototype.getShaderParameter = () => false
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerInitialize>) => void) | null
}
scope.onmessage = ({ data }) => {
  scope.onmessage = null
  void new TerminalWorkerRuntime(data).start()
}
