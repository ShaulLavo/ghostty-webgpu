import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
const UPSTREAM_TREE_SHA256 = '63d2b0c41531162a70b838369c0c225745e167495763ebbd0bc2fe546976a2bb'
const UPSTREAM_TREE_ENTRIES = 5_864
const TREE_HEADER = Buffer.from('ghostty-upstream-tree-v1\0')
const scriptDir = dirname(fileURLToPath(import.meta.url))

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

export type UpstreamAudit = {
  readonly bytes: number
  readonly entries: number
  readonly gitlinks: number
  readonly sha256: string
}

export class UpstreamAuditFailure extends Error {}

export function assertPinnedUpstream(upstream: string): UpstreamAudit {
  assertCheckout(upstream)
  const tree = computeGitTreeSha256(upstream, UPSTREAM_REVISION)
  if (tree.sha256 !== UPSTREAM_TREE_SHA256) {
    throw new UpstreamAuditFailure('unexpected upstream tree digest')
  }
  if (tree.entries !== UPSTREAM_TREE_ENTRIES) {
    throw new UpstreamAuditFailure('unexpected upstream tree entry count')
  }
  auditConfigBoundary(upstream)
  return tree
}

function assertCheckout(upstream: string): void {
  const head = runGit(upstream, ['rev-parse', 'HEAD']).toString('ascii').trim()
  if (head !== UPSTREAM_REVISION) throw new UpstreamAuditFailure('unexpected upstream revision')

  const objectFormat = runGit(upstream, ['rev-parse', '--show-object-format'])
    .toString('ascii')
    .trim()
  if (objectFormat !== 'sha1') throw new UpstreamAuditFailure('unexpected git object format')
  if (runGit(upstream, ['status', '--short']).length !== 0) {
    throw new UpstreamAuditFailure('upstream checkout is dirty')
  }
  runGit(upstream, ['diff', '--exit-code'])
}

function runGit(upstream: string, argv: readonly string[], input?: Buffer): Buffer {
  const result = spawnSync('/usr/bin/git', argv, {
    cwd: upstream,
    input,
    encoding: 'buffer',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    },
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new UpstreamAuditFailure('upstream audit subprocess failed')
  if (result.stderr.length !== 0) {
    throw new UpstreamAuditFailure('upstream audit subprocess wrote stderr')
  }
  return result.stdout
}

function parseTreeRecords(raw: Buffer): TreeRecord[] {
  const records: TreeRecord[] = []
  let offset = 0
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset)
    if (end < 0) throw new UpstreamAuditFailure('unterminated git tree record')
    const record = raw.subarray(offset, end)
    offset = end + 1

    const tab = record.indexOf(0x09)
    if (tab < 0) throw new UpstreamAuditFailure('invalid git tree record')
    const metadata = record.subarray(0, tab).toString('ascii').split(' ')
    if (metadata.length !== 3) throw new UpstreamAuditFailure('invalid git tree metadata')
    const [mode, objectType, objectId] = metadata
    if (!mode || !objectType || !objectId) {
      throw new UpstreamAuditFailure('incomplete git tree metadata')
    }

    const type = classifyTreeEntry(mode, objectType)
    records.push({ mode, objectId, path: record.subarray(tab + 1), type })
  }

  records.sort((left, right) => Buffer.compare(left.path, right.path))
  return records
}

function classifyTreeEntry(mode: string, objectType: string): 'blob' | 'gitlink' {
  if (mode === '160000' && objectType === 'commit') return 'gitlink'
  if (!['100644', '100755', '120000'].includes(mode)) {
    throw new UpstreamAuditFailure('unsupported git tree mode')
  }
  if (objectType !== 'blob') throw new UpstreamAuditFailure('unexpected git tree object type')
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
    if (headerEnd < 0) throw new UpstreamAuditFailure('invalid git blob batch header')
    const header = output.subarray(offset, headerEnd).toString('ascii').split(' ')
    if (header.length !== 3) throw new UpstreamAuditFailure('invalid git blob metadata')
    const [objectId, type, sizeText] = header
    const bytes = Number(sizeText)
    if (objectId !== expectedObjectId || type !== 'blob' || !Number.isSafeInteger(bytes)) {
      throw new UpstreamAuditFailure('unexpected git blob metadata')
    }

    const contentStart = headerEnd + 1
    const contentEnd = contentStart + bytes
    if (output[contentEnd] !== 0x0a) throw new UpstreamAuditFailure('invalid git blob delimiter')
    const content = output.subarray(contentStart, contentEnd)
    identities.set(objectId, {
      bytes,
      sha256: createHash('sha256').update(content).digest(),
    })
    offset = contentEnd + 1
  }

  if (offset !== output.length) throw new UpstreamAuditFailure('unexpected git blob batch suffix')
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

