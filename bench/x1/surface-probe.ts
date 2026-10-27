// X1 probe: GPU-process CPU of N WebGPU canvases versus one encoder versus one shared surface.
// Pure WebGPU, no terminal code: isolates presentation and command-buffer costs.
import { chromium, type CDPSession } from 'playwright'

const counts = (process.env.PROBE_COUNTS ?? '1,4,16,32').split(',').map(Number)
const frames = Number(process.env.PROBE_FRAMES ?? 300)
const tileWidth = Number(process.env.PROBE_TILE_WIDTH ?? 1280)
const tileHeight = Number(process.env.PROBE_TILE_HEIGHT ?? 768)
const instances = Number(process.env.PROBE_INSTANCES ?? 1920)
const modes = ['canvases', 'one-encoder', 'one-surface'] as const
type Mode = (typeof modes)[number]

const page = `<!doctype html><style>body{margin:0;background:black}main{width:1600px;height:900px;display:flex;flex-wrap:wrap;align-content:flex-start}canvas{object-fit:contain}</style><main></main>
<script type="module">
const shader = \`
struct Out { @builtin(position) position: vec4f, @location(0) color: vec4f }
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let corners = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(0,1), vec2f(0,1), vec2f(1,0), vec2f(1,1));
  let cell = vec2f(f32(i % 80u), f32(i / 80u));
  let p = (cell + corners[v] * 0.8) / vec2f(80.0, 24.0);
  var o: Out;
  o.position = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  o.color = vec4f(fract(cell.x * 0.13), fract(cell.y * 0.21), 0.5, 1.0);
  return o;
}
@fragment fn fs(input: Out) -> @location(0) vec4f { return input.color; }\`
window.runProbe = async ({ mode, count, frames, tileWidth, tileHeight, instances }) => {
  const main = document.querySelector('main')
  main.replaceChildren()
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  const device = await adapter.requestDevice()
  const format = navigator.gpu.getPreferredCanvasFormat()
  const module = device.createShaderModule({ code: shader })
  const pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } })
  const side = Math.ceil(Math.sqrt(count))
  const contexts = []
  const surfaces = mode === 'one-surface' ? 1 : count
  for (let index = 0; index < surfaces; index += 1) {
    const canvas = document.createElement('canvas')
    canvas.width = mode === 'one-surface' ? tileWidth * side : tileWidth
    canvas.height = mode === 'one-surface' ? tileHeight * Math.ceil(count / side) : tileHeight
    canvas.style.width = mode === 'one-surface' ? '1600px' : Math.floor(1600 / side) + 'px'
    canvas.style.height = mode === 'one-surface' ? Math.floor(900 * Math.ceil(count / side) / side) + 'px' : Math.floor(900 / side) + 'px'
    main.append(canvas)
    const context = canvas.getContext('webgpu')
    context.configure({ device, format, alphaMode: 'premultiplied' })
    contexts.push(context)
  }
  const pass = (encoder, view, load) => encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
  const drawFrame = () => {
    if (mode === 'canvases') {
      const commands = contexts.map((context) => {
        const encoder = device.createCommandEncoder()
        const p = pass(encoder, context.getCurrentTexture().createView(), 'clear')
        p.setPipeline(pipeline); p.draw(6, instances); p.end()
        return encoder.finish()
      })
      device.queue.submit(commands)
      return
    }
    const encoder = device.createCommandEncoder()
    if (mode === 'one-encoder') {
      for (const context of contexts) {
        const p = pass(encoder, context.getCurrentTexture().createView(), 'clear')
        p.setPipeline(pipeline); p.draw(6, instances); p.end()
      }
    } else {
      const p = pass(encoder, contexts[0].getCurrentTexture().createView(), 'clear')
      p.setPipeline(pipeline)
      for (let index = 0; index < count; index += 1) {
        const x = (index % side) * tileWidth, y = Math.floor(index / side) * tileHeight
        p.setViewport(x, y, tileWidth, tileHeight, 0, 1); p.setScissorRect(x, y, tileWidth, tileHeight)
        p.draw(6, instances)
      }
      p.end()
    }
    device.queue.submit([encoder.finish()])
  }
  for (let warm = 0; warm < 30; warm += 1) await new Promise((r) => requestAnimationFrame(() => { drawFrame(); r() }))
  await device.queue.onSubmittedWorkDone()
  window.__ready = true
  const callbacks = []
  await new Promise((resolve) => {
    let left = frames
    const tick = () => {
      const started = performance.now()
      drawFrame()
      callbacks.push(performance.now() - started)
      if (--left === 0) resolve(); else requestAnimationFrame(tick)
    }
    window.__start = () => requestAnimationFrame(tick)
    window.__startResolve = resolve
  })
  await device.queue.onSubmittedWorkDone()
  for (const context of contexts) context.unconfigure()
  device.destroy()
  callbacks.sort((a, b) => a - b)
  return { p50: callbacks[Math.floor(callbacks.length * 0.5)], p95: callbacks[Math.floor(callbacks.length * 0.95)] }
}
</script>`

async function processCpu(session: CDPSession): Promise<Map<number, { type: string; cpu: number }>> {
  const info = (await session.send('SystemInfo.getProcessInfo')) as {
    processInfo: { id: number; type: string; cpuTime: number }[]
  }
  return new Map(info.processInfo.map((entry) => [entry.id, { type: entry.type, cpu: entry.cpuTime }]))
}

const args = [
  '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) args.push('--ozone-platform=wayland')
const browser = await chromium.launch({ channel: 'chromium', headless: false, args })
const session = await browser.newBrowserCDPSession()
const results: unknown[] = []
try {
  for (const count of counts) {
    for (const [repetition, order] of [modes, modes.toReversed()].entries()) {
      for (const mode of order) results.push(await measure(mode as Mode, count, repetition))
    }
  }
} finally {
  await browser.close()
}
console.log(JSON.stringify({ frames, tileWidth, tileHeight, instances, platform: process.platform, results }, null, 1))

async function measure(mode: Mode, count: number, repetition: number) {
  const tab = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
  try {
    await tab.route('http://localhost:41890/x1-probe', (route) => route.fulfill({ contentType: 'text/html', body: page }))
    await tab.goto('http://localhost:41890/x1-probe')
    const run = tab.evaluate((options) => (window as never as { runProbe: (o: unknown) => Promise<unknown> }).runProbe(options), {
      mode, count, frames, tileWidth, tileHeight, instances,
    })
    await tab.waitForFunction(() => (window as never as { __ready?: boolean }).__ready === true)
    const before = await processCpu(session)
    const started = performance.now()
    await tab.evaluate(() => (window as never as { __start: () => void }).__start())
    const callback = await run
    const seconds = (performance.now() - started) / 1000
    const after = await processCpu(session)
    const byType: Record<string, number> = {}
    for (const [id, entry] of after) {
      const delta = Math.max(0, entry.cpu - (before.get(id)?.cpu ?? 0))
      byType[entry.type] = (byType[entry.type] ?? 0) + delta
    }
    const percent = Object.fromEntries(Object.entries(byType).map(([type, value]) => [type, +((value / seconds) * 100).toFixed(1)]))
    const result = { mode, count, repetition, seconds: +seconds.toFixed(2), percent, callback }
    console.error(JSON.stringify(result))
    return result
  } finally {
    await tab.close()
  }
}
