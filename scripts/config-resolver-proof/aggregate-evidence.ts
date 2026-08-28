import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync, type Stats } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { resolve } from 'node:path'

import {
  PROOF_TARGETS,
  loadProofRecipe,
  toolchainHashes,
  type LoadedProofRecipe,
  type ProofRunner,
  type ProofTarget,
  type ProofTargetRecipe,
} from './proof-contract'

const RESULT_VALUES = ['pass', 'fail', 'incomplete'] as const
const ACCEPTANCE_VALUES = ['accepted', 'pending'] as const
const MAX_INPUT_BYTES = 2 * 1024 * 1024
const HASH_PATTERN = /^[0-9a-f]{64}$/
const HEAD_PATTERN = /^[0-9a-f]{40}$/
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/
const UPSTREAM_TREE_ENTRIES = 5_864
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
type Result = (typeof RESULT_VALUES)[number]
type Acceptance = (typeof ACCEPTANCE_VALUES)[number]
type Arguments = {
  readonly recipe: string
  readonly report: string
  readonly output: string
  readonly evidence: Readonly<Record<ProofTarget, string>>
  readonly ceilings: Readonly<Record<ProofTarget, number>>
  readonly totalPackageCeiling: number
  readonly operatorAcceptance: Acceptance
}
type TargetRow = {
  readonly runId: string
  readonly runAttempt: number
  readonly ghosttyWebGpuHead: string
  readonly upstreamTreeSha256: string
  readonly proofRecipeSha256: string
  readonly sourceDateEpoch: number
  readonly runner: ProofRunner
  readonly toolchain: ReturnType<typeof toolchainHashes>
  readonly nativeExecution: Result
  readonly artifactSha256: string
  readonly artifactBytes: number
  readonly semanticFixtures: Result
  readonly noWriteFixtures: Result
  readonly dependencies: Result
  readonly compatibilityProbe: Result
  readonly relocation: Result
}
type ResourceIdentity = {
  readonly sha256: string
  readonly bytes: number
  readonly entries: number
}
type ValidatedTarget = {
  readonly row: TargetRow
  readonly resources: ResourceIdentity
  readonly checks: Checks
}
type Checks = {
  readonly officialReadOnlyGraph: Result
  readonly absentNoWrite: Result
  readonly deleteRaceNoWrite: Result
  readonly renameRaceNoWrite: Result
  readonly privacy: Result
  readonly displayP3Vectors: Result
}
type BuildObservation = {
  readonly resources: ResourceIdentity
  readonly officialReadOnlyGraph: 'pass'
}
type VerifyChecks = Omit<Checks, 'officialReadOnlyGraph'>
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

class AggregateFailure extends Error {}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  const recipe = readRecipe(args.recipe)
  const targets = validateTargets(args, recipe)
  assertSharedIdentity(targets)
  const checks = observedChecks(targets)
  const ceilingOverrun = bundleCeilingExceeded(targets, args)
  const decision = decide(ceilingOverrun, args.operatorAcceptance)
  const report = readBoundedFile(args.report, 'report')
  validateReport(report, decision, targets, args)
  const evidence = assembleEvidence(recipe, targets, checks, args, report, decision)
  writeNewOutput(args.output, evidence)
  process.stdout.write(`${JSON.stringify({ result: 'pass', decision })}\n`)
}

function parseArguments(argv: readonly string[]): Arguments {
  const names = argumentNames()
  if (argv.length !== names.size * 2) throw new AggregateFailure('proof arguments do not match')
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !names.has(name)) throw new AggregateFailure('invalid proof argument')
    if (values.has(name)) throw new AggregateFailure('duplicate proof argument')
    values.set(name, value)
  }

  const evidence = targetStringRecord(values, 'evidence')
  assertUniqueEvidencePaths(evidence)
  const ceilings = targetIntegerRecord(values, 'ceiling')
  const acceptance = requiredValue(values, '--operator-acceptance')
  if (!ACCEPTANCE_VALUES.includes(acceptance as Acceptance)) {
    throw new AggregateFailure('operator acceptance does not match')
  }
  const output = resolve(requiredValue(values, '--output'))
  assertNewPath(output)
  return {
    recipe: resolve(requiredValue(values, '--recipe')),
    report: resolve(requiredValue(values, '--report')),
    output,
    evidence,
    ceilings,
    totalPackageCeiling: positiveDecimal(
      requiredValue(values, '--total-package-ceiling'),
      'total package ceiling',
    ),
    operatorAcceptance: acceptance as Acceptance,
  }
}

function argumentNames(): ReadonlySet<string> {
  const names = new Set([
    '--operator-acceptance',
    '--output',
    '--recipe',
    '--report',
    '--total-package-ceiling',
  ])
  for (const target of PROOF_TARGETS) {
    names.add(`--${target}-ceiling`)
    names.add(`--${target}-evidence`)
  }
  return names
}

