import { lstatSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canonicalObjectBytes, canonicalSha256, NativeContractError } from './canonical'
import {
  NATIVE_BOOTSTRAP_PATH,
  NATIVE_BUILD_RECIPE_PATH,
  NATIVE_MANIFEST_PATH,
  NATIVE_TARGETS,
  type NativeTarget,
} from './constants'
import { loadBuildRecipe, loadNativeBootstrap, loadNativeManifest } from './contract'
import { inspectNativeBundle } from './artifacts'
import { nativeProvenanceToolchain } from './builder'
import { verifyNativeInputs } from './inputs'

export type NativeRepositoryState = 'assembled' | 'bootstrap'

export function verifyNativeRepositoryState(
  repositoryRoot: string,
  required: NativeRepositoryState | 'either' = 'either',
): NativeRepositoryState {
  const root = join(repositoryRoot, dirname(NATIVE_BOOTSTRAP_PATH))
  assertDirectory(root, 'native resolver root')
  const entries = readdirSync(root, { encoding: 'utf8' }).sort()
  const state = classifyEntries(entries)
  if (required !== 'either' && state !== required) {
    throw new NativeContractError(`native resolver state is ${state}, not ${required}`)
  }
  if (state === 'bootstrap') verifyBootstrapState(repositoryRoot)
  if (state === 'assembled') verifyAssembledState(repositoryRoot)
  return state
}

function classifyEntries(entries: readonly string[]): NativeRepositoryState {
  if (JSON.stringify(entries) === JSON.stringify(['bootstrap.json'])) return 'bootstrap'
  const assembled = ['manifest.json', ...NATIVE_TARGETS].sort()
  if (JSON.stringify(entries) === JSON.stringify(assembled)) return 'assembled'
  throw new NativeContractError('native resolver state is mixed, empty, or has unexpected entries')
}

function verifyBootstrapState(repositoryRoot: string): void {
  const bootstrap = loadNativeBootstrap(join(repositoryRoot, NATIVE_BOOTSTRAP_PATH)).value
  const inputs = verifyNativeInputs(repositoryRoot)
  if (bootstrap.nativeInputsTreeSha256 !== inputs.sha256) {
    throw new NativeContractError('bootstrap native-input digest does not match')
  }
}

function verifyAssembledState(repositoryRoot: string): void {
  const manifest = loadNativeManifest(join(repositoryRoot, NATIVE_MANIFEST_PATH)).value
  const inputs = verifyNativeInputs(repositoryRoot, {
    gitHead: manifest.nativeBuildSourceHead,
    requireCurrentCleanHead: false,
  })
  if (manifest.nativeInputsTreeSha256 !== inputs.sha256) {
    throw new NativeContractError('manifest native-input digest does not match')
  }
  const recipe = loadBuildRecipe(join(repositoryRoot, NATIVE_BUILD_RECIPE_PATH))
  const first = manifest.targets[NATIVE_TARGETS[0]].assemblyProvenance
  for (const target of NATIVE_TARGETS) {
    verifyManifestTarget(repositoryRoot, manifest.targets[target], target, recipe)
    const provenance = manifest.targets[target].assemblyProvenance
    assertSameRun(first, provenance)
  }
}

function verifyManifestTarget(
  repositoryRoot: string,
  targetManifest: ReturnType<typeof loadNativeManifest>['value']['targets'][NativeTarget],
  target: NativeTarget,
  recipe: ReturnType<typeof loadBuildRecipe>,
): void {
  const provenance = targetManifest.assemblyProvenance
  if (targetManifest.assemblyProvenanceSha256 !== canonicalSha256(provenance)) {
    throw new NativeContractError(`${target} assembly provenance digest does not match`)
  }
  if (provenance.toolchain.buildRecipeSha256 !== recipe.sha256) {
    throw new NativeContractError(`${target} provenance build recipe digest does not match`)
  }
  const targetRecipe = recipe.value.targets[target]
  const toolchain = nativeProvenanceToolchain(targetRecipe, recipe.sha256)
  if (!canonicalObjectBytes(provenance.toolchain).equals(canonicalObjectBytes(toolchain))) {
    throw new NativeContractError(`${target} provenance toolchain does not match the recipe`)
  }
  if (!canonicalObjectBytes(provenance.runner).equals(canonicalObjectBytes(targetRecipe.runner))) {
    throw new NativeContractError(`${target} provenance runner does not match the recipe`)
  }
  const bundle = inspectNativeBundle(join(repositoryRoot, 'native/config-resolver', target), target)
  if (!canonicalObjectBytes(bundle.files).equals(canonicalObjectBytes(targetManifest.files))) {
    throw new NativeContractError(`${target} packaged files do not match manifest`)
  }
  if (
    !canonicalObjectBytes(bundle.compatibility).equals(
      canonicalObjectBytes(targetManifest.compatibility),
    )
  ) {
    throw new NativeContractError(`${target} packaged compatibility does not match manifest`)
  }
  if (bundle.totalBytes !== targetManifest.totalBytes) {
    throw new NativeContractError(`${target} packaged byte total does not match manifest`)
  }
}

function assertSameRun(
  left: ReturnType<
    typeof loadNativeManifest
  >['value']['targets'][NativeTarget]['assemblyProvenance'],
  right: ReturnType<
    typeof loadNativeManifest
  >['value']['targets'][NativeTarget]['assemblyProvenance'],
): void {
  const leftIdentity = {
    runId: left.runId,
    runAttempt: left.runAttempt,
    nativeBuildSourceHead: left.nativeBuildSourceHead,
    nativeInputsTreeSha256: left.nativeInputsTreeSha256,
    sourceDateEpoch: left.sourceDateEpoch,
    upstreamRevision: left.upstreamRevision,
    upstreamTreeSha256: left.upstreamTreeSha256,
    buildRecipeSha256: left.toolchain.buildRecipeSha256,
  }
  const rightIdentity = {
    runId: right.runId,
    runAttempt: right.runAttempt,
    nativeBuildSourceHead: right.nativeBuildSourceHead,
    nativeInputsTreeSha256: right.nativeInputsTreeSha256,
    sourceDateEpoch: right.sourceDateEpoch,
    upstreamRevision: right.upstreamRevision,
    upstreamTreeSha256: right.upstreamTreeSha256,
    buildRecipeSha256: right.toolchain.buildRecipeSha256,
  }
  if (!canonicalObjectBytes(leftIdentity).equals(canonicalObjectBytes(rightIdentity))) {
    throw new NativeContractError('assembled native provenance mixes build runs or identities')
  }
}

function assertDirectory(path: string, label: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new NativeContractError(`${label} is not a real directory`)
  }
}
