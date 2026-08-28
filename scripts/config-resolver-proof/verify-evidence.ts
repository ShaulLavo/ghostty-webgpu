import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const
const RESULT_VALUES = ['pass', 'fail', 'incomplete'] as const
const HEAD = 'a92108fd06d43b9e66e114ef4a863b669dd6624f'
const UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
const UPSTREAM_TREE_SHA256 = '63d2b0c41531162a70b838369c0c225745e167495763ebbd0bc2fe546976a2bb'
const ZIG_VERSION = '0.16.0'
const ZERO_HASH = '0'.repeat(64)
const SOURCE_DATE_EPOCH = 1787590337

type JsonObject = Record<string, unknown>
type ProofTarget = (typeof TARGETS)[number]

class EvidenceFailure extends Error {}

function fail(message: string): never {
  throw new EvidenceFailure(message)
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`)
  return value as JsonObject
}

function assertKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) fail(`${label} keys do not match`)
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
}

function assertInteger(value: unknown, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${label} must be a bounded integer`)
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  assertString(value, label)
  if (!/^[0-9a-f]{64}$/.test(value)) fail(`${label} must be a SHA-256 digest`)
}

function assertEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is string {
  assertString(value, label)
  if (!allowed.includes(value)) fail(`${label} has an unsupported value`)
}

