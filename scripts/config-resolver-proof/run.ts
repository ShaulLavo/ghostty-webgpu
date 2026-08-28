import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
const ZIG_VERSION = '0.16.0'
const ZIG_ARCHIVE_BYTES = 55_478_392
const ZIG_ARCHIVE_SHA256 = '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00'
const TREE_HEADER = Buffer.from('ghostty-upstream-tree-v1\0')

type Arguments = {
  readonly upstream: string
  readonly zig: string
  readonly zigArchive: string
  readonly evidence: string
}

type TreeRecord = {
  readonly mode: string
  readonly objectId: string
  readonly path: Buffer
  readonly type: 'blob' | 'gitlink'
}

type BlobIdentity = {
  readonly bytes: number
  readonly sha256: Buffer
}

class ProofFailure extends Error {}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new ProofFailure('invalid proof arguments')
    values.set(name, value)
  }

  const upstream = values.get('--upstream')
  const zig = values.get('--zig')
  const zigArchive = values.get('--zig-archive')
  const evidence = values.get('--evidence')
  if (!upstream || !zig || !zigArchive || !evidence) {
    throw new ProofFailure('missing proof argument')
  }

  return {
    upstream: realpathSync(upstream),
    zig: realpathSync(zig),
    zigArchive: realpathSync(zigArchive),
    evidence,
  }
}

function run(
  command: string,
  argv: readonly string[],
  options: { readonly cwd?: string; readonly input?: Buffer } = {},
): Buffer {
  const result = spawnSync(command, argv, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'buffer',
    env: { PATH: process.env.PATH ?? '' },
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new ProofFailure('proof subprocess failed')
  if (result.stderr.length !== 0) throw new ProofFailure('proof subprocess wrote stderr')
  return result.stdout
}

function runGit(upstream: string, argv: readonly string[], input?: Buffer): Buffer {
  return run('git', argv, { cwd: upstream, input })
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertImmutableInputs(args: Arguments): { readonly zigSha256: string } {
  const head = runGit(args.upstream, ['rev-parse', 'HEAD']).toString('ascii').trim()
  if (head !== UPSTREAM_REVISION) throw new ProofFailure('unexpected upstream revision')

  const objectFormat = runGit(args.upstream, ['rev-parse', '--show-object-format'])
    .toString('ascii')
    .trim()
  if (objectFormat !== 'sha1') throw new ProofFailure('unexpected git object format')
  if (runGit(args.upstream, ['status', '--short']).length !== 0) {
    throw new ProofFailure('upstream checkout is dirty')
  }
  runGit(args.upstream, ['diff', '--exit-code'])

  const version = run(args.zig, ['version']).toString('ascii').trim()
  if (version !== ZIG_VERSION) throw new ProofFailure('unexpected Zig version')

  const archive = readFileSync(args.zigArchive)
  if (archive.length !== ZIG_ARCHIVE_BYTES) throw new ProofFailure('unexpected Zig archive length')
  const archiveSha256 = sha256(archive)
  if (archiveSha256 !== ZIG_ARCHIVE_SHA256) {
    throw new ProofFailure('unexpected Zig archive digest')
  }

  return { zigSha256: sha256(readFileSync(args.zig)) }
}

function parseTreeRecords(raw: Buffer): TreeRecord[] {
  const records: TreeRecord[] = []
  let offset = 0
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset)
    if (end < 0) throw new ProofFailure('unterminated git tree record')
    const record = raw.subarray(offset, end)
    offset = end + 1

    const tab = record.indexOf(0x09)
    if (tab < 0) throw new ProofFailure('invalid git tree record')
    const metadata = record.subarray(0, tab).toString('ascii').split(' ')
    if (metadata.length !== 3) throw new ProofFailure('invalid git tree metadata')
    const [mode, objectType, objectId] = metadata
    if (!mode || !objectType || !objectId) throw new ProofFailure('incomplete git tree metadata')

    const type = classifyTreeEntry(mode, objectType)
    records.push({ mode, objectId, path: record.subarray(tab + 1), type })
  }

  records.sort((left, right) => Buffer.compare(left.path, right.path))
  return records
}

