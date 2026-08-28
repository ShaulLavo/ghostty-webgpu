import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const
const MODES = ['build', 'inventory', 'verify'] as const
const UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
const UPSTREAM_TREE_SHA256 = '63d2b0c41531162a70b838369c0c225745e167495763ebbd0bc2fe546976a2bb'
const SOURCE_DATE_EPOCH = 1_787_590_337
const OUTPUT_LIMIT = 1024 * 1024
const scriptDir = dirname(fileURLToPath(import.meta.url))

type Target = (typeof TARGETS)[number]
type Mode = (typeof MODES)[number]
type JsonObject = Record<string, unknown>
type Arguments = {
  readonly mode: Mode
  readonly target: Target
  readonly upstream: string
  readonly zig: string
  readonly zigArchive: string
  readonly themesArchive: string
  readonly output: string
  readonly evidence: string
}

class ProofFailure extends Error {}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  assertEnvironment(args)
  assertNativeTarget(args.target)
  assertSourceInputs(args)
  if (args.mode === 'verify') {
    verify(args)
    return
  }
  buildOrInventory(args)
}

function parseArguments(argv: readonly string[]): Arguments {
  const allowed = new Set([
    '--mode',
    '--target',
    '--upstream',
    '--zig',
    '--zig-archive',
    '--themes-archive',
    '--output',
    '--evidence',
  ])
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !allowed.has(name)) throw new ProofFailure('invalid proof argument')
    if (values.has(name)) throw new ProofFailure('duplicate proof argument')
    values.set(name, value)
  }
  if (values.size !== allowed.size) throw new ProofFailure('missing proof argument')

  const mode = values.get('--mode')
  const target = values.get('--target')
  if (!MODES.includes(mode as Mode)) throw new ProofFailure('unsupported proof mode')
  if (!TARGETS.includes(target as Target)) throw new ProofFailure('unsupported proof target')
  return {
    mode: mode as Mode,
    target: target as Target,
    upstream: existingPath(values, '--upstream'),
    zig: existingPath(values, '--zig'),
    zigArchive: existingPath(values, '--zig-archive'),
    themesArchive: existingPath(values, '--themes-archive'),
    output: outputPath(values, '--output', mode === 'verify'),
    evidence: newPath(values, '--evidence'),
  }
}

function existingPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new ProofFailure('missing existing path')
  return realpathSync(value)
}

function outputPath(values: ReadonlyMap<string, string>, name: string, mustExist: boolean): string {
  const value = values.get(name)
  if (!value) throw new ProofFailure('missing output path')
  if (!mustExist && !pathExists(value)) return resolve(value)
  if (!mustExist) throw new ProofFailure('build output already exists')
  return realpathSync(value)
}

function newPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new ProofFailure('missing evidence path')
  if (pathExists(value)) throw new ProofFailure('evidence path already exists')
  return resolve(value)
}

function assertEnvironment(args: Arguments): void {
  const expected = {
    PROOF_PHASE: args.mode === 'inventory' ? 'inventory' : 'evidence',
    PROOF_TARGET: args.target,
    PROOF_SOURCE_HEAD: requiredEnvironment('EXPECTED_HEAD'),
  }
  for (const [name, value] of Object.entries(expected)) {
    if (requiredEnvironment(name) !== value) throw new ProofFailure(`${name} does not match`)
  }
  if (requiredEnvironment('EXPECTED_UPSTREAM_REVISION') !== UPSTREAM_REVISION) {
    throw new ProofFailure('expected upstream revision does not match')
  }
  assertDecimal(requiredEnvironment('PROOF_RUN_ID'), 'run ID')
  assertDecimal(requiredEnvironment('PROOF_RUN_ATTEMPT'), 'run attempt')
  requiredEnvironment('ImageOS')
  requiredEnvironment('ImageVersion')
  requiredEnvironment('PROOF_RUNNER_LABEL')
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value || value.length > 256) throw new ProofFailure(`missing or invalid ${name}`)
  return value
}

function assertDecimal(value: string, label: string): void {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) throw new ProofFailure(`${label} is invalid`)
}

function assertNativeTarget(target: Target): void {
  const expectedOs = target.startsWith('darwin-') ? 'Darwin' : 'Linux'
  const expectedArch = nativeArchitecture(target)
  if (run('/usr/bin/uname', ['-s']).trim() !== expectedOs) {
    throw new ProofFailure('native operating system mismatch')
  }
  if (run('/usr/bin/uname', ['-m']).trim() !== expectedArch) {
    throw new ProofFailure('native architecture mismatch')
  }
}

