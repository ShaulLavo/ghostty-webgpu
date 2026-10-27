import { Terminal as MainTerminal } from '../src/dom/terminal.ts'
import { Terminal as WorkerTerminal } from '../src/worker/index.ts'
import { createBenchmarkRenderer } from './renderer-factory.ts'
import { tracing, attachNative, attachRenderer, snapshot } from './renderer-diagnostics.mjs'

const RealWorker = window.Worker
const channels = []
window.Worker = class extends RealWorker {
  postMessage(message, transfer) {
    if (message.type !== 'initialize') return super.postMessage(message, transfer)
    const channel = new MessageChannel()
    channels.push(channel.port1)
    super.postMessage({ ...message, l7aPort: channel.port2 }, transfer.concat([channel.port2]))
  }
}
function request(port, command) {
  return new Promise((resolve) => {
    port.onmessage = ({ data }) => resolve(data)
    port.postMessage(command)
  })
}
export async function createHostedDriver({ backend, columns, rows, mount, worker, doTrace }) {
  let renderer
  let core
  let state
  let runtime
  let metrics = {}
  let latest
  const options = {
    autoFit: false,
    accessibility: false,
    appearance: {
      grid: { columns, rows },
      font: { family: 'Bench Mono', size: 13 },
      cursor: { blink: false },
    },
  }
  let terminal
  if (worker) {
    terminal = await WorkerTerminal.create({
      ...options,
      backend: backend === 'webgl2' ? 'webgl' : 'webgpu',
      assets: { wasm: '/ghostty-vt.wasm', bridge: '/bridge.wasm' },
      workerUrl: '/diagnostic-worker.js' + (doTrace ? '?trace' : ''),
      fonts: [{ family: 'Bench Mono', source: { url: '/font.woff2' } }],
    })
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
        if (doTrace) attachNative(0, runtime, core, state)
        const result = await createBenchmarkRenderer(backend, input)
        renderer = result.renderer
        if (doTrace) attachRenderer(0, renderer)
        return renderer
      },
    })
  }
  terminal.on('error', ({ cause }) => {
    window.__rendererBenchFailure = String(cause)
  })
  const host = document.createElement('div')
  host.style.cssText = 'width:1580px;height:850px;position:relative'
  mount.append(host)
  await terminal.open(host)
  await terminal.setTheme({
    ...terminal.appearance.theme,
    foreground: { r: 255, g: 0, b: 0 },
    background: { r: 0, g: 0, b: 0 },
  })
  const port = worker ? channels.at(-1) : null
  if (port) latest = await request(port, 'snapshot')
  const info = () => renderer?.device?.adapterInfo
  Reflect.set(globalThis, '__p0aHosted', { terminal, renderer, core, state,
    snapshot: () => port ? request(port, 'snapshot') : { metrics: { ...renderer.metrics }, snapshot: snapshot(runtime, renderer) },
    lose: () => port ? request(port, 'lose') : loseRenderer(renderer),
    begin: async () => { if (port) await request(port, 'begin'); else tracing.begin() },
    end: async () => port ? (await request(port, 'end')).trace : tracing.end(),
    markEcho: async () => { if (port) await request(port, 'echo'); else tracing.mark('echo-received') },
  })
  return {
    adapter:
      latest?.adapter ??
      (info()
        ? {
            vendor: info().vendor,
            architecture: info().architecture,
            description: info().description,
            fallback: info().isFallbackAdapter,
          }
        : null),
    dispose: async () => {
      await terminal.dispose()
      port?.close()
    },
    metrics: () => (renderer ? { ...renderer.metrics } : metrics),
    output: () => terminal.visibleLines().join('\n'),
    scroll: (delta) => terminal.scrollBy(delta),
    write: (data) => terminal.write(data),
    prepare: async () => {
      if (port) await request(port, 'begin')
    },
    diagnostics: async () => {
      if (!port) return { snapshot: snapshot(runtime, renderer) }
      latest = await request(port, 'end')
      metrics = Object.fromEntries(
        Object.entries(latest.metrics).map(([key, value]) => [key, (metrics[key] ?? 0) + value]),
      )
      return latest
    },
  }
}

function loseRenderer(renderer) {
  if (renderer.backend === 'webgpu') {
    renderer.device.destroy()
    return { triggered: 'GPUDevice.destroy' }
  }
  const extension = renderer.state.pass.context.getExtension('WEBGL_lose_context')
  extension.loseContext()
  setTimeout(() => extension.restoreContext(), 100)
  return { triggered: 'WEBGL_lose_context', restoreDelayMilliseconds: 100 }
}
