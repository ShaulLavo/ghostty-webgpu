import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { inspectNativeBundle } from './artifacts'
import {
  canonicalObjectBytes,
  canonicalSha256,
  NativeContractError,
  readStableRegularFile,
  sha256,
} from './canonical'
import {
  NATIVE_BOOTSTRAP_PATH,
  NATIVE_BUILD_RECIPE_PATH,
  NATIVE_EXECUTABLE_PATH,
  NATIVE_MANIFEST_PATH,
  NATIVE_RESOURCES_ROOT,
  NATIVE_SOURCE_DATE_EPOCH,
  NATIVE_TARGET_CEILINGS,
  NATIVE_TARGETS,
  NATIVE_TOTAL_CEILING,
  NATIVE_UPSTREAM_REVISION,
  NATIVE_UPSTREAM_TREE_SHA256,
  type NativeTarget,
} from './constants'
import {
  loadBuildRecipe,
  loadNativeProvenance,
  validateNativeResolverManifest,
  type NativeArtifactProvenance,
  type NativeManifestTarget,
  type NativeResolverManifest,
} from './contract'
import { nativeProvenanceToolchain } from './builder'
import { verifyNativeInputs } from './inputs'
import { verifyNativeRepositoryState } from './state'
import { extractVerifiedUstar, verifyUstarArchive } from './ustar'

export type AssembleNativeOptions = {
  readonly input: string
  readonly runId: string
  readonly runAttempt: number
}

type ArtifactPair = {
  readonly archivePath: string
  readonly provenancePath: string
}

type VerifiedArtifact = {
  readonly archivePath: string
  readonly provenance: NativeArtifactProvenance
  readonly entries: ReturnType<typeof verifyUstarArchive>
}

export function assembleNativeArtifacts(
  repositoryRoot: string,
  options: AssembleNativeOptions,
): NativeResolverManifest {
  assertRunIdentity(options.runId, options.runAttempt)
  verifyNativeRepositoryState(repositoryRoot, 'bootstrap')
  const artifacts = discoverArtifactPairs(resolve(options.input)).map((pair) =>
    loadArtifactPair(pair, options),
  )
  assertCompleteTargets(artifacts)
  const first = artifacts[0]
  if (!first) throw new NativeContractError('native assembly has no artifacts')
  const inputs = verifyNativeInputs(repositoryRoot, {
    gitHead: first.provenance.nativeBuildSourceHead,
    requireCurrentCleanHead: true,
  })
  const recipe = loadBuildRecipe(join(repositoryRoot, NATIVE_BUILD_RECIPE_PATH))
  for (const artifact of artifacts) verifyArtifactIdentity(artifact, first, inputs.sha256, recipe)

  const activeRoot = join(repositoryRoot, dirname(NATIVE_BOOTSTRAP_PATH))
  const nativeRoot = dirname(activeRoot)
  const stagingRoot = mkdtempSync(join(nativeRoot, '.config-resolver-assemble-'))
  chmodSync(stagingRoot, 0o755)
  try {
    const targets = stageTargets(stagingRoot, artifacts)
    const manifest = validateNativeResolverManifest({
      schemaVersion: 1,
      upstreamRevision: NATIVE_UPSTREAM_REVISION,
      upstreamTreeSha256: NATIVE_UPSTREAM_TREE_SHA256,
      nativeBuildSourceHead: first.provenance.nativeBuildSourceHead,
      nativeInputsTreeSha256: inputs.sha256,
      sourceDateEpoch: NATIVE_SOURCE_DATE_EPOCH,
      ceilings: {
        perTargetBytes: NATIVE_TARGET_CEILINGS,
        totalPackageBytes: NATIVE_TOTAL_CEILING,
      },
      targets,
    })
    writeFileSync(
      join(stagingRoot, basename(NATIVE_MANIFEST_PATH)),
      canonicalObjectBytes(manifest),
      {
        flag: 'wx',
        mode: 0o644,
      },
    )
    verifyStagedManifest(stagingRoot, manifest)
    transitionFromBootstrap(activeRoot, stagingRoot)
    return manifest
  } catch (error) {
    removeOwnedStaging(stagingRoot)
    throw error
  }
}