function nativeArchitecture(target: Target): string {
  if (!target.endsWith('arm64')) return 'x86_64'
  if (target.startsWith('darwin-')) return 'arm64'
  return 'aarch64'
}

function assertSourceInputs(args: Arguments): void {
  const expectedHead = requiredEnvironment('EXPECTED_HEAD')
  const sourceHead = run('git', ['rev-parse', 'HEAD'], repositoryRoot()).trim()
  if (sourceHead !== expectedHead) throw new ProofFailure('proof source head mismatch')
  const upstreamHead = run('git', ['rev-parse', 'HEAD'], args.upstream).trim()
  if (upstreamHead !== UPSTREAM_REVISION) throw new ProofFailure('upstream head mismatch')
  const objectFormat = run('git', ['rev-parse', '--show-object-format'], args.upstream).trim()
  if (objectFormat !== 'sha1') throw new ProofFailure('upstream object format mismatch')
  assertClean(repositoryRoot(), 'proof source')
  assertClean(args.upstream, 'upstream source')
}

function assertClean(repository: string, label: string): void {
  if (run('git', ['status', '--short'], repository).length !== 0) {
    throw new ProofFailure(`${label} is dirty`)
  }
  run('git', ['diff', '--exit-code'], repository)
}

function repositoryRoot(): string {
  return realpathSync(join(scriptDir, '..', '..'))
}

function buildOrInventory(args: Arguments): void {
  runBun('build-helper.ts', [
    '--mode',
    args.mode,
    '--target',
    args.target,
    '--upstream',
    args.upstream,
    '--zig',
    args.zig,
    '--zig-archive',
    args.zigArchive,
    '--themes-archive',
    args.themesArchive,
    '--output',
    args.output,
    '--evidence',
    args.evidence,
  ])
  assertEvidenceFile(args.evidence)
}

function verify(args: Arguments): void {
  const buildEvidencePath = requiredEnvironment('PROOF_BUILD_EVIDENCE')
  const buildEvidence = readJson(buildEvidencePath, 'build evidence')
  const detailPath = `${args.evidence}.detail`
  runBun('verify-helper.ts', [
    '--helper',
    join(args.output, 'bin', 'ghostty-config-resolver-proof'),
    '--resources',
    join(args.output, 'resources'),
    '--target',
    args.target,
    '--evidence',
    detailPath,
  ])
  const detail = readJson(detailPath, 'verify detail')
  rmSync(detailPath)
  const evidence = targetEvidence(args, buildEvidence, detail)
  mkdirSync(dirname(args.evidence), { recursive: true })
  writeFileSync(args.evidence, `${JSON.stringify(evidence)}\n`, { flag: 'wx' })
  assertEvidenceFile(args.evidence)
}

function targetEvidence(args: Arguments, build: JsonObject, detail: JsonObject): JsonObject {
  const recipeSha256 = sha256(readFileSync(join(scriptDir, 'proof-recipe.json')))
  verifyObservationAgreement(args, build, detail, recipeSha256)
  const runner = objectValue(build.runner, 'build runner')
  const tools = arrayValue(build.tools, 'build tools')
  const row = {
    runId: requiredEnvironment('PROOF_RUN_ID'),
    runAttempt: boundedInteger(requiredEnvironment('PROOF_RUN_ATTEMPT'), 1, 100, 'run attempt'),
    ghosttyWebGpuHead: requiredEnvironment('EXPECTED_HEAD'),
    upstreamTreeSha256: UPSTREAM_TREE_SHA256,
    proofRecipeSha256: recipeSha256,
    sourceDateEpoch: SOURCE_DATE_EPOCH,
    runner: {
      os: runner.os,
      arch: runner.arch,
      image: runner.image,
      imageVersion: runner.imageVersion,
    },
    toolchain: {
      zigSha256: toolHash(tools, 'zig'),
      linkerSha256: toolHash(tools, 'linker'),
      stripSha256: toolHash(tools, 'strip'),
      sdkOrSysrootSha256: toolHash(tools, 'sdk-or-sysroot'),
    },
    nativeExecution: passValue(detail.nativeExecution, 'native execution'),
    artifactSha256: stringValue(build.artifactSha256, 'artifact hash'),
    artifactBytes: integerValue(build.artifactBytes, 'artifact bytes'),
    semanticFixtures: passValue(detail.semanticFixtures, 'semantic fixtures'),
    noWriteFixtures: passValue(detail.noWriteFixtures, 'no-write fixtures'),
    dependencies: passValue(detail.dependencies, 'dependencies'),
    compatibilityProbe: passValue(detail.compatibilityProbe, 'compatibility probe'),
    relocation: passValue(detail.relocation, 'relocation'),
  }
  return {
    schemaVersion: 1,
    kind: 'config-resolver-target-evidence',
    target: args.target,
    row,
    observations: { build, verify: detail },
  }
}

