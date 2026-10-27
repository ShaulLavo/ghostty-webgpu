// Shared-surface fleet benchmark: per-terminal canvases (before) versus one shared surface
// (candidate), same build, counterbalanced ABBA per case, headed Chromium.
// Env: FLEET_MATRIX="80x24x1 80x24x16", FLEET_BUSY="all,one", FLEET_STEPS, FLEET_REPS, FLEET_OUT, FLEET_SHOTS.
import { chromium, type CDPSession, type Page } from 'playwright'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const matrix = (process.env.FLEET_MATRIX ?? '80x24x1 80x24x4 80x24x16 80x24x32 200x50x4').split(' ')
const arms = (process.env.FLEET_ARMS ?? 'canvases,shared').split(',') as Arm[]
const busyModes = (process.env.FLEET_BUSY ?? 'all').split(',') as ('all' | 'one')[]
const steps = Number(process.env.FLEET_STEPS ?? 300)
const repetitions = Number(process.env.FLEET_REPS ?? 2)
const out = process.env.FLEET_OUT ?? '/work/tmp/sst/fleet'
const shotCounts = (process.env.FLEET_SHOTS ?? '16').split(',').map(Number)
const origin = 'http://localhost:41892'
mkdirSync(out, { recursive: true })

const built = await Bun.build({
  entrypoints: [join(import.meta.dir, 'fleet-entry.ts')],
  format: 'esm',
  target: 'browser',
})
if (!built.success || !built.outputs[0]) throw new Error('Fleet bundle failed')
const bundle = await built.outputs[0].text()
const wasm = readFileSync(join(root, 'ghostty-vt.wasm'))
const bridge = readFileSync(join(root, 'bridge.wasm'))
const html =
  '<!doctype html><style>body{margin:0;background:#202020}main{position:relative;width:1600px;height:1000px;overflow:auto;display:grid;justify-content:start;align-content:start}.pane{line-height:0}canvas{display:block}</style><main></main><script type="module" src="/bundle.js"></script>'

const args = [
  '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]
if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY)
  args.push('--ozone-platform=wayland')
const browser = await chromium.launch({
  channel: 'chromium',
  headless: false,
  args,
})
const session = await browser.newBrowserCDPSession()
const gpuInfo = (await session.send('SystemInfo.getInfo')) as {
  gpu: { devices: unknown[]; auxAttributes?: Record<string, unknown> }
}
const results: unknown[] = []
try {
  for (const spec of matrix) {
    const [columns, rows, count] = spec.split('x').map(Number) as [number, number, number]
    for (const busy of busyModes) {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const order = repetition % 2 === 0 ? arms : arms.toReversed()
        for (const arm of order) {
          const shots = repetition === 0 && busy === 'all' && shotCounts.includes(count)
          results.push(
            await measure({
              columns,
              rows,
              count,
              busy,
              arm,
              shared: arm === 'shared',
              repetition,
              shots,
            }),
          )
        }
      }
    }
  }
} finally {
  writeFileSync(
    join(out, 'fleet.json'),
    JSON.stringify(
      {
        version: browser.version(),
        platform: process.platform,
        gpu: gpuInfo.gpu,
        steps,
        results,
      },
      null,
      1,
    ),
  )
  await browser.close()
}

interface Case {
  columns: number
  rows: number
  count: number
  busy: 'all' | 'one'
  arm: Arm
  shared: boolean
  repetition: number
  shots: boolean
}