function discoverArtifactPairs(input: string): readonly ArtifactPair[] {
  assertRealDirectory(input, 'native artifact input')
  const files: string[] = []
  walkArtifactInput(input, input, files, 0)
  if (files.length !== NATIVE_TARGETS.length * 2) {
    throw new NativeContractError('native artifact input does not contain four exact pairs')
  }
  const grouped = new Map<string, string[]>()
  for (const path of files) {
    const parent = dirname(path)
    const current = grouped.get(parent) ?? []
    current.push(path)
    grouped.set(parent, current)
  }
  if (grouped.size !== NATIVE_TARGETS.length) {
    throw new NativeContractError('native transport pairs do not have distinct directories')
  }
  return [...grouped.values()].map(artifactPair)
}

function walkArtifactInput(root: string, current: string, files: string[], depth: number): number {
  if (depth > 4) throw new NativeContractError('native artifact input is nested too deeply')
  const entries = readdirSync(current, { encoding: 'utf8' })
  if (current !== root && entries.length === 0) {
    throw new NativeContractError('native artifact input contains an empty directory')
  }
  let descendants = 0
  for (const name of entries) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new NativeContractError('native artifact input has an invalid entry name')
    }
    const path = join(current, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink())
      throw new NativeContractError('native artifact input contains a symlink')
    if (stat.isDirectory()) {
      descendants += walkArtifactInput(root, path, files, depth + 1)
      continue
    }
    if (!stat.isFile())
      throw new NativeContractError('native artifact input contains a special file')
    files.push(path)
    descendants += 1
  }
  return descendants
}

function artifactPair(files: readonly string[]): ArtifactPair {
  if (files.length !== 2) throw new NativeContractError('native transport artifact is not a pair')
  const provenance = files.find((path) => basename(path) === 'provenance.json')
  const archives = files.filter((path) =>
    /^ghostty-config-resolver-[a-z0-9-]+\.tar$/.test(basename(path)),
  )
  if (!provenance || archives.length !== 1) {
    throw new NativeContractError('native transport artifact has unexpected files')
  }
  return { provenancePath: provenance, archivePath: archives[0]! }
}

function loadArtifactPair(pair: ArtifactPair, options: AssembleNativeOptions): VerifiedArtifact {
  const provenance = loadNativeProvenance(pair.provenancePath).value
  if (provenance.runId !== options.runId || provenance.runAttempt !== options.runAttempt) {
    throw new NativeContractError('native artifact run identity differs from assembly request')
  }
  if (basename(pair.archivePath) !== provenance.archive.file) {
    throw new NativeContractError('native archive name differs from provenance')
  }
  const maximum = NATIVE_TARGET_CEILINGS[provenance.target] + 1_048_576
  const bytes = readStableRegularFile(pair.archivePath, maximum)
  if (bytes.length !== provenance.archive.bytes || sha256(bytes) !== provenance.archive.sha256) {
    throw new NativeContractError('native transport archive differs from provenance')
  }
  const entries = verifyUstarArchive(pair.archivePath, provenance.files, provenance.sourceDateEpoch)
  return { archivePath: pair.archivePath, provenance, entries }
}

function assertCompleteTargets(artifacts: readonly VerifiedArtifact[]): void {
  const targets = artifacts.map((artifact) => artifact.provenance.target).sort()
  const expected = [...NATIVE_TARGETS].sort()
  if (JSON.stringify(targets) !== JSON.stringify(expected)) {
    throw new NativeContractError('native assembly target set is incomplete or duplicated')
  }
}

function verifyArtifactIdentity(
  artifact: VerifiedArtifact,
  first: VerifiedArtifact,
  nativeInputsSha256: string,
  recipe: ReturnType<typeof loadBuildRecipe>,
): void {
  const provenance = artifact.provenance
  const targetRecipe = recipe.value.targets[provenance.target]
  if (provenance.nativeInputsTreeSha256 !== nativeInputsSha256) {
    throw new NativeContractError('native provenance input digest differs')
  }
  if (provenance.toolchain.buildRecipeSha256 !== recipe.sha256) {
    throw new NativeContractError('native provenance recipe digest differs')
  }
  if (!canonicalObjectBytes(provenance.runner).equals(canonicalObjectBytes(targetRecipe.runner))) {
    throw new NativeContractError('native provenance runner differs from the recipe')
  }
  const expectedToolchain = nativeProvenanceToolchain(targetRecipe, recipe.sha256)
  if (!canonicalObjectBytes(provenance.toolchain).equals(canonicalObjectBytes(expectedToolchain))) {
    throw new NativeContractError('native provenance toolchain differs from the recipe')
  }
  assertSharedProvenanceIdentity(first.provenance, provenance)
}

