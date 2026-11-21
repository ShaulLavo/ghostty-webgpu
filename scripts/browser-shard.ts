import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserTestConfig } from '../vitest.browser.config.ts'

export const BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const
export type BrowserEngine = (typeof BROWSER_ENGINES)[number]

export const SHARD_RUN_ID_ENV = 'GHOSTTY_BROWSER_SHARD_RUN_ID'

// Cap SwiftShader Chromium to two concurrent processes so 4-vCPU runners stay stable.
export const MAX_ENGINE_CONCURRENCY: Readonly<Record<BrowserEngine, number>> = {
  chromium: 2,
  firefox: 3,
  webkit: 3,
}

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
  options?: { readonly cacheDir?: string; readonly apiPort?: number; readonly runId?: string },
): EngineInvocation {
  const baseCommand = ['bun', 'run', 'test:browser'].concat(files)
  // Firefox needs an X display to initialize Mesa WebGL, even in headless mode.
  const command = engine === 'firefox' ? ['xvfb-run', '-a'].concat(baseCommand) : baseCommand
  const env: Record<string, string> = { GHOSTTY_BROWSER_ENGINE: engine }
  if (options?.cacheDir) env.GHOSTTY_BROWSER_CACHE_DIR = options.cacheDir
  if (options?.apiPort) env.GHOSTTY_BROWSER_API_PORT = String(options.apiPort)
  if (options?.runId) env[SHARD_RUN_ID_ENV] = options.runId
  return { engine, command, env }
}

function sendSignal(pid: number, signal: NodeJS.Signals, asGroup: boolean): void {
  try {
    process.kill(asGroup && process.platform !== 'win32' ? -pid : pid, signal)
  } catch {
    // Ignore ESRCH when the process or its group has already exited.
  }
}

export async function findTaggedPids(envKey: string, token: string): Promise<number[]> {
  if (process.platform !== 'linux') return []
  const marker = `${envKey}=${token}`
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return []
  }
  const matches: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    if (pid === process.pid) continue
    try {
      const environ = await readFile(`/proc/${pid}/environ`, 'utf8')
      if (environ.split('\0').includes(marker)) matches.push(pid)
    } catch {
      // Ignore processes that exited or belong to another user.
    }
  }
  return matches
}

interface ProcessEntry {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
}

async function listProcessEntries(): Promise<ProcessEntry[]> {
  if (process.platform !== 'linux') return []
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return []
  }
  const result: ProcessEntry[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      if (close < 0) continue
      const fields = stat.slice(close + 2).split(' ')
      const ppid = Number(fields[1])
      const pgid = Number(fields[2])
      if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) continue
      result.push({ pid: Number(entry), ppid, pgid })
    } catch {
      // Ignore processes that exited between readdir and readFile.
    }
  }
  return result
}

export async function collectDescendantPids(
  rootPids: readonly number[],
  runId: string,
): Promise<{ readonly pids: Set<number>; readonly pgids: Set<number> }> {
  const entries = await listProcessEntries()
  const childrenByParent = new Map<number, ProcessEntry[]>()
  const byPid = new Map<number, ProcessEntry>()
  for (const entry of entries) {
    byPid.set(entry.pid, entry)
    const list = childrenByParent.get(entry.ppid)
    if (list) list.push(entry)
    else childrenByParent.set(entry.ppid, [entry])
  }
  const tagged = await findTaggedPids(SHARD_RUN_ID_ENV, runId)
  const queue = rootPids.concat(tagged)
  const pids = new Set<number>()
  const pgids = new Set<number>()
  const ownPgid = byPid.get(process.pid)?.pgid
  while (queue.length > 0) {
    const pid = queue.pop()!
    if (pid === process.pid || pids.has(pid)) continue
    pids.add(pid)
    const entry = byPid.get(pid)
    if (entry && entry.pgid !== ownPgid) pgids.add(entry.pgid)
    const kids = childrenByParent.get(pid) ?? []
    for (const kid of kids) queue.push(kid.pid)
  }
  return { pids, pgids }
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

async function mergeLiveTargets(
  direct: readonly ChildProcess[],
  runId: string,
  trackedPids: Set<number>,
  trackedPgids: Set<number>,
): Promise<number[]> {
  const roots = direct
    .map((child) => child.pid)
    .filter((pid): pid is number => pid !== undefined)
    .concat(Array.from(trackedPids))
  const snapshot = await collectDescendantPids(roots, runId)
  for (const pid of snapshot.pids) trackedPids.add(pid)
  for (const pgid of snapshot.pgids) trackedPgids.add(pgid)
  return Array.from(trackedPids).filter(pidExists)
}

async function waitForAllGone(
  direct: readonly ChildProcess[],
  runId: string,
  trackedPids: Set<number>,
  trackedPgids: Set<number>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const alivePids = await mergeLiveTargets(direct, runId, trackedPids, trackedPgids)
    if (!direct.some(isAlive) && alivePids.length === 0) return true
    await sleep(50)
  }
  const alivePids = await mergeLiveTargets(direct, runId, trackedPids, trackedPgids)
  return !direct.some(isAlive) && alivePids.length === 0
}