async function measure(spec: Case) {
  const vramBefore = freeVram()
  if (vramBefore !== undefined && vramBefore < 2048)
    throw new Error(`VRAM free ${vramBefore} MiB < 2 GiB`)
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  })
  page.setDefaultTimeout(60_000)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  try {
    await page.route(`${origin}/**`, (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/bundle.js')
        return route.fulfill({ body: bundle, contentType: 'text/javascript' })
      if (path === '/ghostty-vt.wasm')
        return route.fulfill({ body: wasm, contentType: 'application/wasm' })
      if (path === '/bridge.wasm')
        return route.fulfill({ body: bridge, contentType: 'application/wasm' })
      if (path === '/') return route.fulfill({ body: html, contentType: 'text/html' })
      return route.abort()
    })
    const query = `count=${spec.count}&columns=${spec.columns}&rows=${spec.rows}&arm=${spec.arm}`
    await page.goto(`${origin}/?${query}`)
    await page.waitForFunction(() => '__fleet' in window)
    const info = await page.evaluate(() => (window as never as Fleet).__fleet.info())
    await page.evaluate((busy) => (window as never as Fleet).__fleet.run(30, busy), spec.busy)
    const vramWarm = freeVram()
    const before = await processCpu(session)
    const started = performance.now()
    const run = await page.evaluate(
      ({ steps, busy }) => (window as never as Fleet).__fleet.run(steps, busy),
      { steps, busy: spec.busy },
    )
    const seconds = (performance.now() - started) / 1000
    const after = await processCpu(session)
    const percent: Record<string, number> = {}
    for (const [id, entry] of after) {
      const delta = Math.max(0, entry.cpu - (before.get(id)?.cpu ?? 0))
      percent[entry.type] = +((percent[entry.type] ?? 0) + (delta / seconds) * 100).toFixed(2)
    }
    await page.evaluate(() => (window as never as Fleet).__fleet.settle())
    const outputs = await page.evaluate(() => (window as never as Fleet).__fleet.outputs())
    const shots = spec.shots ? await screenshots(page, spec) : undefined
    const result = {
      ...spec,
      info,
      seconds: +seconds.toFixed(3),
      percent,
      vram: { before: vramBefore, warm: vramWarm },
      bytes: run.bytes,
      composited: run.composited,
      frameCallbacks: summary(run.frameCallbacks),
      writeMilliseconds: summary(run.writeMilliseconds),
      latency: {
        acknowledged: summary(run.latency.acknowledged),
        nextFrame: summary(run.latency.nextFrame),
      },
      panes: run.panes,
      textHashes: outputs.map(sha),
      shots,
      errors: run.errors.concat(pageErrors),
    }
    console.error(
      `${spec.columns}x${spec.rows}x${spec.count} ${spec.busy} ${spec.arm} #${spec.repetition}: GPU ${percent.GPU}% renderer ${percent.renderer}% ack p95 ${result.latency.acknowledged.p95.toFixed(2)}ms submitted ${run.panes.reduce((sum, pane) => sum + pane.submittedFrames, 0)} errors ${result.errors.length}`,
    )
    return result
  } finally {
    await page.close()
  }
}

async function screenshots(page: Page, spec: Case): Promise<string[]> {
  const directory = join(out, 'shots', `${spec.columns}x${spec.rows}x${spec.count}-${spec.arm}`)
  mkdirSync(directory, { recursive: true })
  const panes = page.locator('.pane canvas')
  const hashes: string[] = []
  for (let index = 0; index < spec.count; index += 1) {
    await panes.nth(index).scrollIntoViewIfNeeded()
    await page.evaluate(() => (window as never as Fleet).__fleet.settle())
    const png = await panes.nth(index).screenshot({ animations: 'disabled', caret: 'initial' })
    writeFileSync(join(directory, `pane-${index}.png`), png)
    hashes.push(sha(png))
  }
  return hashes
}

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function summary(samples: readonly number[]) {
  const sorted = samples.toSorted((left, right) => left - right)
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0
  return {
    count: samples.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1) ?? 0,
  }
}

function freeVram(): number | undefined {
  if (process.platform !== 'linux') return undefined
  return Number(
    execFileSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'])
      .toString()
      .trim(),
  )
}

async function processCpu(cdp: CDPSession): Promise<Map<number, { type: string; cpu: number }>> {
  const info = (await cdp.send('SystemInfo.getProcessInfo')) as {
    processInfo: { id: number; type: string; cpuTime: number }[]
  }
  return new Map(
    info.processInfo.map((entry) => [entry.id, { type: entry.type, cpu: entry.cpuTime }]),
  )
}

interface FleetRun {
  bytes: number
  composited: number
  frameCallbacks: number[]
  writeMilliseconds: number[]
  latency: { acknowledged: number[]; nextFrame: number[] }
  panes: {
    submittedFrames: number
    acknowledgements: number
    rebuiltRows: number
  }[]
  errors: string[]
}

interface Fleet {
  __fleet: {
    info(): unknown
    run(steps: number, busy: 'all' | 'one'): Promise<FleetRun>
    outputs(): string[]
    settle(): Promise<void>
  }
}

type Arm = 'canvases' | 'shared' | 'webgl2'