function targetStringRecord(
  values: ReadonlyMap<string, string>,
  suffix: string,
): Readonly<Record<ProofTarget, string>> {
  return {
    'darwin-arm64': resolve(requiredValue(values, `--darwin-arm64-${suffix}`)),
    'darwin-x64': resolve(requiredValue(values, `--darwin-x64-${suffix}`)),
    'linux-arm64': resolve(requiredValue(values, `--linux-arm64-${suffix}`)),
    'linux-x64': resolve(requiredValue(values, `--linux-x64-${suffix}`)),
  }
}

function targetIntegerRecord(
  values: ReadonlyMap<string, string>,
  suffix: string,
): Readonly<Record<ProofTarget, number>> {
  return {
    'darwin-arm64': positiveDecimal(
      requiredValue(values, `--darwin-arm64-${suffix}`),
      'darwin-arm64 ceiling',
    ),
    'darwin-x64': positiveDecimal(
      requiredValue(values, `--darwin-x64-${suffix}`),
      'darwin-x64 ceiling',
    ),
    'linux-arm64': positiveDecimal(
      requiredValue(values, `--linux-arm64-${suffix}`),
      'linux-arm64 ceiling',
    ),
    'linux-x64': positiveDecimal(
      requiredValue(values, `--linux-x64-${suffix}`),
      'linux-x64 ceiling',
    ),
  }
}

function requiredValue(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new AggregateFailure(`missing ${name}`)
  return value
}

function positiveDecimal(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]{0,15}$/.test(value)) {
    throw new AggregateFailure(`${label} is invalid`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AggregateFailure(`${label} is outside its bound`)
  }
  return parsed
}