function classifyTreeEntry(mode: string, objectType: string): 'blob' | 'gitlink' {
  if (mode === '160000' && objectType === 'commit') return 'gitlink'
  if (!['100644', '100755', '120000'].includes(mode)) {
    throw new ProofFailure('unsupported git tree mode')
  }
  if (objectType !== 'blob') throw new ProofFailure('unexpected git tree object type')
  return 'blob'
}

function readBlobIdentities(
  upstream: string,
  records: readonly TreeRecord[],
): Map<string, BlobIdentity> {
  const objectIds = [
    ...new Set(records.filter((record) => record.type === 'blob').map((record) => record.objectId)),
  ]
  const input = Buffer.from(`${objectIds.join('\n')}\n`, 'ascii')
  const output = runGit(upstream, ['cat-file', '--batch'], input)
  const identities = new Map<string, BlobIdentity>()
  let offset = 0

  for (const expectedObjectId of objectIds) {
    const headerEnd = output.indexOf(0x0a, offset)
    if (headerEnd < 0) throw new ProofFailure('invalid git blob batch header')
    const header = output.subarray(offset, headerEnd).toString('ascii').split(' ')
    if (header.length !== 3) throw new ProofFailure('invalid git blob metadata')
    const [objectId, type, sizeText] = header
    const bytes = Number(sizeText)
    if (objectId !== expectedObjectId || type !== 'blob' || !Number.isSafeInteger(bytes)) {
      throw new ProofFailure('unexpected git blob metadata')
    }

    const contentStart = headerEnd + 1
    const contentEnd = contentStart + bytes
    if (output[contentEnd] !== 0x0a) throw new ProofFailure('invalid git blob delimiter')
    const content = output.subarray(contentStart, contentEnd)
    identities.set(objectId, {
      bytes,
      sha256: createHash('sha256').update(content).digest(),
    })
    offset = contentEnd + 1
  }

  if (offset !== output.length) throw new ProofFailure('unexpected git blob batch suffix')
  return identities
}

function writeUint32(value: number): Buffer {
  const result = Buffer.alloc(4)
  result.writeUInt32BE(value)
  return result
}

function writeUint64(value: number): Buffer {
  const result = Buffer.alloc(8)
  result.writeBigUInt64BE(BigInt(value))
  return result
}

function computeUpstreamTreeSha256(upstream: string): {
  readonly sha256: string
  readonly entries: number
} {
  const rawTree = runGit(upstream, ['ls-tree', '-r', '-z', '--full-tree', UPSTREAM_REVISION])
  const records = parseTreeRecords(rawTree)
  const blobs = readBlobIdentities(upstream, records)
  const hash = createHash('sha256').update(TREE_HEADER)

  for (const record of records) {
    hash.update(writeUint32(record.path.length))
    hash.update(record.path)
    hash.update(Buffer.from(record.mode, 'ascii'))
    hash.update(Buffer.from([record.type === 'blob' ? 1 : 2]))
    if (record.type === 'gitlink') {
      hash.update(writeUint64(20))
      hash.update(Buffer.from(record.objectId, 'hex'))
      continue
    }

    const blob = blobs.get(record.objectId)
    if (!blob) throw new ProofFailure('missing git blob identity')
    hash.update(writeUint64(blob.bytes))
    hash.update(blob.sha256)
  }

  return { sha256: hash.digest('hex'), entries: records.length }
}

