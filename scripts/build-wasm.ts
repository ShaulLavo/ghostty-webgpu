import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GHOSTTY_SOURCE_REPOSITORY, GHOSTTY_SOURCE_REVISION } from '../src/core/version.js'

import { ArtifactBuildError, verifyCleanSource, verifyRevision } from './ghostty-source.js'
import { GHOSTTY_VT_EXPORTS } from './ghostty-vt-exports.js'
import { trimWasmExports } from './wasm-exports.js'
import {
  recordWasmProvenance,
  TERMINAL_BUILD_ARGS,
  WASM_OPT,
  WASM_OPT_FLAGS,
} from './wasm-provenance.js'

const sourceRepository = GHOSTTY_SOURCE_REPOSITORY
const sourceRevision = GHOSTTY_SOURCE_REVISION
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

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
    `Ghostty ${sourceRevision} requires Zig 0.16.0+, received ${version}`,
  )
}

async function checkoutSource(workspace: string): Promise<string> {
  const source = join(workspace, 'ghostty')
  await run(
    ['git', 'clone', '--filter=blob:none', '--no-checkout', sourceRepository, source],
    workspace,
  )
  await run(['git', 'fetch', '--depth', '1', 'origin', sourceRevision], source)
  await run(['git', 'checkout', '--detach', sourceRevision], source)
  return source
}

async function validateWasm(path: string): Promise<void> {
  const bytes = await readFile(path)
  const magic = [...bytes.subarray(0, 4)]
  if (magic.join(',') === '0,97,115,109') return
  throw new ArtifactBuildError(`Generated file is not wasm: ${path}`)
}

async function buildArtifacts(source: string, workspace: string, zig: string): Promise<void> {
  await run([zig].concat(TERMINAL_BUILD_ARGS), source)
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
      '--import-memory',
      '--export=__stack_pointer',
      '--stack',
      '65536',
      '-I',
      join(source, 'include'),
      '-O',
      'ReleaseSmall',
      `-femit-bin=${bridgeOutput}`,
    ],
    projectRoot,
  )
  const terminalOutput = join(source, 'zig-out/bin/ghostty-vt.wasm')
  await validateWasm(terminalOutput)
  await validateWasm(bridgeOutput)
  const trimmedTerminal = join(workspace, 'ghostty-vt.trimmed.wasm')
  const keep = new Set<string>(GHOSTTY_VT_EXPORTS)
  await writeFile(trimmedTerminal, trimWasmExports(await readFile(terminalOutput), keep))
  await optimizeWasm(trimmedTerminal, join(projectRoot, 'ghostty-vt.wasm'))
  await optimizeWasm(bridgeOutput, join(projectRoot, 'bridge.wasm'))
}

// Post-link only: the Ghostty source stays unpatched. Features match what Zig emits for wasm32.
async function optimizeWasm(input: string, output: string): Promise<void> {
  await run([WASM_OPT, input].concat(WASM_OPT_FLAGS, ['-o', output]), projectRoot)
  await validateWasm(output)
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'ghostty-webgpu-'))
  try {
    const zig = argument('--zig') ?? 'zig'
    await verifyZigVersion(zig)
    const existingSource = argument('--source')
    const source = existingSource ?? (await checkoutSource(workspace))
    await verifyRevision(source)
    await verifyCleanSource(source)
    await buildArtifacts(source, workspace, zig)
    await recordWasmProvenance(source, zig)
    console.log(`Built libghostty-vt at ${sourceRevision}`)
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }
}

await main()
