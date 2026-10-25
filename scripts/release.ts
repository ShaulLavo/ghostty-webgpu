import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ReleaseError,
  releasePackages,
  sourceCommit,
  validateReleaseArtifacts,
  writeReleaseManifest,
} from './release-artifacts'

const root = join(import.meta.dirname, '..')
const artifacts = join(root, '.artifacts')

async function run(command: string[], cwd = root): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' })
  const status = await child.exited
  if (status !== 0) throw new ReleaseError(`Release command exited with status ${status}`)
}

async function pack(): Promise<void> {
  await mkdir(artifacts, { recursive: true })
  for (const entry of await releasePackages(root)) {
    await run(
      ['bun', 'pm', 'pack', '--ignore-scripts', '--filename', join(artifacts, entry.filename)],
      entry.directory,
    )
  }
  await writeReleaseManifest(root, artifacts)
}

async function checkAddons(): Promise<void> {
  const consumer = await mkdtemp(join(tmpdir(), 'ghostty-release-'))
  try {
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    )
    const tarballs = (await releasePackages(root)).map((entry) => join(artifacts, entry.filename))
    await run(
      ['npm', 'install', '--dry-run=false', '--ignore-scripts', '--no-audit', '--no-fund'].concat(
        tarballs,
      ),
      consumer,
    )
    await copyFile(
      join(root, 'packages/line-editor/scripts/package-smoke.mjs'),
      join(consumer, 'line-editor.mjs'),
    )
    await copyFile(
      join(root, 'packages/shaders/scripts/package-smoke.mjs'),
      join(consumer, 'shaders.mjs'),
    )
    await copyFile(
      join(root, 'scripts/fixtures/release-consumer.ts.txt'),
      join(consumer, 'consumer.ts'),
    )
    await run(
      [
        'node',
        join(root, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--target',
        'ES2023',
        '--module',
        'ESNext',
        '--moduleResolution',
        'Bundler',
        '--lib',
        'ES2023,DOM',
        'consumer.ts',
      ],
      consumer,
    )
    await run(['node', 'line-editor.mjs'], consumer)
    await run(['node', 'shaders.mjs', '--installed'], consumer)
  } finally {
    await rm(consumer, { recursive: true, force: true })
  }
}

switch (process.argv[2]) {
  case 'pack':
    await pack()
    break
  case 'check':
    await validateReleaseArtifacts({ root, artifacts, commit: sourceCommit(root) })
    await run([
      'bun',
      'scripts/package-smoke.ts',
      '--browser',
      '--tarball',
      join(artifacts, 'ghostty-webgpu.tgz'),
    ])
    await checkAddons()
    await validateReleaseArtifacts({ root, artifacts, commit: sourceCommit(root) })
    break
  case 'validate': {
    const [directory, tag, commit] = process.argv.slice(3)
    if (!directory || !tag || !commit || process.argv.length !== 6) {
      throw new ReleaseError('Usage: bun scripts/release.ts validate <artifacts> <tag> <commit>')
    }
    await validateReleaseArtifacts({ root, artifacts: resolve(directory), tag, commit })
    break
  }
  default:
    throw new ReleaseError('Usage: bun scripts/release.ts pack|check|validate')
}