function auditConfigBoundary(upstream: string): void {
  const global = readFileSync(join(upstream, 'src/global.zig'), 'utf8')
  const fileLoad = readFileSync(join(upstream, 'src/config/file_load.zig'), 'utf8')
  const macos = readFileSync(join(upstream, 'src/os/macos.zig'), 'utf8')
  const sharedDeps = readFileSync(join(upstream, 'src/build/SharedDeps.zig'), 'utf8')
  const rendererBackend = readFileSync(join(upstream, 'src/renderer/backend.zig'), 'utf8')
  const proofMain = readFileSync(join(import.meta.dirname, 'main.zig'), 'utf8')
  const proofBuild = readFileSync(join(import.meta.dirname, 'build.zig'), 'utf8')

  if (!global.includes('.tool => null,')) {
    throw new ProofFailure('tool initialization action boundary changed')
  }
  if (!global.includes('// Initialize glslang for shader compilation\n    try glslang.init();')) {
    throw new ProofFailure('tool initialization no longer retains glslang')
  }
  if (!sharedDeps.includes('// Glslang\n    if (b.lazyDependency("glslang"')) {
    throw new ProofFailure('shared dependency glslang boundary changed')
  }
  if (!sharedDeps.includes('// cimgui\n    if (b.lazyDependency("dcimgui"')) {
    throw new ProofFailure('shared dependency renderer boundary changed')
  }
  if (!sharedDeps.includes('// Fonts\n    {\n        // JetBrains Mono')) {
    throw new ProofFailure('shared dependency font boundary changed')
  }
  if (rendererBackend.includes('none')) {
    throw new ProofFailure('renderer-free official backend is now available')
  }
  if (!proofMain.includes('global.init(.{ .tool = minimal }) catch {')) {
    throw new ProofFailure('proof does not use the official tool initializer')
  }
  if (proofMain.includes('.loadDefaultFiles(') || proofMain.includes('Config.load(')) {
    throw new ProofFailure('proof reaches the template-writing loader')
  }
  if (!proofMain.includes('config.loadOptionalFile(alloc, candidate.?)')) {
    throw new ProofFailure('accepted read-only load composition changed')
  }
  if (
    proofMain.includes('file_load.legacyDefaultAppSupportPath(alloc)') ||
    proofMain.includes('file_load.preferredAppSupportPath(alloc)')
  ) {
    throw new ProofFailure('proof reaches a create-capable Application Support builder')
  }
  if (
    !proofMain.includes(
      'const macos_app_support_suffix = "Library/Application Support/com.mitchellh.ghostty";',
    ) ||
    !proofMain.includes('const home = environ.get("HOME")') ||
    !proofMain.includes('&.{ base, "config" }') ||
    !proofMain.includes('&.{ base, "config.ghostty" }')
  ) {
    throw new ProofFailure('read-only macOS candidate derivation changed')
  }
  if (!fileLoad.includes('internal_os.macos.appSupportDir(alloc, "config.ghostty")')) {
    throw new ProofFailure('current Application Support path builder changed')
  }
  if (!fileLoad.includes('internal_os.macos.appSupportDir(alloc, "config")')) {
    throw new ProofFailure('legacy Application Support path builder changed')
  }
  if (
    !macos.includes('objc.sel("URLForDirectory:inDomain:appropriateForURL:create:error:"),') ||
    !macos.includes(
      '@as(?*anyopaque, null),\n            true,\n            @as(?*anyopaque, null),',
    )
  ) {
    throw new ProofFailure('macOS directory-creating path boundary changed')
  }
  if (!proofBuild.includes('_ = try deps.add(exe);')) {
    throw new ProofFailure('proof does not use upstream SharedDeps')
  }
}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  const { zigSha256 } = assertImmutableInputs(args)
  const upstreamTree = computeUpstreamTreeSha256(args.upstream)
  auditConfigBoundary(args.upstream)

  const evidence = {
    proofSchemaVersion: 1,
    status: 'incomplete',
    reason: 'full-native-recipe-pending',
    upstreamRevision: UPSTREAM_REVISION,
    upstreamTreeSha256: upstreamTree.sha256,
    upstreamTreeEntries: upstreamTree.entries,
    zigVersion: ZIG_VERSION,
    zigArchiveSha256: ZIG_ARCHIVE_SHA256,
    zigSha256,
    checks: {
      checkoutClean: true,
      acceptedReadOnlyComposition: true,
      acceptedHeavyHelperGraph: true,
      createCapableMacosBuildersSkipped: true,
      fixedMacosCandidatesDerivedReadOnly: true,
      macosPathBuilderPassesCreateTrue: true,
      toolInitCallsGlslang: true,
      sharedDepsLinksRendererStack: true,
      fourTargetMatrixRequired: true,
    },
  } as const

  writeFileSync(args.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write('{"status":"INCOMPLETE","reason":"full-native-recipe-pending"}\n')
}

try {
  main()
} catch (error) {
  const message = error instanceof ProofFailure ? error.message : 'unexpected proof failure'
  process.stdout.write(`${JSON.stringify({ status: 'proof-error', reason: message })}\n`)
  process.exitCode = 1
}
