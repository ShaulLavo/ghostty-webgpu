// Shared-surface attribution probe: pure WebGPU, no terminal code. Extends X1's surface probe
// with no-presentation and copy topologies, and an optional GPU-process trace per mode.
import { chromium, type Browser, type CDPSession } from "playwright";
import { writeFileSync } from "node:fs";

const counts = (process.env.PROBE_COUNTS ?? "16").split(",").map(Number);
const frames = Number(process.env.PROBE_FRAMES ?? 300);
const tileWidth = Number(process.env.PROBE_TILE_WIDTH ?? 1280);
const tileHeight = Number(process.env.PROBE_TILE_HEIGHT ?? 768);
const instances = Number(process.env.PROBE_INSTANCES ?? 1920);
const repetitions = Number(process.env.PROBE_REPETITIONS ?? 2);
const traceDir = process.env.PROBE_TRACE_DIR;
const traceCounts = (process.env.PROBE_TRACE_COUNTS ?? "16")
  .split(",")
  .map(Number);
const allModes = [
  "canvases",
  "one-surface",
  "offscreen",
  "canvases-one-busy",
  "surface-copies",
  "canvas2d-copies",
  "canvas2d-fill",
] as const;
type Mode = (typeof allModes)[number];
const modes = (process.env.PROBE_MODES?.split(",") ?? allModes) as Mode[];

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
  const sharedWidth = tileWidth * side, sharedHeight = tileHeight * Math.ceil(count / side)
  const tileCss = (canvas) => { canvas.style.width = Math.floor(1600 / side) + 'px'; canvas.style.height = Math.floor(900 / side) + 'px' }
  const contexts = [], contexts2d = [], targets = []
  const canvasCount = mode === 'one-surface' ? 1 : ['offscreen', 'canvas2d-copies', 'canvas2d-fill'].includes(mode) ? 0 : count
  for (let index = 0; index < canvasCount; index += 1) {
    const canvas = document.createElement('canvas')
    canvas.width = mode === 'one-surface' ? sharedWidth : tileWidth
    canvas.height = mode === 'one-surface' ? sharedHeight : tileHeight
    if (mode === 'one-surface') { canvas.style.width = '1600px'; canvas.style.height = Math.floor(900 * Math.ceil(count / side) / side) + 'px' } else tileCss(canvas)
    main.append(canvas)
    const context = canvas.getContext('webgpu')
    context.configure({ device, format, alphaMode: 'premultiplied', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST })
    contexts.push(context)
  }
  if (mode === 'offscreen') {
    for (let index = 0; index < count; index += 1) targets.push(device.createTexture({ size: [tileWidth, tileHeight], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }))
  }
  let shared, sharedCanvas
  if (mode === 'surface-copies') shared = device.createTexture({ size: [sharedWidth, sharedHeight], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
  if (mode === 'canvas2d-fill') {
    for (let index = 0; index < count; index += 1) {
      const canvas = document.createElement('canvas')
      canvas.width = tileWidth; canvas.height = tileHeight; tileCss(canvas)
      main.append(canvas)
      contexts2d.push(canvas.getContext('2d'))
    }
  }
  if (mode === 'canvas2d-copies') {
    sharedCanvas = new OffscreenCanvas(sharedWidth, sharedHeight)
    const context = sharedCanvas.getContext('webgpu')
    context.configure({ device, format, alphaMode: 'premultiplied' })
    contexts.push(context)
    for (let index = 0; index < count; index += 1) {
      const canvas = document.createElement('canvas')
      canvas.width = tileWidth; canvas.height = tileHeight; tileCss(canvas)
      main.append(canvas)
      contexts2d.push(canvas.getContext('2d'))
    }
  }
  const pass = (encoder, view, load) => encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
  const tiled = (encoder, view) => {
    const p = pass(encoder, view, 'clear')
    p.setPipeline(pipeline)
    for (let index = 0; index < count; index += 1) {
      const x = (index % side) * tileWidth, y = Math.floor(index / side) * tileHeight
      p.setViewport(x, y, tileWidth, tileHeight, 0, 1); p.setScissorRect(x, y, tileWidth, tileHeight)
      p.draw(6, instances)
    }
    p.end()
  }
  const single = (view) => {
    const encoder = device.createCommandEncoder()
    const p = pass(encoder, view, 'clear')
    p.setPipeline(pipeline); p.draw(6, instances); p.end()
    return encoder.finish()
  }
  let tick = 0
  const drawFrame = () => {
    tick += 1
    if (mode === 'canvas2d-fill') {
      contexts2d.forEach((context) => { context.fillStyle = tick % 2 ? '#123' : '#321'; context.fillRect(0, 0, 64, 64) })
      return
    }
    if (mode === 'canvases') return device.queue.submit(contexts.map((context) => single(context.getCurrentTexture().createView())))
    if (mode === 'canvases-one-busy') return device.queue.submit([single(contexts[0].getCurrentTexture().createView())])
    if (mode === 'offscreen') return device.queue.submit(targets.map((target) => single(target.createView())))
    const encoder = device.createCommandEncoder()
    if (mode === 'one-surface' || mode === 'canvas2d-copies') tiled(encoder, contexts[0].getCurrentTexture().createView())
    if (mode === 'surface-copies') {
      tiled(encoder, shared.createView())
      contexts.forEach((context, index) => {
        const origin = [(index % side) * tileWidth, Math.floor(index / side) * tileHeight]
        encoder.copyTextureToTexture({ texture: shared, origin }, { texture: context.getCurrentTexture() }, [tileWidth, tileHeight])
      })
    }
    device.queue.submit([encoder.finish()])
    if (mode !== 'canvas2d-copies') return
    contexts2d.forEach((context, index) => {
      const x = (index % side) * tileWidth, y = Math.floor(index / side) * tileHeight
      context.clearRect(0, 0, tileWidth, tileHeight)
      context.drawImage(sharedCanvas, x, y, tileWidth, tileHeight, 0, 0, tileWidth, tileHeight)
    })
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
  })
  await device.queue.onSubmittedWorkDone()
  for (const context of contexts) context.unconfigure()
  device.destroy()
  callbacks.sort((a, b) => a - b)
  return { p50: callbacks[Math.floor(callbacks.length * 0.5)], p95: callbacks[Math.floor(callbacks.length * 0.95)] }
}
</script>`;

const traceCategories = [
  "toplevel",
  "gpu",
  "gpu.service",
  "gpu.dawn",
  "disabled-by-default-gpu.dawn",
  "gpu.angle",
  "viz",
  "cc",
  "mojom",
  "shared_image",
  "disabled-by-default-gpu.service",
  "gpu.decoder",
  "disabled-by-default-gpu.decoder",
  "skia",
  "skia.gpu",
  "disabled-by-default-skia.gpu",
  "webgpu",
  "disabled-by-default-webgpu",
];

async function processCpu(
  session: CDPSession,
): Promise<Map<number, { type: string; cpu: number }>> {
  const info = (await session.send("SystemInfo.getProcessInfo")) as {
    processInfo: { id: number; type: string; cpuTime: number }[];
  };
  return new Map(
    info.processInfo.map((entry) => [
      entry.id,
      { type: entry.type, cpu: entry.cpuTime },
    ]),
  );
}

const args = [
  "--enable-unsafe-webgpu",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];
if (process.platform === "linux" && process.env.WAYLAND_DISPLAY)
  args.push("--ozone-platform=wayland");
const browser = await chromium.launch({
  channel: "chromium",
  headless: false,
  args,
});
const session = await browser.newBrowserCDPSession();
const results: unknown[] = [];
try {
  for (const count of counts) {
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const order = repetition % 2 === 0 ? modes : modes.toReversed();
      for (const mode of order)
        results.push(await measure(browser, mode, count, repetition, false));
    }
    if (!traceDir || !traceCounts.includes(count)) continue;
    for (const mode of modes) await measure(browser, mode, count, 0, true);
  }
} finally {
  await browser.close();
}
console.log(
  JSON.stringify(
    {
      frames,
      tileWidth,
      tileHeight,
      instances,
      platform: process.platform,
      version: browser.version(),
      results,
    },
    null,
    1,
  ),
);

async function measure(
  browser: Browser,
  mode: Mode,
  count: number,
  repetition: number,
  trace: boolean,
) {
  const tab = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  try {
    await tab.route("http://localhost:41891/surface-probe", (route) =>
      route.fulfill({ contentType: "text/html", body: page }),
    );
    await tab.goto("http://localhost:41891/surface-probe");
    const run = tab.evaluate(
      (options) =>
        (
          window as never as { runProbe: (o: unknown) => Promise<unknown> }
        ).runProbe(options),
      { mode, count, frames, tileWidth, tileHeight, instances },
    );
    await tab.waitForFunction(
      () => (window as never as { __ready?: boolean }).__ready === true,
    );
    if (trace) await browser.startTracing(tab, { categories: traceCategories });
    const before = await processCpu(session);
    const started = performance.now();
    await tab.evaluate(() =>
      (window as never as { __start: () => void }).__start(),
    );
    const callback = await run;
    const seconds = (performance.now() - started) / 1000;
    const after = await processCpu(session);
    if (trace)
      writeFileSync(
        `${traceDir}/${count}-${mode}.json`,
        await browser.stopTracing(),
      );
    const byType: Record<string, number> = {};
    for (const [id, entry] of after) {
      const delta = Math.max(0, entry.cpu - (before.get(id)?.cpu ?? 0));
      byType[entry.type] = (byType[entry.type] ?? 0) + delta;
    }
    const percent = Object.fromEntries(
      Object.entries(byType).map(([type, value]) => [
        type,
        +((value / seconds) * 100).toFixed(1),
      ]),
    );
    const result = {
      mode,
      count,
      repetition,
      trace,
      seconds: +seconds.toFixed(2),
      percent,
      callback,
    };
    console.error(JSON.stringify(result));
    return result;
  } finally {
    await tab.close();
  }
}
