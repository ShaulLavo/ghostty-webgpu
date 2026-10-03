import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GHOSTTY_SOURCE_REVISION } from '../../src/core/version.js'
import { ArtifactBuildError, verifyCleanSource } from '../ghostty-source.js'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value) return value
  throw new ArtifactBuildError(`${name} requires a value`)
}

const sourceArgument = argument('--source')
if (!sourceArgument)
  throw new ArtifactBuildError('--source requires a pristine official Ghostty checkout')
const source = resolve(sourceArgument)
await verifyCleanSource(source)
const revisionProcess = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
  cwd: source,
  stdout: 'pipe',
  stderr: 'inherit',
})
const revision = (await new Response(revisionProcess.stdout).text()).trim()
if ((await revisionProcess.exited) !== 0)
  throw new ArtifactBuildError('Unable to read source revision')
const expectedRevision = argument('--revision') ?? GHOSTTY_SOURCE_REVISION
if (revision !== expectedRevision) {
  throw new ArtifactBuildError(`Expected Ghostty ${expectedRevision}, received ${revision}`)
}
console.log(`Native positional proof source ${revision}; no package artifact is generated`)

const workspace = await mkdtemp(join(tmpdir(), 'ghostty-positional-native-'))
try {
  const directory = dirname(fileURLToPath(import.meta.url))
  for (const name of ['build.zig', 'paint.zig', 'paint-test.zig', 'c-controls.zig']) {
    await copyFile(join(directory, name), join(workspace, name))
  }
  await writeFile(
    join(workspace, 'build.zig.zon'),
    `.{
    .name = .positional_native,
    .version = "0.0.0",
    .fingerprint = 0x84650620d74bc354,
    .minimum_zig_version = "0.16.0",
    .dependencies = .{ .ghostty = .{ .path = ${JSON.stringify(relative(workspace, source))} } },
    .paths = .{ "build.zig", "build.zig.zon", "paint.zig", "paint-test.zig", "c-controls.zig" },
  }`,
  )
  const child = Bun.spawn([argument('--zig') ?? 'zig', 'build', 'test', '--summary', 'all'], {
    cwd: workspace,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await child.exited
  if (exitCode !== 0)
    throw new ArtifactBuildError(`Native positional tests exited with status ${exitCode}`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}