function nonnegativeDecimal(value: string | undefined, label: string): number {
  if (!value || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) {
    throw new AggregateFailure(`${label} is invalid`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AggregateFailure(`${label} is outside its bound`)
  }
  return parsed
}

function assertUniqueEvidencePaths(paths: Readonly<Record<ProofTarget, string>>): void {
  const unique = new Set(Object.values(paths))
  if (unique.size !== PROOF_TARGETS.length) {
    throw new AggregateFailure('target evidence paths must be unique')
  }
}

function assertNewPath(path: string): void {
  try {
    lstatSync(path)
  } catch (error) {
    if (isNotFound(error)) return
    throw error
  }
  throw new AggregateFailure('aggregate output already exists')
}

function readRecipe(path: string): LoadedProofRecipe {
  assertRegularFile(path, 'recipe')
  try {
    return loadProofRecipe(path)
  } catch {
    throw new AggregateFailure('recipe does not satisfy the proof contract')
  }
}

function validateTargets(
  args: Arguments,
  recipe: LoadedProofRecipe,
): Readonly<Record<ProofTarget, ValidatedTarget>> {
  return {
    'darwin-arm64': validateTarget(args.evidence['darwin-arm64'], 'darwin-arm64', recipe),
    'darwin-x64': validateTarget(args.evidence['darwin-x64'], 'darwin-x64', recipe),
    'linux-arm64': validateTarget(args.evidence['linux-arm64'], 'linux-arm64', recipe),
    'linux-x64': validateTarget(args.evidence['linux-x64'], 'linux-x64', recipe),
  }
}

function validateTarget(
  path: string,
  target: ProofTarget,
  recipe: LoadedProofRecipe,
): ValidatedTarget {
  const wrapper = readStrictWrapper(path, target)
  assertKeys(wrapper, ['kind', 'observations', 'row', 'schemaVersion', 'target'], target)
  if (wrapper.schemaVersion !== 1) throw new AggregateFailure(`${target} schemaVersion mismatch`)
  if (wrapper.kind !== 'config-resolver-target-evidence') {
    throw new AggregateFailure(`${target} evidence kind mismatch`)
  }
  if (wrapper.target !== target) throw new AggregateFailure(`${target} identity mismatch`)
  const row = validateRow(wrapper.row, target, recipe)
  const observations = asObject(wrapper.observations, `${target} observations`)
  assertKeys(observations, ['build', 'verify'], `${target} observations`)
  const build = asObject(observations.build, `${target} build observation`)
  const verify = asObject(observations.verify, `${target} verify observation`)
  const buildObservation = validateBuildObservation(build, target, row, recipe)
  const verifyChecks = validateVerifyObservation(verify, target, row, buildObservation.resources)
  return {
    row,
    resources: buildObservation.resources,
    checks: { officialReadOnlyGraph: buildObservation.officialReadOnlyGraph, ...verifyChecks },
  }
}

function readStrictWrapper(path: string, target: ProofTarget): JsonObject {
  const bytes = readBoundedFile(path, `${target} evidence`)
  assertNoSentinel(bytes, target)
  const text = decodeUtf8(bytes, `${target} evidence`)
  const value = parseJson(text, `${target} evidence`)
  const exact = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  if (!bytes.equals(exact)) {
    throw new AggregateFailure(`${target} evidence is not runner JSON plus one LF`)
  }
  return asObject(value, `${target} evidence`)
}

function validateRow(value: unknown, target: ProofTarget, recipe: LoadedProofRecipe): TargetRow {
  const row = asObject(value, `${target} row`)
  assertKeys(
    row,
    [
      'artifactBytes',
      'artifactSha256',
      'compatibilityProbe',
      'dependencies',
      'ghosttyWebGpuHead',
      'nativeExecution',
      'noWriteFixtures',
      'proofRecipeSha256',
      'relocation',
      'runAttempt',
      'runId',
      'runner',
      'semanticFixtures',
      'sourceDateEpoch',
      'toolchain',
      'upstreamTreeSha256',
    ],
    `${target} row`,
  )
  const targetRecipe = recipe.value.targets[target]
  const runner = validateRunner(row.runner, target, targetRecipe.runner)
  const toolchain = validateToolchain(row.toolchain, target, targetRecipe)
  const result = {
    runId: runIdValue(row.runId, `${target} runId`),
    runAttempt: integerValue(row.runAttempt, 1, 100, `${target} runAttempt`),
    ghosttyWebGpuHead: headValue(row.ghosttyWebGpuHead, `${target} source head`),
    upstreamTreeSha256: hashValue(row.upstreamTreeSha256, `${target} upstream tree`),
    proofRecipeSha256: hashValue(row.proofRecipeSha256, `${target} recipe hash`),
    sourceDateEpoch: integerValue(
      row.sourceDateEpoch,
      946_684_800,
      4_102_444_800,
      `${target} source epoch`,
    ),
    runner,
    toolchain,
    nativeExecution: passValue(row.nativeExecution, `${target} native execution`),
    artifactSha256: hashValue(row.artifactSha256, `${target} artifact hash`),
    artifactBytes: integerValue(
      row.artifactBytes,
      1,
      Number.MAX_SAFE_INTEGER,
      `${target} artifact bytes`,
    ),
    semanticFixtures: passValue(row.semanticFixtures, `${target} semantic fixtures`),
    noWriteFixtures: passValue(row.noWriteFixtures, `${target} no-write fixtures`),
    dependencies: passValue(row.dependencies, `${target} dependencies`),
    compatibilityProbe: passValue(row.compatibilityProbe, `${target} compatibility probe`),
    relocation: passValue(row.relocation, `${target} relocation`),
  } as const
  assertRowRecipeIdentity(result, target, recipe)
  return result
}

function validateRunner(value: unknown, target: ProofTarget, expected: ProofRunner): ProofRunner {
  const runner = asObject(value, `${target} runner`)
  assertKeys(runner, ['arch', 'image', 'imageVersion', 'os'], `${target} runner`)
  const result = {
    os: enumValue(runner.os, ['darwin', 'linux'], `${target} runner OS`),
    arch: enumValue(runner.arch, ['arm64', 'x64'], `${target} runner architecture`),
    image: printableAscii(runner.image, `${target} runner image`),
    imageVersion: printableAscii(runner.imageVersion, `${target} runner image version`),
  } as ProofRunner
  if (!isDeepStrictEqual(result, expected)) {
    throw new AggregateFailure(`${target} runner does not match the recipe`)
  }
  return result
}

function validateToolchain(
  value: unknown,
  target: ProofTarget,
  recipe: ProofTargetRecipe,
): ReturnType<typeof toolchainHashes> {
  const toolchain = asObject(value, `${target} toolchain`)
  assertKeys(
    toolchain,
    ['linkerSha256', 'sdkOrSysrootSha256', 'stripSha256', 'zigSha256'],
    `${target} toolchain`,
  )
  const result = {
    zigSha256: hashValue(toolchain.zigSha256, `${target} Zig hash`),
    linkerSha256: hashValue(toolchain.linkerSha256, `${target} linker hash`),
    stripSha256: hashValue(toolchain.stripSha256, `${target} strip hash`),
    sdkOrSysrootSha256: hashValue(toolchain.sdkOrSysrootSha256, `${target} SDK or sysroot hash`),
  }
  if (!isDeepStrictEqual(result, toolchainHashes(recipe))) {
    throw new AggregateFailure(`${target} toolchain does not match the recipe`)
  }
  return result
}

function assertRowRecipeIdentity(
  row: TargetRow,
  target: ProofTarget,
  recipe: LoadedProofRecipe,
): void {
  if (row.upstreamTreeSha256 !== recipe.value.upstream.treeSha256) {
    throw new AggregateFailure(`${target} upstream tree does not match the recipe`)
  }
  if (row.proofRecipeSha256 !== recipe.sha256) {
    throw new AggregateFailure(`${target} recipe digest does not match`)
  }
  if (row.sourceDateEpoch !== recipe.value.sourceDateEpoch) {
    throw new AggregateFailure(`${target} source epoch does not match the recipe`)
  }
}

function validateBuildObservation(
  build: JsonObject,
  target: ProofTarget,
  row: TargetRow,
  recipe: LoadedProofRecipe,
): BuildObservation {
  assertKeys(build, buildKeys(), `${target} build observation`)
  assertBuildIdentity(build, target, row, recipe)
  assertBuildRecipeTarget(build, target, recipe.value.targets[target])
  const officialReadOnlyGraph = passValue(
    build.officialReadOnlyGraph,
    `${target} official read-only graph`,
  )
  if (build.upstreamTreeEntries !== UPSTREAM_TREE_ENTRIES) {
    throw new AggregateFailure(`${target} upstream tree entry count does not match`)
  }
  const artifact = {
    sha256: hashValue(build.artifactSha256, `${target} build artifact hash`),
    bytes: integerValue(
      build.artifactBytes,
      1,
      Number.MAX_SAFE_INTEGER,
      `${target} build artifact bytes`,
    ),
  }
  if (artifact.sha256 !== row.artifactSha256 || artifact.bytes !== row.artifactBytes) {
    throw new AggregateFailure(`${target} build artifact does not match its row`)
  }
  printableAscii(build.fileOutput, `${target} file output`, 1024)
  return {
    officialReadOnlyGraph,
    resources: {
      sha256: hashValue(build.resourceTreeSha256, `${target} resource tree hash`),
      bytes: integerValue(
        build.resourceBytes,
        1,
        Number.MAX_SAFE_INTEGER,
        `${target} resource bytes`,
      ),
      entries: integerValue(
        build.resourceEntries,
        1,
        Number.MAX_SAFE_INTEGER,
        `${target} resource entries`,
      ),
    },
  }
}

function buildKeys(): readonly string[] {
  return [
    'artifactBytes',
    'artifactSha256',
    'buildArgv',
    'environment',
    'fileOutput',
    'ghosttyWebGpuHead',
    'inputs',
    'kind',
    'linkArgv',
    'officialReadOnlyGraph',
    'optimizationMode',
    'proofRecipeSha256',
    'resourceBytes',
    'resourceEntries',
    'resourceTreeSha256',
    'runAttempt',
    'runId',
    'runner',
    'schemaVersion',
    'sourceDateEpoch',
    'stripArgv',
    'target',
    'targetTriple',
    'tools',
    'upstreamRevision',
    'upstreamTreeEntries',
    'upstreamTreeSha256',
    'zigVersion',
  ]
}

function assertBuildIdentity(
  build: JsonObject,
  target: ProofTarget,
  row: TargetRow,
  recipe: LoadedProofRecipe,
): void {
  if (build.schemaVersion !== 1 || build.kind !== 'config-resolver-build') {
    throw new AggregateFailure(`${target} build identity does not match`)
  }
  const expected = {
    target,
    runId: row.runId,
    runAttempt: row.runAttempt,
    ghosttyWebGpuHead: row.ghosttyWebGpuHead,
    sourceDateEpoch: row.sourceDateEpoch,
    upstreamRevision: recipe.value.upstream.revision,
    upstreamTreeSha256: recipe.value.upstream.treeSha256,
    zigVersion: recipe.value.zigVersion,
    proofRecipeSha256: recipe.sha256,
  }
  for (const [key, value] of Object.entries(expected)) {
    if (build[key] !== value) throw new AggregateFailure(`${target} build ${key} does not match`)
  }
}

function assertBuildRecipeTarget(
  build: JsonObject,
  target: ProofTarget,
  expected: ProofTargetRecipe,
): void {
  const runner = asObject(build.runner, `${target} build runner`)
  assertKeys(runner, ['arch', 'image', 'imageVersion', 'label', 'os'], `${target} build runner`)
  printableAscii(runner.label, `${target} runner label`)
  const observed = {
    runner: {
      os: runner.os,
      arch: runner.arch,
      image: runner.image,
      imageVersion: runner.imageVersion,
    },
    targetTriple: build.targetTriple,
    optimizationMode: build.optimizationMode,
    buildArgv: build.buildArgv,
    linkArgv: build.linkArgv,
    stripArgv: build.stripArgv,
    environment: build.environment,
    tools: build.tools,
    inputs: build.inputs,
  }
  if (!isDeepStrictEqual(observed, expected)) {
    throw new AggregateFailure(`${target} build graph does not match the recipe`)
  }
}

function validateVerifyObservation(
  verify: JsonObject,
  target: ProofTarget,
  row: TargetRow,
  resources: ResourceIdentity,
): VerifyChecks {
  assertKeys(verify, verifyKeys(), `${target} verify observation`)
  if (verify.schemaVersion !== 1 || verify.target !== target) {
    throw new AggregateFailure(`${target} verify identity does not match`)
  }
  validateVerifyRunner(verify.runner, target)
  const checks = verifyPassingChecks(verify, target)
  assertVerifyArtifact(verify, target, row, resources)
  validateDependencyDetail(verify.dependencyDetail, target)
  validateCompatibilityDetail(verify.compatibilityDetail, target)
  validateFixtureDetail(verify.fixtureDetail, target)
  return checks
}

function verifyKeys(): readonly string[] {
  return [
    'absentNoWrite',
    'artifactBytes',
    'artifactSha256',
    'compatibilityDetail',
    'compatibilityProbe',
    'deleteRaceNoWrite',
    'dependencies',
    'dependencyDetail',
    'displayP3Vectors',
    'fixtureDetail',
    'nativeExecution',
    'noWriteFixtures',
    'privacy',
    'relocation',
    'renameRaceNoWrite',
    'resourceEntries',
    'resourcesBytes',
    'resourcesSha256',
    'runner',
    'schemaVersion',
    'semanticFixtures',
    'target',
  ]
}

function validateVerifyRunner(value: unknown, target: ProofTarget): void {
  const runner = asObject(value, `${target} native runner`)
  assertKeys(runner, ['arch', 'os', 'unameMachine', 'unameSystem'], `${target} native runner`)
  const expected = nativeRunner(target)
  if (!isDeepStrictEqual(runner, expected)) {
    throw new AggregateFailure(`${target} native runner does not match`)
  }
}

function nativeRunner(target: ProofTarget): JsonObject {
  if (target === 'darwin-arm64') {
    return { os: 'darwin', arch: 'arm64', unameSystem: 'Darwin', unameMachine: 'arm64' }
  }
  if (target === 'darwin-x64') {
    return { os: 'darwin', arch: 'x64', unameSystem: 'Darwin', unameMachine: 'x86_64' }
  }
  if (target === 'linux-arm64') {
    return { os: 'linux', arch: 'arm64', unameSystem: 'Linux', unameMachine: 'aarch64' }
  }
  return { os: 'linux', arch: 'x64', unameSystem: 'Linux', unameMachine: 'x86_64' }
}

function verifyPassingChecks(verify: JsonObject, target: ProofTarget): VerifyChecks {
  for (const key of [
    'compatibilityProbe',
    'dependencies',
    'nativeExecution',
    'noWriteFixtures',
    'relocation',
    'semanticFixtures',
  ] as const) {
    passValue(verify[key], `${target} verify ${key}`)
  }
  return {
    absentNoWrite: passValue(verify.absentNoWrite, `${target} verify absentNoWrite`),
    deleteRaceNoWrite: passValue(verify.deleteRaceNoWrite, `${target} verify deleteRaceNoWrite`),
    renameRaceNoWrite: passValue(verify.renameRaceNoWrite, `${target} verify renameRaceNoWrite`),
    privacy: passValue(verify.privacy, `${target} verify privacy`),
    displayP3Vectors: passValue(verify.displayP3Vectors, `${target} verify displayP3Vectors`),
  }
}

function assertVerifyArtifact(
  verify: JsonObject,
  target: ProofTarget,
  row: TargetRow,
  resources: ResourceIdentity,
): void {
  if (verify.artifactSha256 !== row.artifactSha256 || verify.artifactBytes !== row.artifactBytes) {
    throw new AggregateFailure(`${target} verify artifact does not match its row`)
  }
  if (verify.resourcesSha256 !== resources.sha256 || verify.resourcesBytes !== resources.bytes) {
    throw new AggregateFailure(`${target} build and verify resources disagree`)
  }
  if (verify.resourceEntries !== resources.entries) {
    throw new AggregateFailure(`${target} resource entry counts disagree`)
  }
}

function validateDependencyDetail(value: unknown, target: ProofTarget): void {
  const detail = asObject(value, `${target} dependency detail`)
  assertKeys(
    detail,
    ['entries', 'fileInspection', 'format', 'linkage', 'platformInspection'],
    `${target} dependency detail`,
  )
  const darwin = target.startsWith('darwin-')
  const expectedFormat = darwin ? 'mach-o-64' : 'elf64'
  const expectedLinkage = darwin ? 'system-dynamic' : 'static'
  if (detail.format !== expectedFormat || detail.linkage !== expectedLinkage) {
    throw new AggregateFailure(`${target} dependency format does not match`)
  }
  passValue(detail.fileInspection, `${target} file inspection`)
  passValue(detail.platformInspection, `${target} platform inspection`)
  const entries = stringArray(detail.entries, `${target} dependency entries`, 128, 512)
  assertSortedUnique(entries, `${target} dependency entries`)
  if (!darwin && entries.length !== 0) {
    throw new AggregateFailure(`${target} static artifact has dependency entries`)
  }
  if (darwin) assertDarwinDependencies(entries, target)
}

function assertDarwinDependencies(entries: readonly string[], target: ProofTarget): void {
  for (const entry of entries) {
    if (entry.startsWith('/usr/lib/')) continue
    if (entry.startsWith('/System/Library/Frameworks/')) continue
    if (entry.startsWith('/System/Library/PrivateFrameworks/')) continue
    throw new AggregateFailure(`${target} has a non-system dependency`)
  }
}

function validateCompatibilityDetail(value: unknown, target: ProofTarget): void {
  const detail = asObject(value, `${target} compatibility detail`)
  assertKeys(detail, ['bun', 'minimumOsVersion', 'node'], `${target} compatibility detail`)
  const minimum = target.startsWith('darwin-') ? '13.0.0' : '5.10.0'
  if (detail.minimumOsVersion !== minimum) {
    throw new AggregateFailure(`${target} minimum OS version does not match`)
  }
  const nodeHost = validateRuntimeProbe(detail.node, target, 'node', minimum)
  const bunHost = validateRuntimeProbe(detail.bun, target, 'bun', minimum)
  if (nodeHost !== bunHost) throw new AggregateFailure(`${target} runtime host versions disagree`)
}

function validateRuntimeProbe(
  value: unknown,
  target: ProofTarget,
  runtime: 'bun' | 'node',
  minimum: string,
): string {
  const probe = asObject(value, `${target} ${runtime} probe`)
  assertKeys(
    probe,
    [
      'hostVersion',
      'minimumOsVersion',
      'result',
      'runtime',
      'runtimeVersion',
      'schemaVersion',
      'target',
      'vectors',
    ],
    `${target} ${runtime} probe`,
  )
  if (probe.schemaVersion !== 1 || probe.target !== target || probe.runtime !== runtime) {
    throw new AggregateFailure(`${target} ${runtime} probe identity does not match`)
  }
  if (probe.minimumOsVersion !== minimum) {
    throw new AggregateFailure(`${target} ${runtime} probe minimum does not match`)
  }
  passValue(probe.result, `${target} ${runtime} probe result`)
  passValue(probe.vectors, `${target} ${runtime} probe vectors`)
  const host = versionValue(probe.hostVersion, `${target} ${runtime} host version`)
  printableAscii(probe.runtimeVersion, `${target} ${runtime} version`)
  return host
}

function validateFixtureDetail(value: unknown, target: ProofTarget): void {
  const detail = asObject(value, `${target} fixture detail`)
  assertKeys(
    detail,
    ['absentCases', 'deleteRaceCases', 'immutableSnapshots', 'renameRaceCases', 'semanticCases'],
    `${target} fixture detail`,
  )
  const darwin = target.startsWith('darwin-')
  const expected = darwin
    ? {
        semanticCases: 13,
        immutableSnapshots: 22,
        absentCases: 1,
        deleteRaceCases: 4,
        renameRaceCases: 4,
      }
    : {
        semanticCases: 10,
        immutableSnapshots: 15,
        absentCases: 1,
        deleteRaceCases: 2,
        renameRaceCases: 2,
      }
  if (!isDeepStrictEqual(detail, expected)) {
    throw new AggregateFailure(`${target} fixture observations do not match`)
  }
}

function assertSharedIdentity(targets: Readonly<Record<ProofTarget, ValidatedTarget>>): void {
  const first = targets['darwin-arm64'].row
  for (const target of PROOF_TARGETS) {
    const row = targets[target].row
    if (row.runId !== first.runId || row.runAttempt !== first.runAttempt) {
      throw new AggregateFailure('target run identities do not match')
    }
    if (row.ghosttyWebGpuHead !== first.ghosttyWebGpuHead) {
      throw new AggregateFailure('target source heads do not match')
    }
    if (row.proofRecipeSha256 !== first.proofRecipeSha256) {
      throw new AggregateFailure('target recipe identities do not match')
    }
    if (row.sourceDateEpoch !== first.sourceDateEpoch) {
      throw new AggregateFailure('target source epochs do not match')
    }
  }
}

function observedChecks(targets: Readonly<Record<ProofTarget, ValidatedTarget>>): Checks {
  const first = targets['darwin-arm64'].checks
  for (const target of PROOF_TARGETS) {
    if (!isDeepStrictEqual(targets[target].checks, first)) {
      throw new AggregateFailure('target check observations do not match')
    }
  }
  return first
}

// Closeout wrappers are emitted only after literal PASS observations on every native target.
function decide(ceilingOverrun: boolean, acceptance: Acceptance): 'PASS' | 'FAIL' | 'INCOMPLETE' {
  if (ceilingOverrun) return 'FAIL'
  if (acceptance !== 'accepted') return 'INCOMPLETE'
  return 'PASS'
}

function bundleCeilingExceeded(
  targets: Readonly<Record<ProofTarget, ValidatedTarget>>,
  args: Arguments,
): boolean {
  let totalBytes = 0
  for (const target of PROOF_TARGETS) {
    const observed = targets[target]
    const bundleBytes = safeSum(
      observed.row.artifactBytes,
      observed.resources.bytes,
      `${target} bundle bytes`,
    )
    if (bundleBytes > args.ceilings[target]) return true
    totalBytes = safeSum(totalBytes, bundleBytes, 'total measured bundle bytes')
  }
  return totalBytes > args.totalPackageCeiling
}

function safeSum(left: number, right: number, label: string): number {
  const total = left + right
  if (!Number.isSafeInteger(total)) throw new AggregateFailure(`${label} is outside its bound`)
  return total
}

function validateReport(
  report: Buffer,
  decision: 'PASS' | 'FAIL' | 'INCOMPLETE',
  targets: Readonly<Record<ProofTarget, ValidatedTarget>>,
  args: Arguments,
): void {
  assertNoSentinel(report, 'report')
  const text = decodeUtf8(report, 'report')
  const sections = reportSections(text)
  assertSummaryDecision(sections[0]!, decision)
  const finalLine = text.trimEnd().split('\n').at(-1)
  if (finalLine !== `Decision: ${decision}`) {
    throw new AggregateFailure('report final decision does not match the aggregate')
  }
  const measurements = parseBundleMeasurements(sections[7]!)
  assertReportMeasurements(measurements, targets, args)
}

function reportSections(text: string): readonly string[] {
  const lines = text.split('\n')
  const actual = lines.filter((line) => /^## [0-9]+\./.test(line))
  if (!isDeepStrictEqual(actual, REPORT_HEADINGS)) {
    throw new AggregateFailure('report headings do not match')
  }
  return REPORT_HEADINGS.map((heading, index) => reportSection(lines, heading, index))
}

function reportSection(lines: readonly string[], heading: string, index: number): string {
  const start = lines.indexOf(heading)
  const nextHeading = REPORT_HEADINGS[index + 1]
  const end = nextHeading ? lines.indexOf(nextHeading) : lines.length
  if (start < 0 || end <= start + 1) throw new AggregateFailure('report section is empty')
  const section = lines.slice(start + 1, end).join('\n')
  if (!section.trim()) throw new AggregateFailure('report section is empty')
  return section
}

function assertSummaryDecision(summary: string, decision: 'PASS' | 'FAIL' | 'INCOMPLETE'): void {
  const marker = `Decision: **${decision}**.`
  const matches = summary.split('\n').filter((line) => line === marker)
  if (matches.length !== 1) throw new AggregateFailure('report summary decision does not match')
}

function parseBundleMeasurements(section: string): BundleMeasurements {
  const lines = section.split('\n')
  const header = uniqueLineIndex(lines, BUNDLE_TABLE_HEADER, 'bundle table header')
  if (lines[header + 1] !== BUNDLE_TABLE_SEPARATOR) {
    throw new AggregateFailure('bundle table separator does not match')
  }
  if (lines.filter((line) => BUNDLE_ROW_PATTERN.test(line)).length !== PROOF_TARGETS.length) {
    throw new AggregateFailure('bundle table row count does not match')
  }
  const targets = bundleTargetRecord(lines, header + 2)
  const totalLines = lines.filter((line) => BUNDLE_TOTAL_PATTERN.test(line))
  if (totalLines.length !== 1) throw new AggregateFailure('bundle total line does not match')
  const totalLine = totalLines[0]!
  const totalMatch = BUNDLE_TOTAL_PATTERN.exec(totalLine)
  if (!totalMatch) throw new AggregateFailure('bundle total line does not match')
  return {
    targets,
    totalBytes: nonnegativeDecimal(totalMatch[1], 'total measured bundle bytes'),
    totalCeilingBytes: positiveDecimal(totalMatch[2], 'total package ceiling bytes'),
  }
}

function uniqueLineIndex(lines: readonly string[], value: string, label: string): number {
  const indices: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === value) indices.push(index)
  }
  if (indices.length !== 1) throw new AggregateFailure(`${label} does not match`)
  return indices[0]!
}