function assertPrintableAscii(value: unknown, label: string): void {
  assertString(value, label)
  if (value.length < 1 || value.length > 256 || !/^[\x20-\x7e]+$/.test(value)) {
    fail(`${label} must be printable ASCII`)
  }
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`

  const object = asObject(value, 'canonical JSON value')
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
  return `{${entries.join(',')}}`
}

function expectedTarget(target: ProofTarget): { readonly os: string; readonly arch: string } {
  if (target.startsWith('darwin-')) {
    return { os: 'darwin', arch: target.endsWith('arm64') ? 'arm64' : 'x64' }
  }
  return { os: 'linux', arch: target.endsWith('arm64') ? 'arm64' : 'x64' }
}

function verifyStopRecipe(raw: Buffer): { readonly value: JsonObject; readonly sha256: string } {
  const value = asObject(JSON.parse(raw.toString('utf8')), 'recipe')
  const canonical = `${canonicalize(value)}\n`
  if (!raw.equals(Buffer.from(canonical))) fail('recipe is not canonical JSON plus one LF')

  assertKeys(
    value,
    ['schemaVersion', 'sourceDateEpoch', 'stopCondition', 'targets', 'upstream', 'zigVersion'],
    'recipe',
  )
  if (value.schemaVersion !== 1) fail('recipe schemaVersion must be 1')
  if (value.sourceDateEpoch !== SOURCE_DATE_EPOCH) fail('recipe sourceDateEpoch does not match')
  if (value.stopCondition !== 'macos-default-path-builder-can-create-directory') {
    fail('recipe stop condition does not match')
  }
  if (value.zigVersion !== ZIG_VERSION) fail('recipe Zig version does not match')

  const upstream = asObject(value.upstream, 'recipe upstream')
  assertKeys(upstream, ['repository', 'revision', 'treeSha256'], 'recipe upstream')
  if (upstream.repository !== 'https://github.com/ghostty-org/ghostty.git') {
    fail('recipe upstream repository does not match')
  }
  if (upstream.revision !== UPSTREAM_REVISION) fail('recipe upstream revision does not match')
  if (upstream.treeSha256 !== UPSTREAM_TREE_SHA256) fail('recipe upstream tree does not match')

  const targets = asObject(value.targets, 'recipe targets')
  assertKeys(targets, TARGETS, 'recipe targets')
  for (const target of TARGETS) verifyStopRecipeTarget(targets[target], target)
  return { value, sha256: sha256(raw) }
}

function verifyStopRecipeTarget(value: unknown, target: ProofTarget): void {
  const record = asObject(value, `recipe ${target}`)
  assertKeys(
    record,
    [
      'buildArgv',
      'environment',
      'inputs',
      'linkArgv',
      'optimizationMode',
      'runner',
      'state',
      'stripArgv',
      'targetTriple',
      'toolchain',
      'tools',
    ],
    `recipe ${target}`,
  )
  for (const key of ['buildArgv', 'environment', 'inputs', 'linkArgv', 'stripArgv', 'tools']) {
    if (!Array.isArray(record[key]) || record[key].length !== 0) {
      fail(`recipe ${target} ${key} must be empty after global stop`)
    }
  }
  if (record.optimizationMode !== 'ReleaseSafe')
    fail(`recipe ${target} optimize mode does not match`)
  if (record.state !== 'not-run-after-global-stop') fail(`recipe ${target} state does not match`)
  assertPrintableAscii(record.targetTriple, `recipe ${target} targetTriple`)

  const expected = expectedTarget(target)
  const runner = asObject(record.runner, `recipe ${target} runner`)
  assertKeys(runner, ['arch', 'image', 'imageVersion', 'os'], `recipe ${target} runner`)
  if (runner.os !== expected.os || runner.arch !== expected.arch) {
    fail(`recipe ${target} runner does not match target`)
  }
  if (runner.image !== 'not-run-after-global-stop' || runner.imageVersion !== runner.image) {
    fail(`recipe ${target} runner stop identity does not match`)
  }

  const toolchain = asObject(record.toolchain, `recipe ${target} toolchain`)
  assertKeys(
    toolchain,
    ['linkerSha256', 'sdkOrSysrootSha256', 'stripSha256', 'zigSha256'],
    `recipe ${target} toolchain`,
  )
  for (const value of Object.values(toolchain)) {
    if (value !== ZERO_HASH) fail(`recipe ${target} toolchain must be unresolved after global stop`)
  }
}

function verifyRunner(value: unknown, target: ProofTarget): void {
  const runner = asObject(value, `${target} runner`)
  assertKeys(runner, ['os', 'arch', 'image', 'imageVersion'], `${target} runner`)
  const expected = expectedTarget(target)
  if (runner.os !== expected.os || runner.arch !== expected.arch) {
    fail(`${target} runner does not match target`)
  }
  assertPrintableAscii(runner.image, `${target} runner image`)
  assertPrintableAscii(runner.imageVersion, `${target} runner imageVersion`)
}

function verifyToolchain(value: unknown, target: ProofTarget, recipeTarget: unknown): void {
  const toolchain = asObject(value, `${target} toolchain`)
  assertKeys(
    toolchain,
    ['zigSha256', 'linkerSha256', 'stripSha256', 'sdkOrSysrootSha256'],
    `${target} toolchain`,
  )
  const expected = asObject(
    asObject(recipeTarget, `recipe ${target}`).toolchain,
    `recipe ${target} toolchain`,
  )
  for (const [key, digest] of Object.entries(toolchain)) {
    assertHash(digest, `${target} ${key}`)
    if (digest !== expected[key]) fail(`${target} ${key} does not match recipe`)
  }
}

function verifyMatrixRow(
  value: unknown,
  target: ProofTarget,
  recipeSha256: string,
  recipeTarget: unknown,
): JsonObject {
  const row = asObject(value, target)
  assertKeys(
    row,
    [
      'runId',
      'runAttempt',
      'ghosttyWebGpuHead',
      'upstreamTreeSha256',
      'proofRecipeSha256',
      'sourceDateEpoch',
      'runner',
      'toolchain',
      'nativeExecution',
      'artifactSha256',
      'artifactBytes',
      'semanticFixtures',
      'noWriteFixtures',
      'dependencies',
      'compatibilityProbe',
      'relocation',
    ],
    target,
  )
  assertString(row.runId, `${target} runId`)
  if (!/^[1-9][0-9]{0,19}$/.test(row.runId)) fail(`${target} runId does not match`)
  assertInteger(row.runAttempt, 1, 100, `${target} runAttempt`)
  if (row.ghosttyWebGpuHead !== HEAD) fail(`${target} head does not match`)
  if (row.upstreamTreeSha256 !== UPSTREAM_TREE_SHA256)
    fail(`${target} upstream tree does not match`)
  if (row.proofRecipeSha256 !== recipeSha256) fail(`${target} recipe digest does not match`)
  if (row.sourceDateEpoch !== SOURCE_DATE_EPOCH) fail(`${target} source epoch does not match`)
  verifyRunner(row.runner, target)
  verifyToolchain(row.toolchain, target, recipeTarget)

  for (const key of [
    'nativeExecution',
    'semanticFixtures',
    'noWriteFixtures',
    'dependencies',
    'compatibilityProbe',
    'relocation',
  ]) {
    assertEnum(row[key], RESULT_VALUES, `${target} ${key}`)
  }
  if (row.artifactSha256 !== null) assertHash(row.artifactSha256, `${target} artifactSha256`)
  assertInteger(row.artifactBytes, 0, Number.MAX_SAFE_INTEGER, `${target} artifactBytes`)
  if (row.artifactSha256 === null && row.artifactBytes !== 0) {
    fail(`${target} absent artifact must have zero bytes`)
  }
  return row
}

function verifyChecks(value: unknown): JsonObject {
  const checks = asObject(value, 'checks')
  assertKeys(
    checks,
    [
      'officialReadOnlyGraph',
      'absentNoWrite',
      'deleteRaceNoWrite',
      'renameRaceNoWrite',
      'privacy',
      'displayP3Vectors',
    ],
    'checks',
  )
  for (const [key, result] of Object.entries(checks))
    assertEnum(result, RESULT_VALUES, `checks ${key}`)
  return checks
}

function verifyCeilings(value: unknown): JsonObject {
  const ceilings = asObject(value, 'ceilings')
  assertKeys(ceilings, ['perTargetBytes', 'totalPackageBytes', 'operatorAcceptance'], 'ceilings')
  const perTarget = asObject(ceilings.perTargetBytes, 'per-target ceilings')
  assertKeys(perTarget, TARGETS, 'per-target ceilings')
  for (const target of TARGETS) {
    assertInteger(perTarget[target], 1, Number.MAX_SAFE_INTEGER, `${target} ceiling`)
  }
  assertInteger(ceilings.totalPackageBytes, 1, Number.MAX_SAFE_INTEGER, 'total package ceiling')
  assertEnum(ceilings.operatorAcceptance, ['pending', 'accepted'], 'operator ceiling acceptance')
  return ceilings
}

function requirePass(
  evidence: JsonObject,
  checks: JsonObject,
  rows: readonly JsonObject[],
  ceilings: JsonObject,
): void {
  if (evidence.decision !== 'PASS') fail('PASS evidence required')
  if (Object.values(checks).some((value) => value !== 'pass')) fail('all checks must pass')
  for (const row of rows) {
    const results = [
      row.nativeExecution,
      row.semanticFixtures,
      row.noWriteFixtures,
      row.dependencies,
      row.compatibilityProbe,
      row.relocation,
    ]
    if (results.some((value) => value !== 'pass')) fail('all target results must pass')
    if (row.artifactSha256 === null || row.artifactBytes === 0) fail('PASS requires an artifact')
  }
  if (ceilings.operatorAcceptance !== 'accepted') fail('accepted ceilings required')
}

function main(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repository = join(scriptDir, '..', '..')
  const recipeRaw = readFileSync(join(scriptDir, 'proof-recipe.json'))
  const recipe = verifyStopRecipe(recipeRaw)
  const reportRaw = readFileSync(join(repository, 'docs/config-resolver-feasibility.md'))
  const evidence = asObject(
    JSON.parse(readFileSync(join(repository, 'docs/config-resolver-feasibility.json'), 'utf8')),
    'evidence',
  )

  assertKeys(
    evidence,
    [
      'schemaVersion',
      'decision',
      'ghosttyWebGpuHead',
      'upstreamRevision',
      'zigVersion',
      'reportSha256',
      'checks',
      'matrix',
      'ceilings',
    ],
    'evidence',
  )
  if (evidence.schemaVersion !== 1) fail('evidence schemaVersion must be 1')
  assertEnum(evidence.decision, ['PASS', 'FAIL', 'INCOMPLETE'], 'decision')
  if (evidence.ghosttyWebGpuHead !== HEAD) fail('evidence head does not match')
  if (evidence.upstreamRevision !== UPSTREAM_REVISION)
    fail('evidence upstream revision does not match')
  if (evidence.zigVersion !== ZIG_VERSION) fail('evidence Zig version does not match')
  assertHash(evidence.reportSha256, 'reportSha256')
  if (evidence.reportSha256 !== sha256(reportRaw)) fail('report digest does not match')

  const finalLine = reportRaw.toString('utf8').trimEnd().split('\n').at(-1)
  if (finalLine !== `Decision: ${evidence.decision}`) fail('report final decision does not match')

  const checks = verifyChecks(evidence.checks)
  const matrix = asObject(evidence.matrix, 'matrix')
  assertKeys(matrix, TARGETS, 'matrix')
  const recipeTargets = asObject(recipe.value.targets, 'recipe targets')
  const rows = TARGETS.map((target) =>
    verifyMatrixRow(matrix[target], target, recipe.sha256, recipeTargets[target]),
  )
  const identity = rows[0]
  if (!identity) fail('matrix must contain at least one target')
  for (const row of rows.slice(1)) {
    if (row.runId !== identity.runId || row.runAttempt !== identity.runAttempt) {
      fail('matrix run identity does not match')
    }
  }

  const ceilings = verifyCeilings(evidence.ceilings)
  if (process.argv.includes('--require-pass')) requirePass(evidence, checks, rows, ceilings)
  if (
    process.argv.includes('--require-ceiling-accepted') &&
    ceilings.operatorAcceptance !== 'accepted'
  ) {
    fail('accepted ceilings required')
  }

  process.stdout.write('{"evidence":"valid","decision":"FAIL"}\n')
}

try {
  main()
} catch (error) {
  const message = error instanceof EvidenceFailure ? error.message : 'unexpected evidence failure'
  process.stdout.write(`${JSON.stringify({ evidence: 'invalid', reason: message })}\n`)
  process.exitCode = 1
}
