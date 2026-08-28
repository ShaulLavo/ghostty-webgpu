import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROOF_SOURCE_DATE_EPOCH,
  PROOF_TARGETS,
  PROOF_UPSTREAM_REVISION,
  PROOF_UPSTREAM_TREE_SHA256,
  PROOF_ZIG_VERSION,
  ProofContractError,
  loadProofRecipe,
  toolchainHashes,
  type ProofRunner,
  type ProofTarget,
  type ProofTargetRecipe,
} from './proof-contract'

const RESULT_VALUES = ['pass', 'fail', 'incomplete'] as const
const DECISION_VALUES = ['PASS', 'FAIL', 'INCOMPLETE'] as const
const RESULT_FIELDS = [
  'nativeExecution',
  'semanticFixtures',
  'noWriteFixtures',
  'dependencies',
  'compatibilityProbe',
  'relocation',
] as const
const CHECK_FIELDS = [
  'officialReadOnlyGraph',
  'absentNoWrite',
  'deleteRaceNoWrite',
  'renameRaceNoWrite',
  'privacy',
  'displayP3Vectors',
] as const
const TOOLCHAIN_FIELDS = ['zigSha256', 'linkerSha256', 'stripSha256', 'sdkOrSysrootSha256'] as const
const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/
const REVISION_PATTERN = /^[0-9a-f]{40}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/
const SENTINELS = [
  'PLAN065_PATH_SENTINEL',
  'PLAN065_SECRET_SENTINEL',
  'PLAN065_THEME_SENTINEL',
  'PLAN065_DIAGNOSTIC_SENTINEL',
] as const
const REPORT_HEADINGS = [
  '## 1. Summary',
  '## 2. Exact inputs and proof commands',
  '## 3. Exact build, module, generated-source, and resource graph',
  '## 4. Initialization, light/dark transition, ownership, and deinitialization',
  '## 5. Semantic fixture results',
  '## 6. No-write and privacy results',
  '## 7. Four-target evidence',
  '## 8. Proposed package layout, size ceiling, and runtime selection',
  '## 9. Known fidelity degradations and fallback recommendations',
  '## 10. Blockers and residual risks',
] as const
const BUNDLE_TABLE_HEADER =
  '| Target | Artifact bytes | Resource bytes | Bundle bytes | Package ceiling bytes |'
const BUNDLE_TABLE_SEPARATOR = '| --- | ---: | ---: | ---: | ---: |'
const BUNDLE_ROW_PATTERN =
  /^\| `(darwin-arm64|darwin-x64|linux-arm64|linux-x64)` \| (0|[1-9][0-9]{0,15}) \| (0|[1-9][0-9]{0,15}) \| (0|[1-9][0-9]{0,15}) \| ([1-9][0-9]{0,15}) \|$/
const BUNDLE_TOTAL_PATTERN =
  /^Total measured bundle bytes: (0|[1-9][0-9]{0,15}); total package ceiling bytes: ([1-9][0-9]{0,15})\.$/

type JsonObject = Record<string, unknown>
type Decision = (typeof DECISION_VALUES)[number]
type Acceptance = 'accepted' | 'pending'
type EvidenceArguments = {
  readonly requireCeilingAccepted: boolean
  readonly requirePass: boolean
}
type MatrixRow = JsonObject & {
  readonly runId: string
  readonly runAttempt: number
  readonly ghosttyWebGpuHead: string
  readonly artifactSha256: string | null
  readonly artifactBytes: number
}
type Ceilings = {
  readonly perTargetBytes: Readonly<Record<ProofTarget, number>>
  readonly totalPackageBytes: number
  readonly operatorAcceptance: Acceptance
}
type BundleMeasurement = {
  readonly artifactBytes: number
  readonly resourceBytes: number
  readonly bundleBytes: number
  readonly ceilingBytes: number
}
type BundleMeasurements = {
  readonly targets: Readonly<Record<ProofTarget, BundleMeasurement>>
  readonly totalBytes: number
  readonly totalCeilingBytes: number
}