function bundleTargetRecord(
  lines: readonly string[],
  start: number,
): Readonly<Record<ProofTarget, BundleMeasurement>> {
  const values = new Map<ProofTarget, BundleMeasurement>()
  for (let index = 0; index < PROOF_TARGETS.length; index += 1) {
    const expectedTarget = PROOF_TARGETS[index]
    if (!expectedTarget) throw new AggregateFailure('bundle target order is invalid')
    const line = lines[start + index]
    const match = line ? BUNDLE_ROW_PATTERN.exec(line) : null
    if (!match || match[1] !== expectedTarget) {
      throw new AggregateFailure('bundle table target rows do not match')
    }
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
  const artifactBytes = nonnegativeDecimal(match[2], `${target} report artifact bytes`)
  const resourceBytes = nonnegativeDecimal(match[3], `${target} report resource bytes`)
  const bundleBytes = nonnegativeDecimal(match[4], `${target} report bundle bytes`)
  const ceilingBytes = positiveDecimal(match[5], `${target} report ceiling bytes`)
  if (safeSum(artifactBytes, resourceBytes, `${target} report bundle bytes`) !== bundleBytes) {
    throw new AggregateFailure(`${target} report bundle arithmetic does not match`)
  }
  return { artifactBytes, resourceBytes, bundleBytes, ceilingBytes }
}

function requiredMeasurement(
  values: ReadonlyMap<ProofTarget, BundleMeasurement>,
  target: ProofTarget,
): BundleMeasurement {
  const value = values.get(target)
  if (!value) throw new AggregateFailure(`${target} bundle measurement is missing`)
  return value
}

function assertReportMeasurements(
  measurements: BundleMeasurements,
  targets: Readonly<Record<ProofTarget, ValidatedTarget>>,
  args: Arguments,
): void {
  let totalBytes = 0
  for (const target of PROOF_TARGETS) {
    const measurement = measurements.targets[target]
    const observed = targets[target]
    if (measurement.artifactBytes !== observed.row.artifactBytes) {
      throw new AggregateFailure(`${target} report artifact bytes do not match`)
    }
    if (measurement.resourceBytes !== observed.resources.bytes) {
      throw new AggregateFailure(`${target} report resource bytes do not match`)
    }
    if (measurement.ceilingBytes !== args.ceilings[target]) {
      throw new AggregateFailure(`${target} report ceiling does not match`)
    }
    totalBytes = safeSum(totalBytes, measurement.bundleBytes, 'report total bundle bytes')
  }
  if (measurements.totalBytes !== totalBytes) {
    throw new AggregateFailure('report total measured bundle bytes do not match')
  }
  if (measurements.totalCeilingBytes !== args.totalPackageCeiling) {
    throw new AggregateFailure('report total package ceiling does not match')
  }
}

function assembleEvidence(
  recipe: LoadedProofRecipe,
  targets: Readonly<Record<ProofTarget, ValidatedTarget>>,
  checks: Checks,
  args: Arguments,
  report: Buffer,
  decision: 'PASS' | 'FAIL' | 'INCOMPLETE',
): JsonObject {
  return {
    schemaVersion: 1,
    decision,
    ghosttyWebGpuHead: targets['darwin-arm64'].row.ghosttyWebGpuHead,
    upstreamRevision: recipe.value.upstream.revision,
    zigVersion: recipe.value.zigVersion,
    reportSha256: sha256(report),
    checks,
    matrix: {
      'darwin-arm64': targets['darwin-arm64'].row,
      'darwin-x64': targets['darwin-x64'].row,
      'linux-arm64': targets['linux-arm64'].row,
      'linux-x64': targets['linux-x64'].row,
    },
    ceilings: {
      perTargetBytes: args.ceilings,
      totalPackageBytes: args.totalPackageCeiling,
      operatorAcceptance: args.operatorAcceptance,
    },
  }
}

function writeNewOutput(path: string, evidence: JsonObject): void {
  const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  assertNoSentinel(bytes, 'aggregate output')
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
  } catch {
    throw new AggregateFailure('aggregate output could not be created')
  }
}

