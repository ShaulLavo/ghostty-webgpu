import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyCleanSource, verifyRevision } from './ghostty-source.js'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

class BridgeBuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeBuildError'
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value) return value
  throw new BridgeBuildError(`${name} requires a value`)
}

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stderr: 'inherit',
    stdout: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode === 0) return
  throw new BridgeBuildError(`${command[0]} exited with status ${exitCode}`)
}

async function validateWasm(path: string): Promise<void> {
  const bytes = await readFile(path)
  const magic = bytes.subarray(0, 4)
  if (!magic.equals(Uint8Array.from([0, 97, 115, 109]))) {
    throw new BridgeBuildError(`Generated file is not wasm: ${path}`)
  }
  const module = await WebAssembly.compile(bytes)
  const exports = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name))
  for (const name of [
    'bridge_read_rows',
    'bridge_read_text_rows',
    'bridge_build_frame',
    'bridge_register_glyph',
    'bridge_create_glyph_index',
    'bridge_destroy_glyph_index',
    'bridge_clear_glyphs',
  ]) {
    if (exports.has(name)) continue
    throw new BridgeBuildError(`Generated bridge is missing export: ${name}`)
  }
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'ghostty-webgpu-bridge-'))
  try {
    const output = join(workspace, 'bridge.wasm')
    const zig = argument('--zig') ?? 'zig'
    const sourceArgument = argument('--source')
    if (!sourceArgument) throw new BridgeBuildError('--source requires the pinned Ghostty checkout')
    const source = resolve(sourceArgument)
    await verifyRevision(source)
    await verifyCleanSource(source)
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
        `-femit-bin=${output}`,
      ],
      projectRoot,
    )
    await validateWasm(output)
    await copyFile(output, join(projectRoot, 'bridge.wasm'))
  } finally {
    await rm(workspace, { force: true, recursive: true })
  }
}

await main()