class EvidenceFailure extends Error {}

function fail(message: string): never {
  throw new EvidenceFailure(message)
}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repository = join(scriptDir, '..', '..')
  const recipe = loadProofRecipe(join(scriptDir, 'proof-recipe.json'))
  const report = readBoundedFile(join(repository, 'docs/config-resolver-feasibility.md'), 'report')
  const evidence = readEvidence(join(repository, 'docs/config-resolver-feasibility.json'))
  verifyTopLevel(evidence, report)

  const checks = verifyChecks(evidence.checks)
  const rows = verifyMatrix(evidence.matrix, evidence, recipe.value.targets, recipe.sha256)
  const ceilings = verifyCeilings(evidence.ceilings)
  const measurements = verifyReportContract(report, evidence.decision as Decision, rows, ceilings)
  verifyDecision(evidence, checks, rows, ceilings, measurements)
  verifyRequiredModes(args, evidence, ceilings)
  process.stdout.write(`${JSON.stringify({ evidence: 'valid', decision: evidence.decision })}\n`)
}

function parseArguments(argv: readonly string[]): EvidenceArguments {
  const allowed = new Set(['--require-pass', '--require-ceiling-accepted'])
  const supplied = new Set<string>()
  for (const argument of argv) {
    if (!allowed.has(argument)) fail('unsupported argument')
    if (supplied.has(argument)) fail('duplicate argument')
    supplied.add(argument)
  }
  return {
    requireCeilingAccepted: supplied.has('--require-ceiling-accepted'),
    requirePass: supplied.has('--require-pass'),
  }
}

function readEvidence(path: string): JsonObject {
  const bytes = readBoundedFile(path, 'evidence')
  assertNoSentinel(bytes, 'evidence')
  const text = decodeUtf8(bytes, 'evidence')
  return asObject(parseJson(text), 'evidence')
}

function readBoundedFile(path: string, label: string): Buffer {
  const bytes = readFileSync(path)
  if (bytes.length < 1 || bytes.length > EVIDENCE_MAX_BYTES) {
    fail(`${label} byte length is invalid`)
  }
  return bytes
}

function verifyTopLevel(evidence: JsonObject, report: Buffer): void {
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
  assertEnum(evidence.decision, DECISION_VALUES, 'decision')
  assertRevision(evidence.ghosttyWebGpuHead, 'ghosttyWebGpuHead')
  if (evidence.upstreamRevision !== PROOF_UPSTREAM_REVISION) {
    fail('upstream revision does not match the pin')
  }
  if (evidence.zigVersion !== PROOF_ZIG_VERSION) fail('Zig version does not match the pin')
  assertHash(evidence.reportSha256, 'reportSha256')
  if (evidence.reportSha256 !== sha256(report)) fail('report digest does not match')
}

function verifyChecks(value: unknown): JsonObject {
  const checks = asObject(value, 'checks')
  assertKeys(checks, CHECK_FIELDS, 'checks')
  for (const field of CHECK_FIELDS) {
    assertEnum(checks[field], RESULT_VALUES, `checks ${field}`)
  }
  return checks
}

function verifyMatrix(
  value: unknown,
  evidence: JsonObject,
  recipeTargets: Readonly<Record<ProofTarget, ProofTargetRecipe>>,
  recipeSha256: string,
): readonly MatrixRow[] {
  const matrix = asObject(value, 'matrix')
  assertKeys(matrix, PROOF_TARGETS, 'matrix')
  const rows: MatrixRow[] = []
  for (const target of PROOF_TARGETS) {
    const row = verifyMatrixRow(
      matrix[target],
      target,
      evidence,
      recipeTargets[target],
      recipeSha256,
    )
    rows.push(row)
  }
  verifyRunIdentity(rows)
  return rows
}

