import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserTestConfig } from '../vitest.browser.config.ts'

export const BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const
export type BrowserEngine = (typeof BROWSER_ENGINES)[number]

const ENGINE_WEIGHT: Readonly<Record<BrowserEngine, number>> = {
  chromium: 100,
  firefox: 58,
  webkit: 44,
}

export interface ShardCliOptions {
  readonly index: number
  readonly total: number
  readonly slices: number
  readonly workers: number
}

export interface EngineInvocation {
  readonly engine: BrowserEngine
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface EngineRunResult {
  readonly engine: BrowserEngine
  readonly sliceIndex: number
  readonly phase: string
  readonly exitCode: number
  readonly durationMs: number
  readonly output: string
}

export type InvocationRunner = (
  invocation: EngineInvocation,
  meta: {
    readonly cwd: string
    readonly shardLabel: string
    readonly phase: string
    readonly sliceIndex: number
    readonly workerSlot: number
  },
) => Promise<{ readonly exitCode: number; readonly output: string }>

interface ScheduledTask {
  readonly sliceIndex: number
  readonly phase: string
  readonly engine: BrowserEngine
  readonly files: readonly string[]
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`
  const inline = argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const position = argv.indexOf(name)
  if (position < 0) return undefined
  return argv[position + 1]
}

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid ${name} value: ${raw}`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name} value: ${raw}`)
  return value
}

export function parseShardSpec(argv: readonly string[]): ShardCliOptions {
  const raw = readFlag(argv, '--shard')
  const match = raw ? /^(\d+)\/(\d+)$/.exec(raw) : null
  if (!match) {
    throw new Error(
      'Usage: bun scripts/browser-shard.ts --shard=<index>/<total> [--slices=<n>] [--workers=<n>]',
    )
  }
  const index = Number(match[1])
  const total = Number(match[2])
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total < 1 ||
    index < 1 ||
    index > total
  ) {
    throw new Error(`Invalid shard specification: ${raw}`)
  }
  const defaultSlices = total === 1 ? 6 : 2
  const defaultWorkers = total === 1 ? 3 : 2
  const slices = parsePositiveInteger(readFlag(argv, '--slices'), defaultSlices, '--slices')
  const workers = parsePositiveInteger(readFlag(argv, '--workers'), defaultWorkers, '--workers')
  return { index, total, slices, workers }
}

async function walkMatchingSuffix(
  root: string,
  relativeDir: string,
  suffix: string,
  out: Set<string>,
): Promise<void> {
  const entries = await readdir(join(root, relativeDir), { withFileTypes: true })
  for (const entry of entries) {
    const child = `${relativeDir}/${entry.name}`
    if (entry.isDirectory()) {
      await walkMatchingSuffix(root, child, suffix, out)
      continue
    }
    if (entry.isFile() && entry.name.endsWith(suffix)) out.add(child)
  }
}

export async function discoverBrowserTestFiles(root: string): Promise<string[]> {
  const patterns = createBrowserTestConfig().test.include
  const found = new Set<string>()
  for (const pattern of patterns) {
    const match = /^(.+)\/\*\*\/\*(\.[^/]+)$/.exec(pattern)
    if (!match) throw new Error(`Unsupported browser test include pattern: ${pattern}`)
    await walkMatchingSuffix(root, match[1]!, match[2]!, found)
  }
  return Array.from(found).sort()
}

export function selectShardFiles(
  files: readonly string[],
  shardIndex: number,
  shardTotal: number,
): string[] {
  if (shardTotal < 1 || shardIndex < 1 || shardIndex > shardTotal) {
    throw new Error(`Invalid shard ${shardIndex}/${shardTotal}`)
  }
  // Round-robin interleaving mixes fast and slow directories evenly across shards.
  return files.filter((_, index) => index % shardTotal === shardIndex - 1)
}

export function partitionSlices(files: readonly string[], count: number): string[][] {
  if (count < 1) throw new Error(`Invalid slice count: ${count}`)
  const bucketCount = Math.min(count, files.length)
  const buckets = Array.from({ length: bucketCount }, () => [] as string[])
  for (let index = 0; index < files.length; index++) {
    buckets[index % bucketCount]!.push(files[index]!)
  }
  return buckets
}

export function engineInvocation(
  engine: BrowserEngine,
  files: readonly string[],
  options?: { readonly cacheDir?: string; readonly apiPort?: number },
): EngineInvocation {
  const baseCommand = ['bun', 'run', 'test:browser'].concat(files)
  // Firefox needs an X display to initialize Mesa WebGL, even in headless mode.
  const command = engine === 'firefox' ? ['xvfb-run', '-a'].concat(baseCommand) : baseCommand
  const env: Record<string, string> = { GHOSTTY_BROWSER_ENGINE: engine }
  if (options?.cacheDir) env.GHOSTTY_BROWSER_CACHE_DIR = options.cacheDir
  if (options?.apiPort) env.GHOSTTY_BROWSER_API_PORT = String(options.apiPort)
  return { engine, command, env }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid) return
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal)
    else child.kill(signal)
  } catch {
    // Ignore ESRCH when the process or its group has already exited.
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    child.once('close', () => resolve())
  })
}

async function terminateChildren(
  children: ReadonlySet<ChildProcess>,
  signal: NodeJS.Signals,
): Promise<void> {
  const active = Array.from(children)
  if (active.length === 0) return
  for (const child of active) signalProcessGroup(child, signal)
  const settled = Promise.all(active.map(waitForExit))
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), 3000)
  })
  const outcome = await Promise.race([settled.then(() => 'exited' as const), grace])
  if (timer) clearTimeout(timer)
  if (outcome === 'exited') return
  for (const child of active) signalProcessGroup(child, 'SIGKILL')
  await settled
}

function createSpawnRunner(activeChildren: Set<ChildProcess>): InvocationRunner {
  return (invocation, meta) =>
    new Promise((resolve, reject) => {
      const [executable, ...args] = invocation.command
      if (!executable) {
        reject(new Error('Empty browser command'))
        return
      }
      const child = spawn(executable, args, {
        cwd: meta.cwd,
        env: { ...process.env, ...invocation.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Detached gives each invocation its own process group so signals reap xvfb-run and browser descendants.
        detached: process.platform !== 'win32',
      })
      activeChildren.add(child)
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
      child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
      child.once('error', (error) => {
        activeChildren.delete(child)
        reject(error)
      })
      child.once('close', (code, signal) => {
        activeChildren.delete(child)
        const stdout = Buffer.concat(stdoutChunks).toString('utf8')
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        const separator = stdout && !stdout.endsWith('\n') ? '\n' : ''
        const output = stderr ? `${stdout}${separator}${stderr}` : stdout
        const exitCode = code ?? (signal ? 128 : 1)
        resolve({ exitCode, output })
      })
    })
}

function buildTasks(slices: readonly (readonly string[])[]): ScheduledTask[] {
  const tasks: ScheduledTask[] = []
  for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex++) {
    const files = slices[sliceIndex]!
    if (files.length === 0) continue
    for (const engine of BROWSER_ENGINES) {
      tasks.push({ sliceIndex, phase: `slice-${sliceIndex + 1}`, engine, files })
    }
  }
  return tasks
}

function pickNextTask(
  pending: ScheduledTask[],
  activeSlices: ReadonlySet<number>,
): ScheduledTask | undefined {
  const remainingWeight = new Map<number, number>()
  for (const task of pending) {
    if (activeSlices.has(task.sliceIndex)) continue
    remainingWeight.set(
      task.sliceIndex,
      (remainingWeight.get(task.sliceIndex) ?? 0) + ENGINE_WEIGHT[task.engine],
    )
  }
  let bestIndex = -1
  let bestSliceWeight = -1
  let bestEngineWeight = -1
  for (let index = 0; index < pending.length; index++) {
    const task = pending[index]!
    const sliceWeight = remainingWeight.get(task.sliceIndex)
    if (sliceWeight === undefined) continue
    const engineWeight = ENGINE_WEIGHT[task.engine]
    const beatsSlice = sliceWeight > bestSliceWeight
    const tiesSlice = sliceWeight === bestSliceWeight && engineWeight > bestEngineWeight
    if (!beatsSlice && !tiesSlice) continue
    bestIndex = index
    bestSliceWeight = sliceWeight
    bestEngineWeight = engineWeight
  }
  if (bestIndex < 0) return undefined
  return pending.splice(bestIndex, 1)[0]
}

function reportResults(results: readonly EngineRunResult[], shardLabel: string): void {
  for (const result of results) {
    console.log(
      `::group::browser (${result.engine}, ${shardLabel}, ${result.phase}) exit=${result.exitCode} (${(result.durationMs / 1000).toFixed(1)}s)`,
    )
    if (result.output) process.stdout.write(result.output)
    if (result.output && !result.output.endsWith('\n')) process.stdout.write('\n')
    console.log('::endgroup::')
  }
  const summary = results
    .map(
      (result) =>
        `${result.engine}/${result.phase}=${result.exitCode}(${(result.durationMs / 1000).toFixed(1)}s)`,
    )
    .join(' ')
  console.log(`[browser-shard ${shardLabel}] summary: ${summary}`)
}

export async function runBrowserShard(options: {
  readonly cwd: string
  readonly index: number
  readonly total: number
  readonly slices: number
  readonly workers: number
  readonly files: readonly string[]
  readonly cacheRoot: string
  readonly runner: InvocationRunner
  readonly isCancelled?: () => boolean
  readonly log?: (line: string) => void
}): Promise<{ readonly results: EngineRunResult[]; readonly exitCode: number }> {
  const shardLabel = `${options.index}/${options.total}`
  const log = options.log ?? console.log
  const selected = selectShardFiles(options.files, options.index, options.total)
  if (selected.length === 0)
    throw new Error(`No browser test files assigned to shard ${shardLabel}`)
  const slices = partitionSlices(selected, options.slices)
  const pending = buildTasks(slices)
  const activeSlices = new Set<number>()
  const results: EngineRunResult[] = []
  const maxWorkers = Math.min(options.workers, slices.length)
  log(
    `[browser-shard ${shardLabel}] running ${selected.length}/${options.files.length} browser test files across ${slices.length} disjoint slices (${maxWorkers} workers) on ${BROWSER_ENGINES.join(', ')}`,
  )
  await new Promise<void>((resolve, reject) => {
    let activeCount = 0
    let failed: unknown
    const launch = (workerSlot: number): void => {
      if (failed || options.isCancelled?.()) {
        if (activeCount === 0) resolve()
        return
      }
      const task = pickNextTask(pending, activeSlices)
      if (!task) {
        if (activeCount === 0) resolve()
        return
      }
      activeCount++
      activeSlices.add(task.sliceIndex)
      const cacheDir = join(options.cacheRoot, `vite-w${workerSlot}-${task.engine}`)
      const apiPort = 63315 + workerSlot * 20
      const invocation = engineInvocation(task.engine, task.files, { cacheDir, apiPort })
      const started = performance.now()
      log(`[browser-shard ${shardLabel}] starting ${task.engine} (${task.phase})`)
      void options
        .runner(invocation, {
          cwd: options.cwd,
          shardLabel,
          phase: task.phase,
          sliceIndex: task.sliceIndex,
          workerSlot,
        })
        .then(
          ({ exitCode, output }) => {
            const durationMs = Math.round(performance.now() - started)
            log(
              `[browser-shard ${shardLabel}] finished ${task.engine} (${task.phase}) exit=${exitCode} duration_ms=${durationMs}`,
            )
            results.push({
              engine: task.engine,
              sliceIndex: task.sliceIndex,
              phase: task.phase,
              exitCode,
              durationMs,
              output,
            })
            activeSlices.delete(task.sliceIndex)
            activeCount--
            launch(workerSlot)
          },
          (error) => {
            activeSlices.delete(task.sliceIndex)
            activeCount--
            if (!failed) {
              failed = error
              reject(error)
            }
          },
        )
    }
    for (let slot = 0; slot < maxWorkers; slot++) launch(slot)
  })
  const firstFailure = results.find((result) => result.exitCode !== 0)
  return { results, exitCode: firstFailure ? firstFailure.exitCode : 0 }
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const parsed = parseShardSpec(process.argv.slice(2))
  const shardLabel = `${parsed.index}/${parsed.total}`
  const allFiles = await discoverBrowserTestFiles(root)
  const cacheRoot = await mkdtemp(join(tmpdir(), `ghostty-browser-shard-${parsed.index}-`))
  const activeChildren = new Set<ChildProcess>()
  let cancelledSignal: NodeJS.Signals | undefined
  let cleanupPromise: Promise<void> | undefined

  const cleanup = async (signal?: NodeJS.Signals): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      if (activeChildren.size > 0) await terminateChildren(activeChildren, signal ?? 'SIGTERM')
      await rm(cacheRoot, { recursive: true, force: true })
    })()
    return cleanupPromise
  }

  const onSignal = (signal: NodeJS.Signals): void => {
    if (cancelledSignal) return
    cancelledSignal = signal
    const code = signal === 'SIGINT' ? 130 : 143
    void cleanup(signal).finally(() => process.exit(code))
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    const { results, exitCode } = await runBrowserShard({
      cwd: root,
      index: parsed.index,
      total: parsed.total,
      slices: parsed.slices,
      workers: parsed.workers,
      files: allFiles,
      cacheRoot,
      runner: createSpawnRunner(activeChildren),
      isCancelled: () => cancelledSignal !== undefined,
    })
    if (cancelledSignal) return
    reportResults(results, shardLabel)
    if (exitCode !== 0) process.exitCode = exitCode
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await cleanup(cancelledSignal)
  }
}

if (import.meta.main) await main()
