import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectNativeBundle } from './artifacts'
import { canonicalObjectBytes, NativeContractError, readStableRegularFile } from './canonical'
import {
  NATIVE_BUILD_RECIPE_PATH,
  NATIVE_SOURCE_DATE_EPOCH,
  NATIVE_TARGET_CONFIG,
  NATIVE_UPSTREAM_REVISION,
  NATIVE_UPSTREAM_TREE_SHA256,
  type NativeTarget,
} from './constants'
import {
  loadBuildRecipe,
  validateNativeArtifactProvenance,
  type NativeArtifactProvenance,
  type NativeTargetRecipe,
  type NativeToolRecord,
} from './contract'
import { verifyNativeInputs } from './inputs'
import { projectNativeLinkPlan, tokenizeNativePath } from './link-plan'
import { writeDeterministicUstar } from './ustar'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export type BuildTargetOptions = {
  readonly upstream: string
  readonly zig: string
  readonly zigArchive: string
  readonly themesArchive: string
  readonly target: NativeTarget
  readonly output: string
  readonly runId: string
  readonly runAttempt: number
  readonly expectedHead: string
  readonly bun: string
  readonly node: string
}

type BuildEvidence = {
  readonly target: NativeTarget
  readonly runId: string
  readonly runAttempt: number
  readonly ghosttyWebGpuHead: string
  readonly buildRecipeSha256: string
  readonly linkArgv: readonly string[]
}

export function buildNativeTarget(options: BuildTargetOptions): {
  readonly archive: string
  readonly provenance: string
  readonly archiveSha256: string
} {
  assertBuildOptions(options)
  const inputs = verifyNativeInputs(repositoryRoot, {
    gitHead: options.expectedHead,
    requireCurrentCleanHead: true,
  })
  const recipe = loadBuildRecipe(join(repositoryRoot, NATIVE_BUILD_RECIPE_PATH))
  const output = resolve(options.output)
  if (exists(output)) throw new NativeContractError('native build output already exists')
  mkdirSync(output, { mode: 0o755 })
  const bundle = join(output, 'bundle')
  const buildEvidencePath = join(output, 'build-evidence.json')
  runMaintainedScript(
    'build-helper.ts',
    [
      '--mode',
      'build',
      '--upstream',
      options.upstream,
      '--zig',
      options.zig,
      '--zig-archive',
      options.zigArchive,
      '--themes-archive',
      options.themesArchive,
      '--target',
      options.target,
      '--output',
      bundle,
      '--evidence',
      buildEvidencePath,
    ],
    buildEnvironment(options),
  )
  const evidence = loadBuildEvidence(buildEvidencePath, options, recipe.sha256)
  verifyObservedLinkPlan(evidence.linkArgv, options.target, recipe.value.targets[options.target])
  const verificationPath = join(output, 'verification.json')
  runMaintainedScript(
    'verify-helper.ts',
    [
      '--helper',
      join(bundle, 'bin/ghostty-config-resolver'),
      '--resources',
      join(bundle, 'resources'),
      '--target',
      options.target,
      '--evidence',
      verificationPath,
      '--bun',
      options.bun,
      '--node',
      options.node,
    ],
    process.env,
  )
  verifyNativeChecks(verificationPath, options.target)
  const inspected = inspectNativeBundle(bundle, options.target)
  const archiveName = `ghostty-config-resolver-${options.target}.tar`
  const archivePath = join(output, archiveName)
  const archive = writeDeterministicUstar(
    bundle,
    inspected.files,
    archivePath,
    NATIVE_SOURCE_DATE_EPOCH,
  )
  const provenance = createProvenance(
    options,
    recipe.value.targets[options.target],
    recipe.sha256,
    inputs.sha256,
    inspected,
    archiveName,
    archive,
  )
  const provenancePath = join(output, 'provenance.json')
  writeFileSync(provenancePath, canonicalObjectBytes(provenance), { flag: 'wx', mode: 0o644 })
  return { archive: archivePath, provenance: provenancePath, archiveSha256: archive.sha256 }
}

function createProvenance(
  options: BuildTargetOptions,
  recipe: NativeTargetRecipe,
  recipeSha256: string,
  inputsSha256: string,
  inspected: ReturnType<typeof inspectNativeBundle>,
  archiveName: string,
  archive: { readonly bytes: number; readonly sha256: string },
): NativeArtifactProvenance {
  return validateNativeArtifactProvenance({
    schemaVersion: 1,
    runId: options.runId,
    runAttempt: options.runAttempt,
    nativeBuildSourceHead: options.expectedHead,
    nativeInputsTreeSha256: inputsSha256,
    sourceTree: 'clean',
    sourceDateEpoch: NATIVE_SOURCE_DATE_EPOCH,
    target: options.target,
    upstreamRevision: NATIVE_UPSTREAM_REVISION,
    upstreamTreeSha256: NATIVE_UPSTREAM_TREE_SHA256,
    runner: recipe.runner,
    toolchain: nativeProvenanceToolchain(recipe, recipeSha256),
    archive: { file: archiveName, sha256: archive.sha256, bytes: archive.bytes },
    files: inspected.files,
    compatibility: inspected.compatibility,
    checks: {
      semantic: 'pass',
      noWrite: 'pass',
      privacy: 'pass',
      relocation: 'pass',
      dependencies: 'pass',
    },
  })
}

export function nativeProvenanceToolchain(
  recipe: NativeTargetRecipe,
  buildRecipeSha256: string,
): NativeArtifactProvenance['toolchain'] {
  const zig = requiredTool(recipe, 'zig')
  const linker = requiredTool(recipe, 'linker')
  const strip = requiredTool(recipe, 'strip')
  const sdk = requiredTool(recipe, 'sdk-or-sysroot')
  return {
    zig: { version: '0.16.0', sha256: zig.sha256 },
    linker: nativeTool(linker),
    strip: nativeTool(strip),
    sdk: sdkRecord(sdk),
    buildRecipeSha256,
  }
}

