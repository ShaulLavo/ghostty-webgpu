import { GhosttyRuntime, WebGpuTerminalRenderer } from '../src/index.js'

const columns = 200
const rows = 50
const cellWidth = 8
const cellHeight = 16
const pixelRatio = 2
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
const font = Object.freeze({
  charLeft: 0,
  charTop: 3,
  cssCellHeight: cellHeight,
  cssCellWidth: cellWidth,
  deviceBaseline: 24,
  deviceCellHeight: cellHeight * pixelRatio,
  deviceCellWidth: cellWidth * pixelRatio,
  deviceCharHeight: 26,
  deviceCharWidth: cellWidth * pixelRatio,
  pixelRatio,
  settings: Object.freeze({
    boldWeight: 700,
    family: 'monospace',
    letterSpacing: 0,
    lineHeight: 32 / 26,
    size: 13,
    weight: 400,
  }),
})
const terminal = runtime.createTerminal({
  cellHeight: font.deviceCellHeight,
  cellWidth: font.deviceCellWidth,
  columns,
  rows,
})
const renderState = runtime.createRenderState(terminal)
const renderer = await WebGpuTerminalRenderer.create({
  canvas,
  columns,
  deviceFactory: async () => device,
  font,
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

function glyphChurnLine(index: number): string {
  const emoji = ['🧪', '🚀', '🫠', '🧭'][index % 4] ?? '🧪'
  let output = ''
  for (let offset = 0; offset < 24; offset += 1) {
    const cjk = String.fromCodePoint(0x4e00 + ((index * 24 + offset) % 16_000))
    const combining = String.fromCodePoint(0x300 + ((index + offset) % 80))
    output += `${cjk}e${combining}${emoji}`
  }
  return `${output}\r\n`
}

function writeGlyphChurn(): void {
  terminal.write(glyphChurnLine(sequence))
  sequence += 1
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
  if (name === 'glyph-churn') {
    scenarioTimer = window.setInterval(writeGlyphChurn, 16)
    return
  }
  throw new Error(`Unknown scenario: ${name}`)
}

function resetMetrics(): void {
  baseline = { ...renderer.metrics }
}

function getMetrics() {
  return {
    atlasCacheHits: renderer.metrics.atlasCacheHits - baseline.atlasCacheHits,
    atlasCacheMisses: renderer.metrics.atlasCacheMisses - baseline.atlasCacheMisses,
    atlasEvictions: renderer.metrics.atlasEvictions - baseline.atlasEvictions,
    atlasPages: renderer.metrics.atlasPages,
    atlasUploadedBytes: renderer.metrics.atlasUploadedBytes - baseline.atlasUploadedBytes,
    atlasUploadOperations: renderer.metrics.atlasUploadOperations - baseline.atlasUploadOperations,
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