function readBoundedFile(path: string, label: string): Buffer {
  const before = assertRegularFile(path, label)
  const bytes = readFileSync(path)
  const after = lstatSync(path)
  if (bytes.length < 1 || bytes.length > MAX_INPUT_BYTES) {
    throw new AggregateFailure(`${label} length is invalid`)
  }
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new AggregateFailure(`${label} changed while reading`)
  }
  return bytes
}

function assertRegularFile(path: string, label: string): Stats {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AggregateFailure(`${label} is not a regular file`)
  }
  return stat
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new AggregateFailure(`${label} is not UTF-8`)
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new AggregateFailure(`${label} is not JSON`)
  }
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AggregateFailure(`${label} must be an object`)
  }
  return value as JsonObject
}

function assertKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (!isDeepStrictEqual(actual, sortedExpected)) {
    throw new AggregateFailure(`${label} keys do not match`)
  }
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AggregateFailure(`${label} has an unsupported value`)
  }
  return value as T
}

function passValue(value: unknown, label: string): 'pass' {
  if (value !== 'pass') throw new AggregateFailure(`${label} did not pass`)
  return value
}

function printableAscii(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new AggregateFailure(`${label} is not bounded ASCII`)
  }
  if (!PRINTABLE_ASCII_PATTERN.test(value)) {
    throw new AggregateFailure(`${label} is not printable ASCII`)
  }
  return value
}

function stringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumBytes: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new AggregateFailure(`${label} is not a bounded array`)
  }
  return value.map((item, index) => printableAscii(item, `${label}[${index}]`, maximumBytes))
}

function assertSortedUnique(values: readonly string[], label: string): void {
  const expected = [...values].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )
  if (!isDeepStrictEqual(values, expected) || new Set(values).size !== values.length) {
    throw new AggregateFailure(`${label} is not sorted and unique`)
  }
}

function integerValue(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AggregateFailure(`${label} is outside its bound`)
  }
  return value as number
}

function hashValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new AggregateFailure(`${label} is not a SHA-256 digest`)
  }
  return value
}

function headValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HEAD_PATTERN.test(value)) {
    throw new AggregateFailure(`${label} is not a Git object ID`)
  }
  return value
}

function runIdValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new AggregateFailure(`${label} is invalid`)
  }
  return value
}

function versionValue(value: unknown, label: string): string {
  const version = printableAscii(value, label)
  if (!VERSION_PATTERN.test(version)) throw new AggregateFailure(`${label} is invalid`)
  return version
}

function assertNoSentinel(bytes: Buffer, label: string): void {
  const text = bytes.toString('utf8')
  if (SENTINELS.some((sentinel) => text.includes(sentinel))) {
    throw new AggregateFailure(`${label} leaked a privacy sentinel`)
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

try {
  main()
} catch (error) {
  const reason = error instanceof AggregateFailure ? error.message : 'unexpected aggregate failure'
  process.stdout.write(`${JSON.stringify({ result: 'fail', reason })}\n`)
  process.exitCode = 1
}