function nativeTool(tool: NativeToolRecord): {
  readonly name: string
  readonly version: string
  readonly sha256: string
} {
  return { name: tool.name, version: tool.version, sha256: tool.sha256 }
}

function sdkRecord(tool: NativeToolRecord): NativeArtifactProvenance['toolchain']['sdk'] {
  if (tool.acquisition.kind === 'runner-component' && tool.acquisition.macosSdk) {
    return {
      kind: 'macos',
      xcodeVersion: tool.acquisition.macosSdk.xcodeVersion,
      xcodeBuild: tool.acquisition.macosSdk.xcodeBuild,
      sdkVersion: tool.acquisition.macosSdk.sdkVersion,
      sdkSettingsSha256: tool.acquisition.macosSdk.sdkSettingsSha256,
    }
  }
  return {
    kind: 'linux',
    sysrootName: tool.name,
    sysrootVersion: tool.version,
    sysrootSha256: tool.sha256,
  }
}

function requiredTool(
  recipe: NativeTargetRecipe,
  role: NativeToolRecord['role'],
): NativeToolRecord {
  const matches = recipe.tools.filter((tool) => tool.role === role)
  if (matches.length !== 1) throw new NativeContractError(`native recipe ${role} is not unique`)
  return matches[0]!
}

function verifyObservedLinkPlan(
  raw: readonly string[],
  target: NativeTarget,
  recipe: NativeTargetRecipe,
): void {
  const sdk = requiredTool(recipe, 'sdk-or-sysroot')
  const sdkPath = sdk.acquisition.kind === 'runner-component' ? sdk.acquisition.path : null
  let projected = projectNativeLinkPlan(raw, target)
  if (sdkPath) {
    projected = projected.map((argument) =>
      tokenizeNativePath(argument, sdkPath).replaceAll('$WORK', '$SDK'),
    )
  }
  if (!canonicalObjectBytes(projected).equals(canonicalObjectBytes(recipe.linkPlan))) {
    throw new NativeContractError('raw observed link argv differs from maintained linkPlan')
  }
}

function loadBuildEvidence(
  path: string,
  options: BuildTargetOptions,
  recipeSha256: string,
): BuildEvidence {
  const bytes = readStableRegularFile(path, 4 * 1024 * 1024)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new NativeContractError('transient native build evidence is invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NativeContractError('transient native build evidence is not an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.target !== options.target || record.runId !== options.runId) {
    throw new NativeContractError('transient native build evidence identity differs')
  }
  if (
    record.runAttempt !== options.runAttempt ||
    record.ghosttyWebGpuHead !== options.expectedHead
  ) {
    throw new NativeContractError('transient native build evidence source differs')
  }
  if (record.buildRecipeSha256 !== recipeSha256 || !stringArray(record.linkArgv)) {
    throw new NativeContractError('transient native build evidence recipe differs')
  }
  return record as BuildEvidence
}

function verifyNativeChecks(path: string, target: NativeTarget): void {
  const bytes = readStableRegularFile(path, 256 * 1024)
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new NativeContractError('native verification evidence is invalid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NativeContractError('native verification evidence is not an object')
  }
  const record = value as Record<string, unknown>
  const passKeys = [
    'nativeExecution',
    'semanticFixtures',
    'noWriteFixtures',
    'absentNoWrite',
    'deleteRaceNoWrite',
    'renameRaceNoWrite',
    'privacy',
    'dependencies',
    'compatibilityProbe',
    'relocation',
    'displayP3Vectors',
  ]
  if (record.target !== target || passKeys.some((key) => record[key] !== 'pass')) {
    throw new NativeContractError('native verification evidence does not pass')
  }
}

function assertBuildOptions(options: BuildTargetOptions): void {
  if (!/^[1-9][0-9]{0,19}$/.test(options.runId)) throw new NativeContractError('run ID is invalid')
  if (!Number.isInteger(options.runAttempt) || options.runAttempt < 1 || options.runAttempt > 100) {
    throw new NativeContractError('run attempt is invalid')
  }
  if (!/^[0-9a-f]{40}$/.test(options.expectedHead)) {
    throw new NativeContractError('expected native source HEAD is invalid')
  }
  if (!(options.target in NATIVE_TARGET_CONFIG))
    throw new NativeContractError('native target is invalid')
  const config = NATIVE_TARGET_CONFIG[options.target]
  if (process.env.ImageOS !== config.image || process.env.ImageVersion !== config.imageVersion) {
    throw new NativeContractError('native runner image identity differs from the recipe')
  }
  const expectedPlatform = config.os === 'darwin' ? 'darwin' : 'linux'
  const expectedArch = config.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform !== expectedPlatform || process.arch !== expectedArch) {
    throw new NativeContractError('native host does not match the requested target')
  }
}

function buildEnvironment(options: BuildTargetOptions): NodeJS.ProcessEnv {
  const config = NATIVE_TARGET_CONFIG[options.target]
  return {
    EXPECTED_HEAD: options.expectedHead,
    ImageOS: config.image,
    ImageVersion: config.imageVersion,
    NATIVE_RUN_ATTEMPT: String(options.runAttempt),
    NATIVE_RUN_ID: options.runId,
    NATIVE_RUNNER_LABEL: config.runner,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  }
}

function runMaintainedScript(
  filename: string,
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): void {
  const script = join(repositoryRoot, 'scripts/config-resolver-native', filename)
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd: repositoryRoot,
    encoding: 'buffer',
    env: environment,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) throw new NativeContractError(`maintained ${filename} failed`)
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
