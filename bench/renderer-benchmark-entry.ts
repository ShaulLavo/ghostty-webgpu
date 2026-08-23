import { GhosttyRuntime, WebGpuTerminalRenderer } from '../src/index.js'

const columns = 200
const rows = 50
const cellWidth = 8
const cellHeight = 16
const canvas = requireElement<HTMLCanvasElement>('#terminal')
const status = requireElement<HTMLElement>('#status')

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector)
  if (element) return element
  throw new Error(`Benchmark element is missing: ${selector}`)
}

const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
if (!adapter) throw new Error('WebGPU requestAdapter returned null')
const device = await adapter.requestDevice()
const [wasm, bridge] = await Promise.all([
  fetch('/ghostty-vt.wasm').then((response) => response.arrayBuffer()),
  fetch('/bridge.wasm').then((response) => response.arrayBuffer()),
])
const runtime = await GhosttyRuntime.create({ bridge, wasm })
const terminal = runtime.createTerminal({ cellHeight, cellWidth, columns, rows })
const renderState = runtime.createRenderState(terminal)
const renderer = await WebGpuTerminalRenderer.create({
  canvas,
  cellHeight,
  cellWidth,
  columns,
  deviceFactory: async () => device,
  fontFamily: 'monospace',
  fontSize: 13,
  renderState,
  rows,
})

let baseline = { ...renderer.metrics }
let sequence = 0
let scenarioTimer: number | undefined

function outputLine(index: number): string {
  const label = String(index).padStart(8, '0')
  return `${label} ${'terminal-output '.repeat(12)}`.slice(0, columns - 2) + '\r\n'
}

function writeLines(count: number): void {
  let output = ''
  for (let line = 0; line < count; line += 1) {
    output += outputLine(sequence)
    sequence += 1
  }
  terminal.write(output)
  renderer.notifyWrite()
}

function stopScenario(): void {
  if (scenarioTimer === undefined) return
  window.clearInterval(scenarioTimer)
  scenarioTimer = undefined
}

function startScenario(name: string): void {
  stopScenario()
  status.textContent = name
  renderer.setCursorBlinkEnabled(false)
  renderer.setFocused(false)
  if (name === 'unfocused-idle') return
  if (name === 'focused-blinking-idle') {
    renderer.setCursorBlinkEnabled(true)
    renderer.setFocused(true)
    return
  }
  if (name === 'burst-output') {
    scenarioTimer = window.setInterval(() => writeLines(10), 16)
    return
  }
  if (name === 'sustained-scroll') {
    scenarioTimer = window.setInterval(() => renderer.notifyScroll(), 16)
    return
  }
  throw new Error(`Unknown scenario: ${name}`)
}

function resetMetrics(): void {
  baseline = { ...renderer.metrics }
}

function getMetrics() {
  return {
    atlasEvictions: renderer.metrics.atlasEvictions - baseline.atlasEvictions,
    deviceRestores: renderer.metrics.deviceRestores - baseline.deviceRestores,
    draws: renderer.metrics.draws - baseline.draws,
    rebuiltRows: renderer.metrics.rebuiltRows - baseline.rebuiltRows,
    submittedFrames: renderer.metrics.submittedFrames - baseline.submittedFrames,
    uploadedBytes: renderer.metrics.uploadedBytes - baseline.uploadedBytes,
  }
}

writeLines(200)
await new Promise((resolve) => window.setTimeout(resolve, 500))
resetMetrics()
status.textContent = 'ready'

Object.assign(window, {
  __rendererBench: {
    getMetrics,
    getPageInfo: () => ({
      adapter: {
        architecture: adapter.info.architecture,
        description: adapter.info.description,
        device: adapter.info.device,
        vendor: adapter.info.vendor,
      },
      columns,
      dpr: window.devicePixelRatio,
      rows,
    }),
    resetMetrics,
    startScenario,
    stopScenario,
  },
})
