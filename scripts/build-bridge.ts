import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  if (magic.equals(Uint8Array.from([0, 97, 115, 109]))) return
  throw new BridgeBuildError(`Generated file is not wasm: ${path}`)
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'ghostty-webgpu-bridge-'))
  try {
    const output = join(workspace, 'bridge.wasm')
    const zig = argument('--zig') ?? 'zig'
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
