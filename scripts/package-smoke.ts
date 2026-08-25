import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

class PackageSmokeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackageSmokeError'
  }
}

async function run(command: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd,
    stderr: 'inherit',
    stdout: 'pipe',
  })
  const stdout = await new Response(child.stdout).text()
  const exitCode = await child.exited
  if (exitCode === 0) return stdout.trim()
  throw new PackageSmokeError(`${command[0]} exited with status ${exitCode}\n${stdout.trim()}`)
}

function readPackFilename(output: string): string {
  if (!output.startsWith('[')) return output

  let result: unknown
  try {
    result = JSON.parse(output)
  } catch {
    throw new PackageSmokeError('npm pack returned invalid JSON')
  }

  if (!Array.isArray(result) || result.length !== 1) {
    throw new PackageSmokeError('npm pack returned an unexpected result')
  }

  const entry: unknown = result[0]
  if (typeof entry !== 'object' || entry === null) {
    throw new PackageSmokeError('npm pack result is missing package metadata')
  }

  const filename = (entry as { filename?: unknown }).filename
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new PackageSmokeError('npm pack result is missing a filename')
  }
  return filename
}

async function requirePath(path: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new PackageSmokeError(`Packed package is missing ${path}`)
  }
}

async function rejectPath(path: string): Promise<void> {
  try {
    await access(path)
  } catch {
    return
  }
  throw new PackageSmokeError(`Packed package contains stale output ${path}`)
}

async function writeConsumerFiles(root: string): Promise<void> {
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'ghostty-webgpu-package-smoke', private: true, type: 'module' }, null, 2)}\n`,
  )
  await writeFile(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2023', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2023',
        },
        include: ['index.ts'],
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(root, 'index.ts'),
    `import { GhosttyWebGpuTerminal, Terminal } from 'ghostty-webgpu'\n\nvoid GhosttyWebGpuTerminal\nvoid Terminal\n`,
  )
}

async function verifyInstalledPackage(root: string): Promise<void> {
  const packageRoot = join(root, 'node_modules/ghostty-webgpu')
  await requirePath(join(packageRoot, 'dist/index.js'))
  await requirePath(join(packageRoot, 'ghostty-vt.wasm'))
  await requirePath(join(packageRoot, 'bridge.wasm'))
  await rejectPath(join(packageRoot, 'dist/xterm/operation-queue.js'))
  await rejectPath(join(packageRoot, 'dist/render/shaders/background.wgsl.js'))
  await run([join(projectRoot, 'node_modules/.bin/tsc'), '--project', 'tsconfig.json'], root)
  await run(
    [
      'node',
      join(projectRoot, 'node_modules/typescript-legacy/bin/tsc'),
      '--project',
      'tsconfig.json',
    ],
    root,
  )
  await run(
    [
      'node',
      '--input-type=module',
      '--eval',
      `import { GhosttyRuntime, GhosttyWebGpuTerminal, Terminal } from 'ghostty-webgpu'
if (!GhosttyWebGpuTerminal || !Terminal) throw new Error('missing public terminal exports')
const runtime = await GhosttyRuntime.create()
runtime.dispose()`,
    ],
    root,
  )
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'ghostty-webgpu-package-'))
  try {
    const packRoot = join(workspace, 'pack')
    const consumerRoot = join(workspace, 'consumer')
    await mkdir(packRoot)
    await mkdir(consumerRoot)
    await writeConsumerFiles(consumerRoot)
    const packOutput = await run(
      ['npm', 'pack', '--silent', '--dry-run=false', '--pack-destination', packRoot],
      projectRoot,
    )
    const filename = readPackFilename(packOutput)
    const tarball = join(packRoot, filename)
    await run(
      ['npm', 'install', '--dry-run=false', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      consumerRoot,
    )
    await verifyInstalledPackage(consumerRoot)
    console.log(`Verified packed consumer ${filename}`)
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }
}

await main()
