import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const TARGETS = {
  'darwin-arm64': {
    zigTarget: 'aarch64-macos',
    zigArchiveBytes: 52_238_004,
    zigArchiveSha256: 'b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489',
  },
  'darwin-x64': {
    zigTarget: 'x86_64-macos',
    zigArchiveBytes: 57_396_836,
    zigArchiveSha256: '0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7',
  },
  'linux-arm64': {
    zigTarget: 'aarch64-linux-musl',
    zigArchiveBytes: 51_211_944,
    zigArchiveSha256: 'ea4b09bfb22ec6f6c6ceac57ab63efb6b46e17ab08d21f69f3a48b38e1534f17',
  },
  'linux-x64': {
    zigTarget: 'x86_64-linux-musl',
    zigArchiveBytes: 55_478_392,
    zigArchiveSha256: '70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00',
  },
} as const
const ZIG_VERSION = '0.16.0'
const THEMES_BYTES = 78_218
const THEMES_SHA256 = 'ea9878471420ee5b12e7f2ff480099c954ea50e573a1bdf83f43e105c9be63f0'
const UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
const SOURCE_DATE_EPOCH = '1787590337'
const scriptDir = dirname(fileURLToPath(import.meta.url))

type Target = keyof typeof TARGETS
type Arguments = {
  readonly upstream: string
  readonly zig: string
  readonly zigArchive: string
  readonly themesArchive: string
  readonly target: Target
  readonly output: string
  readonly cache: string
  readonly globalCache: string
  readonly evidence: string
}

class ProofFailure extends Error {}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  const target = TARGETS[args.target]
  assertInputs(args, target)

  const temporary = mkdtempSync(join(tmpdir(), 'plan-065-build-'))
  try {
    const overlay = join(temporary, 'overlay')
    const prefix = join(temporary, 'prefix')
    createOverlay(args.upstream, overlay)
    build(args, target.zigTarget, overlay, prefix)
    assembleBundle(args, prefix)
    assertUpstreamClean(args.upstream)
    writeEvidence(args)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }

  process.stdout.write(`${JSON.stringify({ target: args.target, result: 'built' })}\n`)
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new ProofFailure('invalid arguments')
    values.set(name, value)
  }

  const target = values.get('--target')
  if (!target || !(target in TARGETS)) throw new ProofFailure('unsupported target')
  return {
    upstream: requiredPath(values, '--upstream'),
    zig: requiredPath(values, '--zig'),
    zigArchive: requiredPath(values, '--zig-archive'),
    themesArchive: requiredPath(values, '--themes-archive'),
    target: target as Target,
    output: requiredNewPath(values, '--output'),
    cache: requiredDirectoryPath(values, '--cache'),
    globalCache: requiredDirectoryPath(values, '--global-cache'),
    evidence: requiredNewPath(values, '--evidence'),
  }
}

function requiredPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new ProofFailure('missing path argument')
  return realpathSync(value)
}

function requiredNewPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new ProofFailure('missing output argument')
  if (lstatExists(value)) throw new ProofFailure('output already exists')
  return value
}

function requiredDirectoryPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new ProofFailure('missing directory argument')
  if (!lstatExists(value)) return resolve(value)
  if (!statSync(value).isDirectory()) throw new ProofFailure('cache path is not a directory')
  return realpathSync(value)
}

function assertInputs(args: Arguments, target: (typeof TARGETS)[Target]): void {
  if (run(args.zig, ['version']).trim() !== ZIG_VERSION) {
    throw new ProofFailure('Zig version mismatch')
  }
  assertFile(args.zigArchive, target.zigArchiveBytes, target.zigArchiveSha256, 'Zig archive')
  assertFile(args.themesArchive, THEMES_BYTES, THEMES_SHA256, 'themes archive')
  const head = run('git', ['-C', args.upstream, 'rev-parse', 'HEAD']).trim()
  if (head !== UPSTREAM_REVISION) throw new ProofFailure('upstream revision mismatch')
  assertUpstreamClean(args.upstream)
}

