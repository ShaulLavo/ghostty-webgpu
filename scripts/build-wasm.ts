import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GHOSTTY_UPSTREAM_REVISION } from '../src/core/version.js'

const upstreamRepository = 'https://github.com/ghostty-org/ghostty.git'
const upstreamRevision = GHOSTTY_UPSTREAM_REVISION
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

class ArtifactBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactBuildError'
  }
}

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, {
    cwd,
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await process.exited
  if (exitCode === 0) return
  throw new ArtifactBuildError(`${command[0]} exited with status ${exitCode}`)
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value) return value
  throw new ArtifactBuildError(`${name} requires a value`)
}

async function verifyZigVersion(zig: string): Promise<void> {
  const process = Bun.spawn([zig, 'version'], {
    stderr: 'inherit',
    stdout: 'pipe',
  })
  const version = (await new Response(process.stdout).text()).trim()
  const exitCode = await process.exited
  if (exitCode !== 0) throw new ArtifactBuildError('Unable to read the Zig version')
  const [major, minor] = version.split('.').map(Number)
  if (major === 0 && (minor ?? 0) >= 16) return
  if ((major ?? 0) > 0) return
  throw new ArtifactBuildError(
    `Ghostty ${upstreamRevision} requires Zig 0.16.0+, received ${version}`,
  )
}

async function checkoutSource(workspace: string): Promise<string> {
  const source = join(workspace, 'ghostty')
  await run(
    ['git', 'clone', '--filter=blob:none', '--no-checkout', upstreamRepository, source],
    workspace,
  )
  await run(['git', 'fetch', '--depth', '1', 'origin', upstreamRevision], source)
  await run(['git', 'checkout', '--detach', upstreamRevision], source)
  return source
}

async function verifyRevision(source: string): Promise<void> {
  const process = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    cwd: source,
    stderr: 'inherit',
    stdout: 'pipe',
  })
  const revision = (await new Response(process.stdout).text()).trim()
  const exitCode = await process.exited
  if (exitCode !== 0) throw new ArtifactBuildError('Unable to read the Ghostty source revision')
  if (revision === upstreamRevision) return
  throw new ArtifactBuildError(`Expected Ghostty ${upstreamRevision}, received ${revision}`)
}

async function validateWasm(path: string): Promise<void> {
  const bytes = await readFile(path)
  const magic = [...bytes.subarray(0, 4)]
  if (magic.join(',') === '0,97,115,109') return
  throw new ArtifactBuildError(`Generated file is not wasm: ${path}`)
}

async function buildArtifacts(source: string, workspace: string, zig: string): Promise<void> {
  await run(
    [zig, 'build', '-Demit-lib-vt=true', '-Dtarget=wasm32-freestanding', '-Doptimize=ReleaseSmall'],
    source,
  )
  const bridgeOutput = join(workspace, 'bridge.wasm')
  await run(
    [
      zig,
      'build-exe',
      join(projectRoot, 'scripts/bridge.zig'),
      '-target',
      'wasm32-freestanding',
      '-fno-entry',
      '-rdynamic',
      '-O',
      'ReleaseSmall',
      `-femit-bin=${bridgeOutput}`,
    ],
    projectRoot,
  )
  const terminalOutput = join(source, 'zig-out/bin/ghostty-vt.wasm')
  await validateWasm(terminalOutput)
  await validateWasm(bridgeOutput)
  await copyFile(terminalOutput, join(projectRoot, 'ghostty-vt.wasm'))
  await copyFile(bridgeOutput, join(projectRoot, 'bridge.wasm'))
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'ghostty-webgpu-'))
  try {
    const zig = argument('--zig') ?? 'zig'
    await verifyZigVersion(zig)
    const existingSource = argument('--source')
    const source = existingSource ?? (await checkoutSource(workspace))
    await verifyRevision(source)
    await buildArtifacts(source, workspace, zig)
    console.log(`Built libghostty-vt at ${upstreamRevision}`)
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }
}

await main()
