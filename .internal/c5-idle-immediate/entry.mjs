import { Terminal as MainTerminal } from '../../src/dom/terminal.ts'
import { Terminal as WorkerTerminal } from '../../src/worker/index.ts'
import { Terminal as XtermTerminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'
import { createBenchmarkRenderer } from '../../bench/renderer-factory.ts'
import { ComparisonTracing } from '../../bench/comparison-tracing.ts'

const parameters = new URL(location.href).searchParams
const backend = parameters.get('backend') ?? 'webgpu'
const worker = parameters.has('worker')
const xterm = parameters.has('xterm')
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
  return webglInfo(gl)
}

function xtermAdapterInfo(addon) {
  return webglInfo(addon._renderer._gl)
}

function webglInfo(gl) {
  const extension = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    vendor: gl.getParameter(extension.UNMASKED_VENDOR_WEBGL),
    description: gl.getParameter(extension.UNMASKED_RENDERER_WEBGL),
    fallback: false,
  }
}

function xtermDriver(instance) {
  return {
    focus: () => instance.focus(),
    onData: (listener) => instance.onData(listener),
    onFrame: (listener) => instance.onRender(listener),
    open: (host) => instance.open(host),
    visibleLines: () =>
      Array.from({ length: instance.rows }, (_, row) =>
        instance.buffer.active.getLine(row + instance.buffer.active.baseY)?.translateToString(true),
      ),
    write: (data) => new Promise((resolve) => instance.write(data, resolve)),
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
let xtermAddon
globalThis.__c5Stage = 'creating'
if (xterm) {
  const face = await new FontFace('Bench Mono', 'url(/font.woff2)').load()
  document.fonts.add(face)
  const instance = new XtermTerminal({
    allowProposedApi: true,
    cols: 80,
    rows: 24,
    fontFamily: 'Bench Mono',
    fontSize: 13,
    cursorBlink: false,
    theme: { foreground: '#ffffff', background: '#000000' },
  })
  terminal = xtermDriver(instance)
  const open = terminal.open
  terminal.open = (host) => {
    open(host)
    xtermAddon = new WebglAddon()
    instance.loadAddon(xtermAddon)
    tracing.xterm(0, instance, xtermAddon)
  }
} else if (worker) {
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
if (!xterm) {
  terminal.on('error', ({ cause }) => {
    window.__rendererBenchFailure = String(cause)
  })
}
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
let adapter
if (!port) adapter = xterm ? xtermAdapterInfo(xtermAddon) : adapterInfo(renderer)
const info = port ? await request(port, 'info') : { adapter }
globalThis.__c5Stage = 'ready'

globalThis.__c5 = {
  terminal,
  info: () => ({
    ...info,
    backend: xterm ? 'xterm-webgl' : backend,
    worker,
    xterm,
    adaptive,
    dpr: devicePixelRatio,
    visibility: document.visibilityState,
  }),
  metrics: async () => {
    if (port) return (await request(port, 'info')).metrics
    return xterm ? {} : { ...renderer.metrics }
  },
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