function assertFile(path: string, bytes: number, digest: string, label: string): void {
  const contents = readFileSync(path)
  if (contents.length !== bytes) throw new ProofFailure(`${label} length mismatch`)
  if (sha256(contents) !== digest) throw new ProofFailure(`${label} digest mismatch`)
}

function assertUpstreamClean(upstream: string): void {
  if (run('git', ['-C', upstream, 'status', '--short']).length !== 0) {
    throw new ProofFailure('upstream checkout is dirty')
  }
  run('git', ['-C', upstream, 'diff', '--exit-code'])
}

function createOverlay(upstream: string, overlay: string): void {
  mkdirSync(overlay, { recursive: true })
  for (const directory of ['dist', 'images', 'pkg', 'src', 'vendor']) {
    symlinkSync(join(upstream, directory), join(overlay, directory), 'dir')
  }
  symlinkSync(join(upstream, 'build.zig.zon'), join(overlay, 'build.zig.zon'), 'file')
  symlinkSync(join(scriptDir, 'build.zig'), join(overlay, 'build.zig'), 'file')
  symlinkSync(join(scriptDir, 'main.zig'), join(overlay, 'main.zig'), 'file')
}

function build(args: Arguments, zigTarget: string, overlay: string, prefix: string): void {
  mkdirSync(args.cache, { recursive: true })
  mkdirSync(args.globalCache, { recursive: true })
  const argv = [
    'build',
    '--prefix',
    prefix,
    '--cache-dir',
    args.cache,
    '--global-cache-dir',
    args.globalCache,
    '-Doptimize=ReleaseSafe',
    `-Dtarget=${zigTarget}`,
  ]
  const result = spawnSync(args.zig, argv, {
    cwd: overlay,
    encoding: 'buffer',
    env: {
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SOURCE_DATE_EPOCH,
      TMPDIR: tmpdir(),
    },
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new ProofFailure('Zig build failed')
}

function assembleBundle(args: Arguments, prefix: string): void {
  const source = join(prefix, 'bin', 'ghostty-config-resolver-proof')
  const helper = join(args.output, 'bin', 'ghostty-config-resolver-proof')
  const resources = join(args.output, 'resources', 'themes')
  mkdirSync(dirname(helper), { recursive: true })
  mkdirSync(resources, { recursive: true })
  copyFileSync(source, helper)
  chmodSync(helper, 0o755)

  const stripArgv = process.platform === 'darwin' ? ['-x', helper] : ['--strip-all', helper]
  run('/usr/bin/strip', stripArgv)
  run('/usr/bin/tar', ['-xzf', args.themesArchive, '-C', resources, '--strip-components=1'])
}

function writeEvidence(args: Arguments): void {
  const helper = join(args.output, 'bin', 'ghostty-config-resolver-proof')
  const evidence = {
    schemaVersion: 1,
    target: args.target,
    upstreamRevision: UPSTREAM_REVISION,
    zigVersion: ZIG_VERSION,
    zigSha256: sha256(readFileSync(args.zig)),
    zigArchiveSha256: sha256(readFileSync(args.zigArchive)),
    themesArchiveSha256: sha256(readFileSync(args.themesArchive)),
    artifactSha256: sha256(readFileSync(helper)),
    artifactBytes: statSync(helper).size,
    stripSha256: sha256(readFileSync('/usr/bin/strip')),
    runnerImage: process.env.ImageOS ?? 'local',
    runnerImageVersion: process.env.ImageVersion ?? 'local',
  } as const
  mkdirSync(dirname(args.evidence), { recursive: true })
  writeFileSync(args.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
}

function run(command: string, argv: readonly string[]): string {
  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new ProofFailure('proof subprocess failed')
  return result.stdout
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

try {
  main()
} catch (error) {
  const reason = error instanceof ProofFailure ? error.message : 'unexpected proof failure'
  process.stdout.write(`${JSON.stringify({ result: 'fail', reason })}\n`)
  process.exitCode = 1
}
