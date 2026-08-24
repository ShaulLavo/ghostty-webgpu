import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'

interface ProcessInfo {
  command: string
  cpu: number
  pid: number
  ppid: number
}

const scenarios = [
  'focused-blinking-idle',
  'unfocused-idle',
  'burst-output',
  'sustained-scroll',
  'glyph-churn',
] as const
const sampleSeconds = Number(process.env.BENCH_SAMPLE_SECONDS ?? '30')
const warmupSeconds = Number(process.env.BENCH_WARMUP_SECONDS ?? '5')
const profilePath = await mkdtemp(join(tmpdir(), 'ghostty-webgpu-bench-'))
const benchmarkUrl = 'http://localhost:41799/'

function readProcesses(): readonly ProcessInfo[] {
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,%cpu=,command='], { encoding: 'utf8' })
  return output
    .trim()
    .split('\n')
    .map(parseProcess)
    .filter((process): process is ProcessInfo => process !== undefined)
}

function parseProcess(line: string): ProcessInfo | undefined {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/)
  if (!match) return undefined
  return {
    command: match[4] ?? '',
    cpu: Number(match[3]),
    pid: Number(match[1]),
    ppid: Number(match[2]),
  }
}

function descendantPids(processes: readonly ProcessInfo[], rootPid: number): ReadonlySet<number> {
  const found = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = addDescendants(processes, found)
  }
  return found
}

function addDescendants(processes: readonly ProcessInfo[], found: Set<number>): boolean {
  let changed = false
  for (const process of processes) {
    if (!found.has(process.ppid) || found.has(process.pid)) continue
    found.add(process.pid)
    changed = true
  }
  return changed
}

function findGpuProcess(): ProcessInfo | undefined {
  const processes = readProcesses()
  const browser = processes.find((process) => process.command.includes(profilePath))
  if (!browser) return undefined
  const descendants = descendantPids(processes, browser.pid)
  return processes.find(
    (process) => descendants.has(process.pid) && process.command.includes('--type=gpu-process'),
  )
}

async function waitForGpuProcess(): Promise<ProcessInfo> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const process = findGpuProcess()
    if (process) return process
    await sleep(0.5)
  }
  throw new Error('Could not identify the benchmark browser GPU process')
}

function sampleCpu(pid: number): number {
  const output = execFileSync('ps', ['-p', String(pid), '-o', '%cpu='], { encoding: 'utf8' })
  return Number(output.trim())
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  return sorted[index] ?? 0
}

function summarize(samples: readonly number[]) {
  return {
    max: Math.max(...samples),
    mean: samples.reduce((total, value) => total + value, 0) / samples.length,
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    samples,
  }
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1_000))
}

async function measure(page: Page, gpuPid: number, scenario: string) {
  await page.evaluate((name) => window.__rendererBench.startScenario(name), scenario)
  await sleep(warmupSeconds)
  await page.evaluate(() => window.__rendererBench.resetMetrics())
  const samples: number[] = []
  for (let second = 0; second < sampleSeconds; second += 1) {
    await sleep(1)
    samples.push(sampleCpu(gpuPid))
  }
  const metrics = await page.evaluate(() => window.__rendererBench.getMetrics())
  await page.evaluate(() => window.__rendererBench.stopScenario())
  return { cpu: summarize(samples), metrics }
}

async function buildBrowserBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dirname, '../bench/renderer-benchmark-entry.ts')],
    format: 'esm',
    target: 'browser',
  })
  if (result.success && result.outputs[0]) return result.outputs[0].text()
  const message = result.logs.map((log) => log.message).join('\n')
  throw new Error(`Unable to build benchmark bundle:\n${message}`)
}

const [bundle, wasm, bridge] = await Promise.all([
  buildBrowserBundle(),
  readFile(join(import.meta.dirname, '../ghostty-vt.wasm')),
  readFile(join(import.meta.dirname, '../bridge.wasm')),
])
const context = await chromium.launchPersistentContext(profilePath, {
  args: [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--enable-unsafe-webgpu',
  ],
  deviceScaleFactor: 2,
  headless: false,
  viewport: { height: 900, width: 1600 },
})

try {
  const page = context.pages()[0] ?? (await context.newPage())
  page.on('pageerror', (error) => console.error('PAGEERROR', error.stack ?? error.message))
  await page.route(`${benchmarkUrl}bundle.js`, (route) =>
    route.fulfill({ body: bundle, contentType: 'text/javascript' }),
  )
  await page.route(`${benchmarkUrl}ghostty-vt.wasm`, (route) =>
    route.fulfill({ body: wasm, contentType: 'application/wasm' }),
  )
  await page.route(`${benchmarkUrl}bridge.wasm`, (route) =>
    route.fulfill({ body: bridge, contentType: 'application/wasm' }),
  )
  await page.route(benchmarkUrl, (route) =>
    route.fulfill({
      body: '<!doctype html><main><div id="status">loading</div><canvas id="terminal"></canvas><script type="module" src="/bundle.js"></script></main>',
      contentType: 'text/html',
    }),
  )
  await page.goto(benchmarkUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__rendererBench), null, { timeout: 30_000 })
  await page.bringToFront()
  const gpuProcess = await waitForGpuProcess()
  const results: Record<string, unknown> = {}
  for (const scenario of scenarios) {
    results[scenario] = await measure(page, gpuProcess.pid, scenario)
    console.log(`${scenario}: ${JSON.stringify(results[scenario])}`)
  }
  console.log(
    `BENCH_RESULT ${JSON.stringify({
      gpuCommand: gpuProcess.command,
      gpuPid: gpuProcess.pid,
      pageInfo: await page.evaluate(() => window.__rendererBench.getPageInfo()),
      results,
      sampleSeconds,
      warmupSeconds,
    })}`,
  )
} finally {
  await context.close()
  await rm(profilePath, { force: true, recursive: true })
}

declare global {
  interface Window {
    __rendererBench: {
      getMetrics(): Record<string, number>
      getPageInfo(): unknown
      resetMetrics(): void
      startScenario(name: string): void
      stopScenario(): void
    }
  }
}
