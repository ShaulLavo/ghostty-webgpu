import { TerminalWorkerRuntime } from '../../src/worker/runtime.ts'
import { ComparisonTracing } from '../../bench/comparison-tracing.ts'

const tracing = new ComparisonTracing()

self.onmessage = ({ data }) => {
  self.onmessage = null
  try {
    initialize(data)
  } catch (error) {
    console.error('C5 worker initialization', error?.stack ?? String(error))
    throw error
  }
}

function initialize(data) {
  const runtime = new TerminalWorkerRuntime(data)
  const port = data.c5Port
  const originalOpen = runtime.open
  runtime.open = async function (...args) {
    try {
      const result = await originalOpen.apply(this, args)
      const session = this.execution.session
      const renderer = this.execution.rendererValue
      if (tracing.enabled) {
        tracing.native(0, session.terminal, session.renderState)
        if (renderer.backend === 'webgpu') tracing.renderer(0, renderer)
        else tracing.nativeRenderer(0, renderer)
      }
      return result
    } catch (error) {
      port.postMessage({
        c5OpenError: { message: String(error), stack: error?.stack },
      })
      throw error
    }
  }
  port.onmessage = ({ data: command }) => {
    try {
      handle(port, runtime, command)
    } catch (error) {
      const evidence = { message: String(error), stack: error?.stack }
      console.error(`C5 worker ${command}`, evidence.stack ?? evidence.message)
      port.postMessage({ c5Error: evidence })
    }
  }
  port.start()
  void runtime.start()
}

function handle(port, runtime, command) {
  const renderer = runtime.execution.rendererValue
  if (command === 'echo') {
    tracing.mark('echo-received')
    port.postMessage({ marked: true })
    return
  }
  if (command === 'begin') {
    tracing.begin()
    port.postMessage({ ready: true })
    return
  }
  if (command === 'end') {
    port.postMessage({ trace: tracing.end() })
    return
  }
  const info = renderer.device?.adapterInfo
  port.postMessage({
    metrics: { ...renderer.metrics },
    adapter: info
      ? {
          vendor: info.vendor,
          architecture: info.architecture,
          description: info.description,
          fallback: info.isFallbackAdapter,
        }
      : webglAdapter(renderer),
  })
}

function webglAdapter(renderer) {
  const gl = renderer.state.pass.context
  const extension = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    vendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL),
    description: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL),
    fallback: false,
  }
}
