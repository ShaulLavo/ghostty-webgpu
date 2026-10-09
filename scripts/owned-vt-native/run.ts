import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArtifactBuildError, verifyCleanSource } from '../ghostty-source.js'
import {
  buildIdentity,
  digest,
  editorIdentity,
  hash,
  output,
  qualifiedBuild,
  type BuildReceipt,
} from './identity.js'
import { runProof } from './proof.js'

const nativePin = 'befcdfd2c3a1cb24d9ec886e93c95b2b5daa7028'
const editorPin = '8cdc43dbf013e0f826e8413893b7c529edfc54e2'
const directory = dirname(fileURLToPath(import.meta.url))

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new ArtifactBuildError(`${name} requires a value`)
  return value
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return output(['git'].concat(args), cwd)
}

const sourceArgument = argument('--source')
const editorArgument = argument('--editor-source')
if (!sourceArgument || !editorArgument) {
  console.log(
    'SKIP owned-VT native proof: pass --source (official Ghostty checkout) and --editor-source (ReadSession checkpoint package). Requires Bun, Git and Zig 0.16.0.',
  )
  process.exit(0)
}
if (process.platform === 'win32') {
  console.log('SKIP owned-VT native proof: the C sensor requires POSIX stdio.')
  process.exit(0)
}
const zig = argument('--zig') ?? 'zig'
const missingTools = ['git', zig].filter(
  (tool) => !Bun.which(tool, { PATH: process.env['PATH'] ?? '' }),
)
if (missingTools.length) {
  console.log(`SKIP owned-VT native proof: required tools unavailable: ${missingTools.join(', ')}.`)
  process.exit(0)
}
const source = resolve(sourceArgument)
const editor = resolve(editorArgument)
await verifyCleanSource(source)
if ((await git(source, ['rev-parse', 'HEAD'])) !== nativePin)
  throw new ArtifactBuildError(`Native proof requires official Ghostty ${nativePin}`)
const editorInputs = await editorIdentity(editor, editorPin)
const evidenceArgument = argument('--evidence')
if (!evidenceArgument) throw new ArtifactBuildError('--evidence requires a new run directory')
const evidence = resolve(evidenceArgument)
await mkdir(evidence)
const workspace = await mkdtemp(
  join(resolve(argument('--scratch') ?? tmpdir()), 'owned-vt-native-'),
)
const records: Record<string, unknown>[] = []
const receipt = (value: Record<string, unknown>) => records.push(value)
const sources = [
  'build.zig',
  'terminal.c',
  'native.ts',
  'proof.ts',
  'run.ts',
  'identity.ts',
  'review-proof.ts',
]
if (!process.argv.includes('--missing-renderer')) sources.push('owner.ts')
try {
  const hashes = Object.fromEntries(
    await Promise.all(sources.map(async (file) => [file, await hash(join(directory, file))])),
  )
  const identity = await buildIdentity(source, zig, hashes)
  const metadata = {
    nativePin,
    ...editorInputs,
    checkout: await git(directory, ['rev-parse', 'HEAD']),
    missingRenderer: process.argv.includes('--missing-renderer'),
    hashes,
    buildIdentity: identity,
  }
  receipt({ kind: 'pins', ...metadata })
  await writeFile(join(evidence, 'sources.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  console.log(JSON.stringify(metadata))
  const binary = join(evidence, 'owned-vt-terminal')
  const previousArgument = argument('--binary')
  let build: BuildReceipt
  if (previousArgument) {
    const previous = resolve(previousArgument)
    build = await qualifiedBuild(previous, identity, editorInputs)
    await copyFile(previous, binary)
    await copyFile(join(dirname(previous), build.library.file), join(evidence, build.library.file))
    receipt({
      kind: 'binary',
      sha256: await hash(binary),
      path: binary,
      reusedFrom: previous,
      build,
    })
  } else {
    for (const file of ['build.zig', 'terminal.c'])
      await copyFile(join(directory, file), join(workspace, file))
    const manifest = `.{
    .name = .positional_native,
    .version = "0.0.0",
    .fingerprint = 0x84650620d74bc354,
    .minimum_zig_version = "0.16.0",
    .dependencies = .{ .ghostty = .{ .path = ${JSON.stringify(relative(workspace, source))} } },
    .paths = .{ "build.zig", "build.zig.zon", "terminal.c" },
  }`
    await writeFile(join(workspace, 'build.zig.zon'), manifest)
    await writeFile(join(evidence, 'native-build.zig.zon'), manifest)
    const argv = [
      identity.compiler.executable,
      'build',
      '--summary',
      'all',
      '--system',
      argument('--packages') ??
        join(process.env['ZIG_GLOBAL_CACHE_DIR'] ?? join(tmpdir(), 'zig-cache'), 'p'),
      '-Dtarget=native',
      '-Dcpu=native',
      '-Doptimize=Debug',
    ]
    receipt({
      kind: 'build-start',
      identity,
      argv,
      cwd: workspace,
      manifestSha256: digest(manifest),
    })
    const child = Bun.spawn(argv, { cwd: workspace, stdout: 'inherit', stderr: 'inherit' })
    const code = await child.exited
    if (code) {
      receipt({ kind: 'build-failed', identity, argv, code })
      throw new ArtifactBuildError(`Native proof build exited with status ${code}`)
    }
    const libraries = (await readdir(join(workspace, 'zig-out/lib'))).filter((file) =>
      file.endsWith('.a'),
    )
    if (libraries.length !== 1)
      throw new ArtifactBuildError('Native proof requires one installed static library')
    const library = {
      file: 'ghostty-vt-static.a',
      sha256: await hash(join(workspace, 'zig-out/lib', libraries[0]!)),
    }
    await copyFile(join(workspace, 'zig-out/lib', libraries[0]!), join(evidence, library.file))
    build = {
      kind: 'build',
      code,
      identity,
      argv,
      cwd: workspace,
      manifest: { content: manifest, sha256: digest(manifest) },
      library,
    }
    receipt({ ...build })
    await copyFile(join(workspace, 'zig-out/bin/owned-vt-terminal'), binary)
    receipt({ kind: 'binary', sha256: await hash(binary), path: binary, build })
  }
  await runProof(binary, editor, process.argv.includes('--missing-renderer'), receipt)
} finally {
  const content = `${records.map((value) => JSON.stringify(value)).join('\n')}\n`
  await writeFile(join(evidence, 'records.jsonl'), content)
  await writeFile(join(evidence, 'records.sha256'), `${digest(content)}  records.jsonl\n`)
  for (const file of sources) await copyFile(join(directory, file), join(evidence, file))
  await rm(workspace, { recursive: true, force: true })
}
