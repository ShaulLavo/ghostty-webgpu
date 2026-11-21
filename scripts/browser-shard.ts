import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserTestConfig } from '../vitest.browser.config.ts'

export const BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const
export type BrowserEngine = (typeof BROWSER_ENGINES)[number]

export interface EngineInvocation {
  readonly engine: BrowserEngine
  readonly command: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface EngineRunResult {
  readonly engine: BrowserEngine
  readonly phase: string
  readonly exitCode: number
  readonly durationMs: number
  readonly output: string
}

function readShardFlag(argv: readonly string[]): string | undefined {
  const inline = argv.find((arg) => arg.startsWith('--shard='))
  if (inline) return inline.slice('--shard='.length)
  const position = argv.indexOf('--shard')
  if (position < 0) return undefined
  return argv[position + 1]
}

export function parseShardSpec(argv: readonly string[]): {
  readonly index: number
  readonly total: number
} {
  const raw = readShardFlag(argv)
  const match = raw ? /^(\d+)\/(\d+)$/.exec(raw) : null
  if (!match) throw new Error('Usage: bun scripts/browser-shard.ts --shard=<index>/<total>')
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
  return { index, total }
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

export function splitShardHalves(files: readonly string[]): readonly [string[], string[]] {
  const first: string[] = []
  const second: string[] = []
  for (let index = 0; index < files.length; index++) {
    const target = index % 2 === 0 ? first : second
    target.push(files[index]!)
  }
  return [first, second]
}

export function engineInvocation(
  engine: BrowserEngine,
  files: readonly string[],
  cacheDir?: string,
): EngineInvocation {
  const baseCommand = ['bun', 'run', 'test:browser'].concat(files)
  // Firefox needs an X display to initialize Mesa WebGL, even in headless mode.
  const command = engine === 'firefox' ? ['xvfb-run', '-a'].concat(baseCommand) : baseCommand
  const env: Record<string, string> = { GHOSTTY_BROWSER_ENGINE: engine }
  if (cacheDir) env.GHOSTTY_BROWSER_CACHE_DIR = cacheDir
  return { engine, command, env }
}

async function runEngine(
  invocation: EngineInvocation,
  cwd: string,
  shardLabel: string,
  phase: string,
): Promise<EngineRunResult> {
  const started = performance.now()
  console.log(`[browser-shard ${shardLabel}] starting ${invocation.engine} (${phase})`)
  const child = Bun.spawn(Array.from(invocation.command), {
    cwd,
    env: { ...process.env, ...invocation.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const durationMs = Math.round(performance.now() - started)
  const separator = stdout && !stdout.endsWith('\n') ? '\n' : ''
  const output = stderr ? `${stdout}${separator}${stderr}` : stdout
  console.log(
    `[browser-shard ${shardLabel}] finished ${invocation.engine} (${phase}) exit=${exitCode} duration_ms=${durationMs}`,
  )
  return { engine: invocation.engine, phase, exitCode, durationMs, output }
}

async function runSequentialEngines(
  engines: readonly BrowserEngine[],
  files: readonly string[],
  cacheDirs: Readonly<Record<BrowserEngine, string>>,
  cwd: string,
  shardLabel: string,
  phase: string,
): Promise<EngineRunResult[]> {
  if (files.length === 0) return []
  const results: EngineRunResult[] = []
  for (const engine of engines) {
    results.push(
      await runEngine(engineInvocation(engine, files, cacheDirs[engine]), cwd, shardLabel, phase),
    )
  }
  return results
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

async function main(): Promise<void> {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const { index, total } = parseShardSpec(process.argv.slice(2))
  const shardLabel = `${index}/${total}`
  const allFiles = await discoverBrowserTestFiles(root)
  const files = selectShardFiles(allFiles, index, total)
  if (files.length === 0) throw new Error(`No browser test files assigned to shard ${shardLabel}`)
  const [halfA, halfB] = splitShardHalves(files)
  const cacheRoot = await mkdtemp(join(tmpdir(), `ghostty-browser-shard-${index}-`))
  const cacheDirs: Record<BrowserEngine, string> = {
    chromium: join(cacheRoot, 'vite-chromium'),
    firefox: join(cacheRoot, 'vite-firefox'),
    webkit: join(cacheRoot, 'vite-webkit'),
  }
  console.log(
    `[browser-shard ${shardLabel}] running ${files.length}/${allFiles.length} browser test files (${halfA.length}+${halfB.length}) across ${BROWSER_ENGINES.join(', ')}`,
  )
  try {
    // Disjoint halves let Chromium run alongside Firefox->WebKit with zero shared screenshot paths or Vite caches.
    const [phase1Chromium, phase1Others] = await Promise.all([
      runEngine(
        engineInvocation('chromium', halfA, cacheDirs.chromium),
        root,
        shardLabel,
        'half-a',
      ),
      runSequentialEngines(['firefox', 'webkit'], halfB, cacheDirs, root, shardLabel, 'half-b'),
    ])
    const [phase2Chromium, phase2Others] = await Promise.all([
      halfB.length > 0
        ? runEngine(
            engineInvocation('chromium', halfB, cacheDirs.chromium),
            root,
            shardLabel,
            'half-b',
          )
        : Promise.resolve(undefined),
      runSequentialEngines(['firefox', 'webkit'], halfA, cacheDirs, root, shardLabel, 'half-a'),
    ])
    const results = [phase1Chromium].concat(
      phase2Chromium ? [phase2Chromium] : [],
      phase1Others,
      phase2Others,
    )
    reportResults(results, shardLabel)
    const failed = results.find((result) => result.exitCode !== 0)
    if (failed) process.exitCode = failed.exitCode
  } finally {
    await rm(cacheRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