function verifyMatrixRow(
  value: unknown,
  target: ProofTarget,
  evidence: JsonObject,
  recipeTarget: ProofTargetRecipe,
  recipeSha256: string,
): MatrixRow {
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
  assertPattern(row.runId, RUN_ID_PATTERN, `${target} runId`)
  assertInteger(row.runAttempt, 1, 100, `${target} runAttempt`)
  assertRevision(row.ghosttyWebGpuHead, `${target} ghosttyWebGpuHead`)
  if (row.ghosttyWebGpuHead !== evidence.ghosttyWebGpuHead) {
    fail(`${target} proof source HEAD does not match the top level`)
  }
  if (row.upstreamTreeSha256 !== PROOF_UPSTREAM_TREE_SHA256) {
    fail(`${target} upstream tree does not match the pin`)
  }
  if (row.proofRecipeSha256 !== recipeSha256) {
    fail(`${target} proof recipe digest does not match`)
  }
  assertInteger(row.sourceDateEpoch, 946_684_800, 4_102_444_800, `${target} sourceDateEpoch`)
  if (row.sourceDateEpoch !== PROOF_SOURCE_DATE_EPOCH) {
    fail(`${target} source epoch does not match the pin`)
  }
  verifyRunner(row.runner, target, recipeTarget.runner)
  verifyToolchain(row.toolchain, target, recipeTarget)
  verifyResultFields(row, target)
  verifyArtifact(row, target)
  return row as MatrixRow
}

function verifyRunner(value: unknown, target: ProofTarget, expected: ProofRunner): void {
  const runner = asObject(value, `${target} runner`)
  assertKeys(runner, ['arch', 'image', 'imageVersion', 'os'], `${target} runner`)
  const identity = targetIdentity(target)
  if (runner.os !== identity.os || runner.arch !== identity.arch) {
    fail(`${target} runner does not match the target`)
  }
  assertPrintableAscii(runner.image, `${target} runner image`)
  assertPrintableAscii(runner.imageVersion, `${target} runner imageVersion`)
  if (runner.os !== expected.os || runner.arch !== expected.arch) {
    fail(`${target} runner identity does not match the recipe`)
  }
  if (runner.image !== expected.image || runner.imageVersion !== expected.imageVersion) {
    fail(`${target} runner image does not match the recipe`)
  }
}

function verifyToolchain(
  value: unknown,
  target: ProofTarget,
  recipeTarget: ProofTargetRecipe,
): void {
  const toolchain = asObject(value, `${target} toolchain`)
  assertKeys(toolchain, TOOLCHAIN_FIELDS, `${target} toolchain`)
  const expected = toolchainHashes(recipeTarget)
  for (const field of TOOLCHAIN_FIELDS) {
    assertHash(toolchain[field], `${target} ${field}`)
    if (toolchain[field] !== expected[field]) {
      fail(`${target} ${field} does not match the recipe`)
    }
  }
}

function verifyResultFields(row: JsonObject, target: ProofTarget): void {
  for (const field of RESULT_FIELDS) {
    assertEnum(row[field], RESULT_VALUES, `${target} ${field}`)
  }
}

function verifyArtifact(row: JsonObject, target: ProofTarget): void {
  if (row.artifactSha256 === null) {
    if (row.artifactBytes !== 0) fail(`${target} absent artifact must have zero bytes`)
    return
  }
  assertHash(row.artifactSha256, `${target} artifactSha256`)
  assertInteger(row.artifactBytes, 1, Number.MAX_SAFE_INTEGER, `${target} artifactBytes`)
}

function verifyRunIdentity(rows: readonly MatrixRow[]): void {
  const first = rows[0]
  if (!first) fail('matrix has no rows')
  for (const row of rows.slice(1)) {
    if (row.runId !== first.runId) fail('matrix run IDs do not match')
    if (row.runAttempt !== first.runAttempt) fail('matrix run attempts do not match')
  }
}

