import { TerminalWorkerRuntime } from '../src/worker/runtime.ts'
import {
  tracing,
  attachNative,
  attachRenderer,
  snapshot,
  startup,
} from './renderer-diagnostics.mjs'

self.onmessage = ({ data }) => {
  self.onmessage = null
  const runtime = new TerminalWorkerRuntime(data)
  const port = data.l7aPort
  const originalOpen = runtime.open
  runtime.open = async function (...args) {
    const session = this.execution.session
    try {
      if (tracing.enabled) attachNative(0, session.runtime, session.terminal, session.renderState)
    } catch (cause) {
      console.error('L7a attach native error', String(cause), cause.stack)
      throw cause
    }
    let result
    try {
      result = await originalOpen.apply(this, args)
    } catch (cause) {
      console.error('L7a worker open error', String(cause), cause.stack)
      throw cause
    }
    if (tracing.enabled) attachRenderer(0, this.execution.rendererValue)
    return result
  }
  let before = {}
  port.onmessage = ({ data: command }) => {
    if (command === 'echo') {
      tracing.mark('echo-received')
      port.postMessage({ marked: true })
      return
    }
    if (command === 'begin') {
      before = { ...runtime.execution.rendererValue.metrics }
      if (tracing.enabled) tracing.begin()
      port.postMessage({ ready: true })
      return
    }
    const renderer = runtime.execution.rendererValue
    const session = runtime.execution.session
    if (command === 'lose') {
      port.postMessage(loseRenderer(renderer))
      return
    }
    const trace = tracing.enabled && command === 'end' ? tracing.end() : null
    port.postMessage({
      trace,
      startup,
      snapshot: snapshot(session.runtime, renderer),
      adapter: renderer.device
        ? {
            vendor: renderer.device.adapterInfo.vendor,
            architecture: renderer.device.adapterInfo.architecture,
            description: renderer.device.adapterInfo.description,
            fallback: renderer.device.adapterInfo.isFallbackAdapter,
          }
        : null,
      metrics: Object.fromEntries(
        Object.entries(renderer.metrics).map(([key, value]) => [key, value - (before[key] ?? 0)]),
      ),
    })
  }
  port.start()
  void runtime.start()
}

function loseRenderer(renderer) {
  if (renderer.backend === 'webgpu') {
    renderer.device.destroy()
    return { triggered: 'worker GPUDevice.destroy' }
  }
  const extension = renderer.state.pass.context.getExtension('WEBGL_lose_context')
  if (!extension) throw new Error('WEBGL_lose_context unavailable')
  extension.loseContext()
  setTimeout(() => extension.restoreContext(), 100)
  return { triggered: 'worker WEBGL_lose_context', restoreDelayMilliseconds: 100 }
}