export async function terminateRunProcesses(
  children: ReadonlySet<ChildProcess>,
  runId: string,
  signal: NodeJS.Signals,
  graceMs = 3000,
): Promise<void> {
  const direct = Array.from(children)
  const trackedPids = new Set<number>()
  const trackedPgids = new Set<number>()
  // Snapshot full ppid/pgid tree BEFORE signalling parents so detached Playwright browsers are tracked.
  const initialAlive = await mergeLiveTargets(direct, runId, trackedPids, trackedPgids)
  for (const pgid of trackedPgids) sendSignal(pgid, signal, true)
  for (const pid of initialAlive) sendSignal(pid, signal, false)
  const exited = await waitForAllGone(direct, runId, trackedPids, trackedPgids, graceMs)
  if (exited) return
  const remaining = await mergeLiveTargets(direct, runId, trackedPids, trackedPgids)
  for (const pgid of trackedPgids) sendSignal(pgid, 'SIGKILL', true)
  for (const pid of remaining) sendSignal(pid, 'SIGKILL', false)
  await waitForAllGone(direct, runId, trackedPids, trackedPgids, 2000)
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
        // Detached gives each invocation its own process group so signals reap xvfb-run and descendants.
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
  activeByEngine: ReadonlyMap<BrowserEngine, number>,
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
    const runningForEngine = activeByEngine.get(task.engine) ?? 0
    if (runningForEngine >= MAX_ENGINE_CONCURRENCY[task.engine]) continue
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

interface SchedulerState {
  readonly cwd: string
  readonly shardLabel: string
  readonly cacheRoot: string
  readonly runId?: string
  readonly runner: InvocationRunner
  readonly isCancelled: () => boolean
  readonly log: (line: string) => void
  readonly pending: ScheduledTask[]
  readonly activeSlices: Set<number>
  readonly activeByEngine: Map<BrowserEngine, number>
  readonly results: EngineRunResult[]
  readonly waiters: Array<() => void>
  failed: unknown
}

function notifyWaiters(state: SchedulerState): void {
  const callbacks = state.waiters.splice(0, state.waiters.length)
  for (const notify of callbacks) notify()
}

function waitForChange(state: SchedulerState): Promise<void> {
  return new Promise((resolve) => state.waiters.push(resolve))
}

async function runSingleTask(
  state: SchedulerState,
  task: ScheduledTask,
  workerSlot: number,
): Promise<void> {
  const cacheDir = join(state.cacheRoot, `vite-w${workerSlot}-${task.engine}`)
  const apiPort = 63315 + workerSlot * 20
  const invocation = engineInvocation(task.engine, task.files, {
    cacheDir,
    apiPort,
    runId: state.runId,
  })
  const started = performance.now()
  state.log(`[browser-shard ${state.shardLabel}] starting ${task.engine} (${task.phase})`)
  try {
    const { exitCode, output } = await state.runner(invocation, {
      cwd: state.cwd,
      shardLabel: state.shardLabel,
      phase: task.phase,
      sliceIndex: task.sliceIndex,
      workerSlot,
    })
    const durationMs = Math.round(performance.now() - started)
    state.log(
      `[browser-shard ${state.shardLabel}] finished ${task.engine} (${task.phase}) exit=${exitCode} duration_ms=${durationMs}`,
    )
    state.results.push({
      engine: task.engine,
      sliceIndex: task.sliceIndex,
      phase: task.phase,
      exitCode,
      durationMs,
      output,
    })
  } catch (error) {
    if (!state.failed) state.failed = error
    throw error
  } finally {
    state.activeSlices.delete(task.sliceIndex)
    state.activeByEngine.set(task.engine, (state.activeByEngine.get(task.engine) ?? 1) - 1)
    notifyWaiters(state)
  }
}

async function runWorkerLoop(state: SchedulerState, workerSlot: number): Promise<void> {
  while (!state.failed && !state.isCancelled()) {
    const task = pickNextTask(state.pending, state.activeSlices, state.activeByEngine)
    if (task) {
      state.activeSlices.add(task.sliceIndex)
      state.activeByEngine.set(task.engine, (state.activeByEngine.get(task.engine) ?? 0) + 1)
      await runSingleTask(state, task, workerSlot)
      continue
    }
    if (state.pending.length === 0 || state.activeSlices.size === 0) return
    await waitForChange(state)
  }
}

export async function runBrowserShard(options: {
  readonly cwd: string
  readonly index: number
  readonly total: number
  readonly slices: number
  readonly workers: number
  readonly files: readonly string[]
  readonly cacheRoot: string
  readonly runId?: string
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
  const maxWorkers = Math.min(options.workers, slices.length)
  log(
    `[browser-shard ${shardLabel}] running ${selected.length}/${options.files.length} browser test files across ${slices.length} disjoint slices (${maxWorkers} workers) on ${BROWSER_ENGINES.join(', ')}`,
  )
  const state: SchedulerState = {
    cwd: options.cwd,
    shardLabel,
    cacheRoot: options.cacheRoot,
    runId: options.runId,
    runner: options.runner,
    isCancelled: options.isCancelled ?? (() => false),
    log,
    pending: buildTasks(slices),
    activeSlices: new Set<number>(),
    activeByEngine: new Map<BrowserEngine, number>(),
    results: [],
    waiters: [],
    failed: undefined,
  }
  const workerPromises = Array.from({ length: maxWorkers }, (_, slot) => runWorkerLoop(state, slot))
  await Promise.all(workerPromises)
  const firstFailure = state.results.find((result) => result.exitCode !== 0)
  return { results: state.results, exitCode: firstFailure ? firstFailure.exitCode : 0 }
}

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const parsed = parseShardSpec(process.argv.slice(2))
  const shardLabel = `${parsed.index}/${parsed.total}`
  const allFiles = await discoverBrowserTestFiles(root)
  const cacheRoot = await mkdtemp(join(tmpdir(), `ghostty-browser-shard-${parsed.index}-`))
  const runId = `${process.pid}-${randomBytes(6).toString('hex')}`
  const activeChildren = new Set<ChildProcess>()
  let cancelledSignal: NodeJS.Signals | undefined
  let cleanupPromise: Promise<void> | undefined

  const cleanup = async (signal?: NodeJS.Signals): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      await terminateRunProcesses(activeChildren, runId, signal ?? 'SIGTERM')
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
      runId,
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