function verifyCeilings(value: unknown): Ceilings {
  const ceilings = asObject(value, 'ceilings')
  assertKeys(ceilings, ['perTargetBytes', 'totalPackageBytes', 'operatorAcceptance'], 'ceilings')
  const perTarget = asObject(ceilings.perTargetBytes, 'per-target ceilings')
  assertKeys(perTarget, PROOF_TARGETS, 'per-target ceilings')
  for (const target of PROOF_TARGETS) {
    assertInteger(perTarget[target], 1, Number.MAX_SAFE_INTEGER, `${target} ceiling`)
  }
  assertInteger(ceilings.totalPackageBytes, 1, Number.MAX_SAFE_INTEGER, 'total package ceiling')
  assertEnum(ceilings.operatorAcceptance, ['pending', 'accepted'], 'operator ceiling acceptance')
  return {
    perTargetBytes: {
      'darwin-arm64': perTarget['darwin-arm64'] as number,
      'darwin-x64': perTarget['darwin-x64'] as number,
      'linux-arm64': perTarget['linux-arm64'] as number,
      'linux-x64': perTarget['linux-x64'] as number,
    },
    totalPackageBytes: ceilings.totalPackageBytes as number,
    operatorAcceptance: ceilings.operatorAcceptance as Acceptance,
  }
}

function verifyReportContract(
  report: Buffer,
  decision: Decision,
  rows: readonly MatrixRow[],
  ceilings: Ceilings,
): BundleMeasurements {
  assertNoSentinel(report, 'report')
  const text = decodeUtf8(report, 'report')
  const sections = reportSections(text)
  assertSummaryDecision(sections[0]!, decision)
  const finalLine = text.trimEnd().split('\n').at(-1)
  if (finalLine !== `Decision: ${decision}`) fail('report final decision does not match')
  const measurements = parseBundleMeasurements(sections[7]!)
  assertReportMeasurements(measurements, rows, ceilings)
  return measurements
}

function reportSections(text: string): readonly string[] {
  const lines = text.split('\n')
  const actual = lines.filter((line) => /^## [0-9]+\./.test(line))
  if (!sameStrings(actual, REPORT_HEADINGS)) fail('report headings do not match')
  return REPORT_HEADINGS.map((heading, index) => reportSection(lines, heading, index))
}

function reportSection(lines: readonly string[], heading: string, index: number): string {
  const start = lines.indexOf(heading)
  const nextHeading = REPORT_HEADINGS[index + 1]
  const end = nextHeading ? lines.indexOf(nextHeading) : lines.length
  if (start < 0 || end <= start + 1) fail('report section is empty')
  const section = lines.slice(start + 1, end).join('\n')
  if (!section.trim()) fail('report section is empty')
  return section
}

function assertSummaryDecision(summary: string, decision: Decision): void {
  const marker = `Decision: **${decision}**.`
  const matches = summary.split('\n').filter((line) => line === marker)
  if (matches.length !== 1) fail('report summary decision does not match')
}

function parseBundleMeasurements(section: string): BundleMeasurements {
  const lines = section.split('\n')
  const header = uniqueLineIndex(lines, BUNDLE_TABLE_HEADER, 'bundle table header')
  if (lines[header + 1] !== BUNDLE_TABLE_SEPARATOR) fail('bundle table separator does not match')
  if (lines.filter((line) => BUNDLE_ROW_PATTERN.test(line)).length !== PROOF_TARGETS.length) {
    fail('bundle table row count does not match')
  }
  const targets = bundleTargetRecord(lines, header + 2)
  const totalLines = lines.filter((line) => BUNDLE_TOTAL_PATTERN.test(line))
  if (totalLines.length !== 1) fail('bundle total line does not match')
  const totalLine = totalLines[0]!
  const totalMatch = BUNDLE_TOTAL_PATTERN.exec(totalLine)
  if (!totalMatch) fail('bundle total line does not match')
  return {
    targets,
    totalBytes: decimalValue(totalMatch[1], 0, 'total measured bundle bytes'),
    totalCeilingBytes: decimalValue(totalMatch[2], 1, 'total package ceiling bytes'),
  }
}

function uniqueLineIndex(lines: readonly string[], value: string, label: string): number {
  const indices: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === value) indices.push(index)
  }
  if (indices.length !== 1) fail(`${label} does not match`)
  return indices[0]!
}

