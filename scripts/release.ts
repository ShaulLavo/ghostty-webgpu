import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const artifacts = join(root, '.artifacts')
const packages = [
  { directory: root, name: 'ghostty-webgpu' },
  { directory: join(root, 'packages/line-editor'), name: 'ghostty-webgpu-line-editor' },
  { directory: join(root, 'packages/shaders'), name: 'ghostty-webgpu-shaders' },
]

class ReleaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseError'
  }
}

async function run(command: string[], cwd = root): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' })
  const status = await child.exited
  if (status !== 0) throw new ReleaseError(`Release command exited with status ${status}`)
}

async function pack(): Promise<void> {
  await mkdir(artifacts, { recursive: true })
  for (const entry of packages) {
    await run(
      ['bun', 'pm', 'pack', '--ignore-scripts', '--filename', join(artifacts, `${entry.name}.tgz`)],
      entry.directory,
    )
  }
}

switch (process.argv[2]) {
  case 'pack':
    await pack()
    break
  case 'check':
    await run([
      'bun',
      'scripts/package-smoke.ts',
      '--browser',
      '--tarball',
      join(artifacts, 'ghostty-webgpu.tgz'),
    ])
    break
  default:
    throw new ReleaseError('Usage: bun scripts/release.ts pack|check')
}