function assertSharedProvenanceIdentity(
  left: NativeArtifactProvenance,
  right: NativeArtifactProvenance,
): void {
  const leftIdentity = sharedIdentity(left)
  const rightIdentity = sharedIdentity(right)
  if (!canonicalObjectBytes(leftIdentity).equals(canonicalObjectBytes(rightIdentity))) {
    throw new NativeContractError('native artifacts mix source, run, or upstream identities')
  }
}

function sharedIdentity(provenance: NativeArtifactProvenance): object {
  return {
    runId: provenance.runId,
    runAttempt: provenance.runAttempt,
    nativeBuildSourceHead: provenance.nativeBuildSourceHead,
    nativeInputsTreeSha256: provenance.nativeInputsTreeSha256,
    sourceTree: provenance.sourceTree,
    sourceDateEpoch: provenance.sourceDateEpoch,
    upstreamRevision: provenance.upstreamRevision,
    upstreamTreeSha256: provenance.upstreamTreeSha256,
    buildRecipeSha256: provenance.toolchain.buildRecipeSha256,
  }
}

function stageTargets(
  stagingRoot: string,
  artifacts: readonly VerifiedArtifact[],
): Readonly<Record<NativeTarget, NativeManifestTarget>> {
  const targets = {} as Record<NativeTarget, NativeManifestTarget>
  for (const artifact of artifacts) {
    const target = artifact.provenance.target
    const destination = join(stagingRoot, target)
    extractVerifiedUstar(artifact.entries, destination)
    const inspected = inspectNativeBundle(destination, target)
    if (
      !canonicalObjectBytes(inspected.files).equals(canonicalObjectBytes(artifact.provenance.files))
    ) {
      throw new NativeContractError(`${target} extracted files differ from provenance`)
    }
    if (
      !canonicalObjectBytes(inspected.compatibility).equals(
        canonicalObjectBytes(artifact.provenance.compatibility),
      )
    ) {
      throw new NativeContractError(`${target} extracted compatibility differs from provenance`)
    }
    targets[target] = {
      executablePath: NATIVE_EXECUTABLE_PATH,
      resourcesRoot: NATIVE_RESOURCES_ROOT,
      totalBytes: inspected.totalBytes,
      files: inspected.files,
      compatibility: inspected.compatibility,
      assemblyProvenance: artifact.provenance,
      assemblyProvenanceSha256: canonicalSha256(artifact.provenance),
    }
  }
  return targets
}

function verifyStagedManifest(stagingRoot: string, manifest: NativeResolverManifest): void {
  for (const target of NATIVE_TARGETS) {
    const inspected = inspectNativeBundle(join(stagingRoot, target), target)
    const expected = manifest.targets[target]
    if (!canonicalObjectBytes(inspected.files).equals(canonicalObjectBytes(expected.files))) {
      throw new NativeContractError(`${target} staged bundle differs from manifest`)
    }
  }
}

function transitionFromBootstrap(activeRoot: string, stagingRoot: string): void {
  const backup = `${activeRoot}.bootstrap-backup-${process.pid}`
  if (pathExists(backup))
    throw new NativeContractError('native assembly backup path already exists')
  renameSync(activeRoot, backup)
  try {
    renameSync(stagingRoot, activeRoot)
  } catch (error) {
    renameSync(backup, activeRoot)
    throw error
  }
  unlinkSync(join(backup, basename(NATIVE_BOOTSTRAP_PATH)))
  rmdirSync(backup)
}

function removeOwnedStaging(path: string): void {
  if (!pathExists(path)) return
  rmSync(path, { recursive: true, force: false })
}

function assertRunIdentity(runId: string, runAttempt: number): void {
  if (!/^[1-9][0-9]{0,19}$/.test(runId)) throw new NativeContractError('assembly run ID is invalid')
  if (!Number.isInteger(runAttempt) || runAttempt < 1 || runAttempt > 100) {
    throw new NativeContractError('assembly run attempt is invalid')
  }
}

function assertRealDirectory(path: string, label: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new NativeContractError(`${label} is not a real directory`)
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