function verifyObservationAgreement(
  args: Arguments,
  build: JsonObject,
  detail: JsonObject,
  recipeSha256: string,
): void {
  if (build.kind !== 'config-resolver-build') throw new ProofFailure('build evidence kind mismatch')
  if (build.target !== args.target || detail.target !== args.target) {
    throw new ProofFailure('target evidence identity mismatch')
  }
  if (build.upstreamRevision !== UPSTREAM_REVISION) {
    throw new ProofFailure('build upstream revision mismatch')
  }
  if (build.proofRecipeSha256 !== recipeSha256) {
    throw new ProofFailure('build recipe digest mismatch')
  }
  assertEqualObservation(build, 'artifactSha256', detail, 'artifactSha256')
  assertEqualObservation(build, 'artifactBytes', detail, 'artifactBytes')
  assertEqualObservation(build, 'resourceTreeSha256', detail, 'resourcesSha256')
  assertEqualObservation(build, 'resourceBytes', detail, 'resourcesBytes')
  assertEqualObservation(build, 'resourceEntries', detail, 'resourceEntries')
}

function assertEqualObservation(
  left: JsonObject,
  leftKey: string,
  right: JsonObject,
  rightKey: string,
): void {
  if (left[leftKey] !== right[rightKey])
    throw new ProofFailure('build and verify evidence disagree')
}

function toolHash(tools: readonly unknown[], role: string): string {
  const matches = tools
    .map((value) => objectValue(value, 'tool'))
    .filter((tool) => tool.role === role)
  if (matches.length !== 1) throw new ProofFailure(`${role} tool identity is not unique`)
  return stringValue(matches[0]!.sha256, `${role} hash`)
}

function passValue(value: unknown, label: string): 'pass' {
  if (value !== 'pass') throw new ProofFailure(`${label} did not pass`)
  return value
}

function readJson(path: string, label: string): JsonObject {
  const bytes = readFileSync(path)
  if (bytes.length < 2 || bytes.length > OUTPUT_LIMIT) {
    throw new ProofFailure(`${label} length is invalid`)
  }
  return objectValue(JSON.parse(bytes.toString('utf8')), label)
}

function assertEvidenceFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ProofFailure('evidence is not a regular file')
  if (stat.size < 2 || stat.size > OUTPUT_LIMIT)
    throw new ProofFailure('evidence length is invalid')
  readJson(path, 'evidence')
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProofFailure(`${label} must be an object`)
  }
  return value as JsonObject
}

function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 512)
    throw new ProofFailure(`${label} must be an array`)
  return value
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) {
    throw new ProofFailure(`${label} must be a bounded string`)
  }
  return value
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProofFailure(`${label} must be a nonnegative integer`)
  }
  return value as number
}

function boundedInteger(value: string, minimum: number, maximum: number, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProofFailure(`${label} is outside its bound`)
  }
  return parsed
}

function runBun(script: string, argv: readonly string[]): void {
  const result = spawnSync(process.execPath, [join(scriptDir, script), ...argv], {
    encoding: 'buffer',
    env: process.env,
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new ProofFailure(`${script} failed`)
  if (result.stderr.length !== 0) throw new ProofFailure(`${script} wrote stderr`)
  assertNoSentinel(result.stdout)
}

function run(command: string, argv: readonly string[], cwd?: string): string {
  const result = spawnSync(command, argv, {
    cwd,
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0 || result.stderr.length !== 0) {
    throw new ProofFailure('proof subprocess failed')
  }
  assertNoSentinel(Buffer.from(result.stdout), Buffer.from(result.stderr))
  return result.stdout
}

function assertNoSentinel(...values: readonly Buffer[]): void {
  const sentinels = [
    'PLAN065_PATH_SENTINEL',
    'PLAN065_SECRET_SENTINEL',
    'PLAN065_THEME_SENTINEL',
    'PLAN065_DIAGNOSTIC_SENTINEL',
  ]
  for (const value of values) {
    const text = value.toString('utf8')
    if (sentinels.some((sentinel) => text.includes(sentinel))) {
      throw new ProofFailure('privacy sentinel leaked')
    }
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

try {
  main()
} catch (error) {
  const reason = error instanceof ProofFailure ? error.message : 'unexpected proof failure'
  process.stdout.write(`${JSON.stringify({ result: 'fail', reason })}\n`)
  process.exitCode = 1
}
