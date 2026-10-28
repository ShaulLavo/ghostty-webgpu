import { Terminal as MainTerminal } from '../../src/dom/terminal.ts'
import { Terminal as WorkerTerminal } from '../../src/worker/index.ts'
import { createBenchmarkRenderer } from '../../bench/renderer-factory.ts'
import { ComparisonTracing } from '../../bench/comparison-tracing.ts'

const parameters = new URL(location.href).searchParams
const backend = parameters.get('backend') ?? 'webgpu'
const worker = parameters.has('worker')
const adaptive = parameters.has('adaptive')
const tracing = new ComparisonTracing()
const channels = []
const RealWorker = window.Worker
window.Worker = class extends RealWorker {
  postMessage(message, transfer) {
    if (message.type !== 'initialize') return super.postMessage(message, transfer)
    const channel = new MessageChannel()
    channels.push(channel.port1)
    super.postMessage(
      { ...message, c5Port: channel.port2 },
      (transfer ?? []).concat([channel.port2]),
    )
  }
}

function request(port, command) {
  return new Promise((resolve, reject) => {
    port.onmessage = ({ data }) => {
      if (!data.c5Error) {
        resolve(data)
        return
      }
      globalThis.__c5StartupError = data.c5Error
      reject(new Error(data.c5Error.message))
    }
    port.postMessage(command)
  })
}

function attachNative(runtime, core, state) {
  if (!tracing.enabled) return
  tracing.native(0, core, state)
}

function attachRenderer(renderer) {
  if (!tracing.enabled) return
  if (renderer.backend === 'webgpu') tracing.renderer(0, renderer)
  else tracing.nativeRenderer(0, renderer)
}

function adapterInfo(renderer) {
  if (renderer.backend === 'webgpu') {
    const info = renderer.device.adapterInfo
    return {
      vendor: info.vendor,
      architecture: info.architecture,
      description: info.description,
      fallback: info.isFallbackAdapter,
    }
  }
  const gl = renderer.state.pass.context
  const extension = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    vendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL),
    description: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL),
    fallback: false,
  }
}

const options = {
  autoFit: false,
  accessibility: false,
  appearance: {
    grid: { columns: 80, rows: 24 },
    font: { family: 'Bench Mono', size: 13 },
    cursor: { blink: false },
  },
  presentation: adaptive ? 'adaptive' : undefined,
}
let terminal
let renderer
let runtime
let core
let state
globalThis.__c5Stage = 'creating'
if (worker) {
  try {
    terminal = await WorkerTerminal.create({
      ...options,
      backend: backend === 'webgl2' ? 'webgl' : 'webgpu',
      assets: { wasm: '/ghostty-vt.wasm', bridge: '/bridge.wasm' },
      workerUrl: `/c5-worker.js?source=${parameters.get('source')}${tracing.enabled ? '&trace' : ''}`,
      fonts: [{ family: 'Bench Mono', source: { url: '/font.woff2' } }],
    })
  } catch (error) {
    globalThis.__c5StartupError = {
      message: String(error),
      stack: error?.stack,
      code: error?.code,
      operation: error?.operation,
      internal: error?.internal,
    }
    throw error
  }
} else {
  const face = await new FontFace('Bench Mono', 'url(/font.woff2)').load()
  document.fonts.add(face)
  terminal = await MainTerminal.create({
    ...options,
    runtime: { kind: 'owned', options: { wasm: '/ghostty-vt.wasm', bridge: '/bridge.wasm' } },
    rendererFactory: async (input) => {
      const session = terminal.execution.session
      runtime = session.runtime
      core = session.terminal
      state = session.renderState
      attachNative(runtime, core, state)
      const result = await createBenchmarkRenderer(backend, input)
      renderer = result.renderer
      attachRenderer(renderer)
      return renderer
    },
  })
}
const port = worker ? channels.at(-1) : null
port?.addEventListener('message', ({ data }) => {
  if (data.c5OpenError) globalThis.__c5WorkerOpenError = data.c5OpenError
})
port?.start()
terminal.on('error', ({ cause }) => {
  window.__rendererBenchFailure = String(cause)
})
globalThis.__c5Stage = 'created'
const host = document.createElement('div')
host.style.cssText = 'width:900px;height:500px;position:relative'
document.querySelector('main').append(host)
try {
  await terminal.open(host)
} catch (error) {
  globalThis.__c5StartupError = {
    message: String(error),
    stack: error?.stack,
    code: error?.code,
    operation: error?.operation,
    internal: error?.internal,
  }
  throw error
}
globalThis.__c5Stage = 'opened'
const info = port ? await request(port, 'info') : { adapter: adapterInfo(renderer) }
globalThis.__c5Stage = 'ready'

globalThis.__c5 = {
  terminal,
  info: () => ({
    ...info,
    backend,
    worker,
    adaptive,
    dpr: devicePixelRatio,
    visibility: document.visibilityState,
  }),
  metrics: async () => (port ? (await request(port, 'info')).metrics : { ...renderer.metrics }),
  begin: async () => {
    if (port) await request(port, 'begin')
    else tracing.begin()
  },
  end: async () => (port ? (await request(port, 'end')).trace : tracing.end()),
  markEcho: async () => {
    if (port) await request(port, 'echo')
    else tracing.mark('echo-received')
  },
}
globalThis.__compare = {
  traceBegin: () => globalThis.__c5.begin(),
  traceEnd: () => globalThis.__c5.end(),
}
globalThis.__rendererBench = { getPageInfo: () => globalThis.__c5.info() }
terminal.focus()