export function computeGitTreeSha256(upstream: string, revision: string): UpstreamAudit {
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new UpstreamAuditFailure('invalid Git tree revision')
  }
  const rawTree = runGit(upstream, ['ls-tree', '-r', '-z', '--full-tree', revision])
  const records = parseTreeRecords(rawTree)
  const blobs = readBlobIdentities(upstream, records)
  const hash = createHash('sha256').update(TREE_HEADER)
  let bytes = 0
  let gitlinks = 0

  for (const record of records) {
    hash.update(writeUint32(record.path.length))
    hash.update(record.path)
    hash.update(Buffer.from(record.mode, 'ascii'))
    hash.update(Buffer.from([record.type === 'blob' ? 1 : 2]))
    if (record.type === 'gitlink') {
      hash.update(writeUint64(20))
      hash.update(Buffer.from(record.objectId, 'hex'))
      bytes += 20
      gitlinks += 1
      continue
    }

    const blob = blobs.get(record.objectId)
    if (!blob) throw new UpstreamAuditFailure('missing git blob identity')
    hash.update(writeUint64(blob.bytes))
    hash.update(blob.sha256)
    bytes += blob.bytes
  }

  if (!Number.isSafeInteger(bytes)) throw new UpstreamAuditFailure('Git tree byte length overflow')
  return { bytes, sha256: hash.digest('hex'), entries: records.length, gitlinks }
}

function auditConfigBoundary(upstream: string): void {
  const global = readFileSync(join(upstream, 'src/global.zig'), 'utf8')
  const fileLoad = readFileSync(join(upstream, 'src/config/file_load.zig'), 'utf8')
  const macos = readFileSync(join(upstream, 'src/os/macos.zig'), 'utf8')
  const sharedDeps = readFileSync(join(upstream, 'src/build/SharedDeps.zig'), 'utf8')
  const rendererBackend = readFileSync(join(upstream, 'src/renderer/backend.zig'), 'utf8')
  const proofMain = readFileSync(join(scriptDir, 'main.zig'), 'utf8')
  const proofBuild = readFileSync(join(scriptDir, 'build.zig'), 'utf8')

  if (!global.includes('.tool => null,')) {
    throw new UpstreamAuditFailure('tool initialization action boundary changed')
  }
  if (!global.includes('// Initialize glslang for shader compilation\n    try glslang.init();')) {
    throw new UpstreamAuditFailure('tool initialization no longer retains glslang')
  }
  if (!sharedDeps.includes('// Glslang\n    if (b.lazyDependency("glslang"')) {
    throw new UpstreamAuditFailure('shared dependency glslang boundary changed')
  }
  if (!sharedDeps.includes('// cimgui\n    if (b.lazyDependency("dcimgui"')) {
    throw new UpstreamAuditFailure('shared dependency renderer boundary changed')
  }
  if (!sharedDeps.includes('// Fonts\n    {\n        // JetBrains Mono')) {
    throw new UpstreamAuditFailure('shared dependency font boundary changed')
  }
  if (rendererBackend.includes('none')) {
    throw new UpstreamAuditFailure('renderer-free official backend is now available')
  }
  if (!proofMain.includes('global.init(.{ .tool = minimal }) catch {')) {
    throw new UpstreamAuditFailure('proof does not use the official tool initializer')
  }
  if (proofMain.includes('.loadDefaultFiles(') || proofMain.includes('Config.load(')) {
    throw new UpstreamAuditFailure('proof reaches the template-writing loader')
  }
  if (!proofMain.includes('config.loadOptionalFile(alloc, candidate.?)')) {
    throw new UpstreamAuditFailure('accepted read-only load composition changed')
  }
  if (
    proofMain.includes('file_load.legacyDefaultAppSupportPath(alloc)') ||
    proofMain.includes('file_load.preferredAppSupportPath(alloc)')
  ) {
    throw new UpstreamAuditFailure('proof reaches a create-capable Application Support builder')
  }
  if (
    !proofMain.includes(
      'const macos_app_support_suffix = "Library/Application Support/com.mitchellh.ghostty";',
    ) ||
    !proofMain.includes('const home = environ.get("HOME")') ||
    !proofMain.includes('&.{ base, "config" }') ||
    !proofMain.includes('&.{ base, "config.ghostty" }')
  ) {
    throw new UpstreamAuditFailure('read-only macOS candidate derivation changed')
  }
  if (!fileLoad.includes('internal_os.macos.appSupportDir(alloc, "config.ghostty")')) {
    throw new UpstreamAuditFailure('current Application Support path builder changed')
  }
  if (!fileLoad.includes('internal_os.macos.appSupportDir(alloc, "config")')) {
    throw new UpstreamAuditFailure('legacy Application Support path builder changed')
  }
  if (
    !macos.includes('objc.sel("URLForDirectory:inDomain:appropriateForURL:create:error:"),') ||
    !macos.includes(
      '@as(?*anyopaque, null),\n            true,\n            @as(?*anyopaque, null),',
    )
  ) {
    throw new UpstreamAuditFailure('macOS directory-creating path boundary changed')
  }
  if (!proofBuild.includes('_ = try deps.add(exe);')) {
    throw new UpstreamAuditFailure('proof does not use upstream SharedDeps')
  }
}