function bundleTargetRecord(
  lines: readonly string[],
  start: number,
): Readonly<Record<ProofTarget, BundleMeasurement>> {
  const values = new Map<ProofTarget, BundleMeasurement>()
  for (let index = 0; index < PROOF_TARGETS.length; index += 1) {
    const expectedTarget = PROOF_TARGETS[index]
    if (!expectedTarget) fail('bundle target order is invalid')
    const line = lines[start + index]
    const match = line ? BUNDLE_ROW_PATTERN.exec(line) : null
    if (!match || match[1] !== expectedTarget) fail('bundle table target rows do not match')
    values.set(expectedTarget, bundleMeasurement(match, expectedTarget))
  }
  return {
    'darwin-arm64': requiredMeasurement(values, 'darwin-arm64'),
    'darwin-x64': requiredMeasurement(values, 'darwin-x64'),
    'linux-arm64': requiredMeasurement(values, 'linux-arm64'),
    'linux-x64': requiredMeasurement(values, 'linux-x64'),
  }
}

function bundleMeasurement(match: RegExpExecArray, target: ProofTarget): BundleMeasurement {
  const artifactBytes = decimalValue(match[2], 0, `${target} report artifact bytes`)
  const resourceBytes = decimalValue(match[3], 0, `${target} report resource bytes`)
  const bundleBytes = decimalValue(match[4], 0, `${target} report bundle bytes`)
  const ceilingBytes = decimalValue(match[5], 1, `${target} report ceiling bytes`)
  if (safeSum(artifactBytes, resourceBytes, `${target} report bundle bytes`) !== bundleBytes) {
    fail(`${target} report bundle arithmetic does not match`)
  }
  return { artifactBytes, resourceBytes, bundleBytes, ceilingBytes }
}

function decimalValue(value: string | undefined, minimum: 0 | 1, label: string): number {
  const pattern = minimum === 0 ? /^(?:0|[1-9][0-9]{0,15})$/ : /^[1-9][0-9]{0,15}$/
  if (!value || !pattern.test(value)) fail(`${label} is invalid`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) fail(`${label} is out of range`)
  return parsed
}

function requiredMeasurement(
  values: ReadonlyMap<ProofTarget, BundleMeasurement>,
  target: ProofTarget,
): BundleMeasurement {
  const value = values.get(target)
  if (!value) fail(`${target} bundle measurement is missing`)
  return value
}

function assertReportMeasurements(
  measurements: BundleMeasurements,
  rows: readonly MatrixRow[],
  ceilings: Ceilings,
): void {
  let totalBytes = 0
  for (const [index, target] of PROOF_TARGETS.entries()) {
    const row = rows[index]
    if (!row) fail(`${target} matrix row is missing`)
    const measurement = measurements.targets[target]
    if (measurement.artifactBytes !== row.artifactBytes) {
      fail(`${target} report artifact bytes do not match`)
    }
    if (measurement.ceilingBytes !== ceilings.perTargetBytes[target]) {
      fail(`${target} report ceiling does not match`)
    }
    totalBytes = safeSum(totalBytes, measurement.bundleBytes, 'report total bundle bytes')
  }
  if (measurements.totalBytes !== totalBytes)
    fail('report total measured bundle bytes do not match')
  if (measurements.totalCeilingBytes !== ceilings.totalPackageBytes) {
    fail('report total package ceiling does not match')
  }
}

function safeSum(left: number, right: number, label: string): number {
  const total = left + right
  if (!Number.isSafeInteger(total)) fail(`${label} is out of range`)
  return total
}

function verifyDecision(
  evidence: JsonObject,
  checks: JsonObject,
  rows: readonly MatrixRow[],
  ceilings: Ceilings,
  measurements: BundleMeasurements,
): void {
  const expected = expectedDecision(checks, rows, ceilings, measurements)
  if (evidence.decision !== expected) fail('evidence decision does not match its observations')
}

function expectedDecision(
  checks: JsonObject,
  rows: readonly MatrixRow[],
  ceilings: Ceilings,
  measurements: BundleMeasurements,
): Decision {
  if (hasResult(checks, CHECK_FIELDS, 'fail')) return 'FAIL'
  if (rows.some((row) => hasResult(row, RESULT_FIELDS, 'fail'))) return 'FAIL'
  if (bundleCeilingExceeded(measurements, ceilings)) return 'FAIL'
  if (hasResult(checks, CHECK_FIELDS, 'incomplete')) return 'INCOMPLETE'
  if (rows.some((row) => hasResult(row, RESULT_FIELDS, 'incomplete'))) return 'INCOMPLETE'
  if (rows.some((row) => row.artifactSha256 === null)) return 'INCOMPLETE'
  if (PROOF_TARGETS.some((target) => measurements.targets[target].resourceBytes < 1)) {
    return 'INCOMPLETE'
  }
  if (ceilings.operatorAcceptance !== 'accepted') return 'INCOMPLETE'
  return 'PASS'
}

function hasResult(
  value: JsonObject,
  fields: readonly string[],
  result: (typeof RESULT_VALUES)[number],
): boolean {
  return fields.some((field) => value[field] === result)
}

function bundleCeilingExceeded(measurements: BundleMeasurements, ceilings: Ceilings): boolean {
  for (const target of PROOF_TARGETS) {
    if (measurements.targets[target].bundleBytes > ceilings.perTargetBytes[target]) return true
  }
  return measurements.totalBytes > ceilings.totalPackageBytes
}

function verifyRequiredModes(
  args: EvidenceArguments,
  evidence: JsonObject,
  ceilings: Ceilings,
): void {
  if (args.requirePass && evidence.decision !== 'PASS') fail('PASS evidence required')
  if (args.requireCeilingAccepted && ceilings.operatorAcceptance !== 'accepted') {
    fail('accepted ceilings required')
  }
}

function targetIdentity(target: ProofTarget): Pick<ProofRunner, 'arch' | 'os'> {
  const os = target.startsWith('darwin-') ? 'darwin' : 'linux'
  const arch = target.endsWith('arm64') ? 'arm64' : 'x64'
  return { os, arch }
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }
  return value as JsonObject
}

function assertKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareUtf16)
  const sortedExpected = [...expected].sort(compareUtf16)
  if (!sameStrings(actual, sortedExpected)) fail(`${label} keys do not match`)
}

function assertInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value)) fail(`${label} must be an integer`)
  if ((value as number) < minimum || (value as number) > maximum) {
    fail(`${label} is out of range`)
  }
}

function assertRevision(value: unknown, label: string): asserts value is string {
  assertPattern(value, REVISION_PATTERN, label)
}

function assertHash(value: unknown, label: string): asserts value is string {
  assertPattern(value, HASH_PATTERN, label)
}

function assertPattern(value: unknown, pattern: RegExp, label: string): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} does not match`)
}

function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${label} is unsupported`)
  }
}

function assertPrintableAscii(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  const bytes = Buffer.byteLength(value)
  if (bytes < 1 || bytes > 256) fail(`${label} length is invalid`)
  if (!PRINTABLE_ASCII_PATTERN.test(value)) fail(`${label} must be printable ASCII`)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    fail('evidence is not valid JSON')
  }
}

function decodeUtf8(value: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    fail(`${label} is not valid UTF-8`)
  }
}

function assertNoSentinel(value: Buffer, label: string): void {
  const text = value.toString('utf8')
  if (SENTINELS.some((sentinel) => text.includes(sentinel))) {
    fail(`${label} leaked a privacy sentinel`)
  }
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

try {
  main()
} catch (error) {
  const known = error instanceof EvidenceFailure || error instanceof ProofContractError
  const reason = known ? error.message : 'unexpected evidence failure'
  process.stdout.write(`${JSON.stringify({ evidence: 'invalid', reason })}\n`)
  process.exitCode = 1
}
