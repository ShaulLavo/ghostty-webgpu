import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProofRecipe, type ProofTargetRecipe } from '../config-resolver-proof/proof-contract'
import { canonicalObjectBytes } from './canonical'
import {
  NATIVE_BUILD_RECIPE_PATH,
  NATIVE_BUILD_ROOT,
  NATIVE_PROOF_RECIPE_SHA256,
  NATIVE_TARGETS,
  type NativeTarget,
} from './constants'
import { validateNativeBuildRecipe, type NativeTargetRecipe } from './contract'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const proofRecipePath = join(repositoryRoot, 'scripts/config-resolver-proof/proof-recipe.json')
const outputPath = join(repositoryRoot, NATIVE_BUILD_RECIPE_PATH)

class RecipeGenerationFailure extends Error {}

function main(): void {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || (mode !== '--check' && mode !== '--write')) {
    throw new RecipeGenerationFailure('usage: generate-build-recipe.ts --check|--write')
  }
  const proof = loadProofRecipe(proofRecipePath)
  if (proof.sha256 !== NATIVE_PROOF_RECIPE_SHA256) {
    throw new RecipeGenerationFailure('accepted proof recipe digest changed')
  }
  const recipe = validateNativeBuildRecipe({
    schemaVersion: 2,
    proofRecipeSha256: proof.sha256,
    sourceDateEpoch: proof.value.sourceDateEpoch,
    upstream: proof.value.upstream,
    zigVersion: proof.value.zigVersion,
    targets: Object.fromEntries(
      NATIVE_TARGETS.map((target) => [target, projectTarget(target, proof.value.targets[target])]),
    ),
  })
  const bytes = canonicalObjectBytes(recipe)
  if (mode === '--write') {
    writeFileSync(outputPath, bytes, { flag: 'w', mode: 0o644 })
    process.stdout.write(`${NATIVE_BUILD_RECIPE_PATH}\n`)
    return
  }
  if (!existsSync(outputPath) || !readFileSync(outputPath).equals(bytes)) {
    throw new RecipeGenerationFailure('maintained build recipe is stale')
  }
}

function projectTarget(target: NativeTarget, proof: ProofTargetRecipe): NativeTargetRecipe {
  const root = NATIVE_BUILD_ROOT[target.startsWith('darwin-') ? 'darwin' : 'linux']
  const proofRoot = target.startsWith('darwin-')
    ? '/private/tmp/ghostty-config-resolver-proof-build-v1'
    : '/tmp/ghostty-config-resolver-proof-build-v1'
  const sdkRoot = sdkRootFor(proof)
  const transform = (value: string): string => projectString(value, proofRoot, root, sdkRoot)
  const tools = projectRecords(proof.tools, transform)
  const inputs = projectRecords(proof.inputs, transform)
  const stripArgv = target.startsWith('darwin-')
    ? ['/usr/bin/strip', '-x', '-no_uuid', '$OUTPUT/bin/ghostty-config-resolver']
    : ['/usr/bin/strip', '--strip-all', '$OUTPUT/bin/ghostty-config-resolver']
  return {
    runner: proof.runner,
    targetTriple: proof.targetTriple,
    optimizationMode: proof.optimizationMode,
    buildArgv: proof.buildArgv.map(transform),
    linkPlan: proof.linkPlan.map(transform),
    stripArgv,
    environment: proof.environment.map((entry) => ({
      name: entry.name,
      value: transform(entry.value),
    })),
    tools: tools as NativeTargetRecipe['tools'],
    inputs: inputs as NativeTargetRecipe['inputs'],
  }
}

function projectRecords(
  records: readonly unknown[],
  transform: (value: string) => string,
): readonly unknown[] {
  return records.map((record) => projectRecord(record, transform))
}

function projectRecord(record: unknown, transform: (value: string) => string): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new RecipeGenerationFailure('proof recipe record is malformed')
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => {
      if (key === 'acquisition') return [key, normalizeAcquisition(item)]
      return [key, projectValue(item, transform)]
    }),
  )
}

function normalizeAcquisition(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Readonly<Record<string, unknown>>
  if (!record.macosSdk || typeof record.macosSdk !== 'object' || Array.isArray(record.macosSdk)) {
    return value
  }
  const sdk = record.macosSdk as Readonly<Record<string, unknown>>
  return {
    ...record,
    macosSdk: {
      ...sdk,
      xcodeVersion: stripPrefix(sdk.xcodeVersion, 'Xcode '),
      xcodeBuild: stripPrefix(sdk.xcodeBuild, 'Build version '),
    },
  }
}

function stripPrefix(value: unknown, prefix: string): unknown {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return value
  return value.slice(prefix.length)
}

function projectValue(value: unknown, transform: (value: string) => string): unknown {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map((item) => projectValue(item, transform))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, projectValue(item, transform)]),
  )
}

function projectString(
  value: string,
  proofRoot: string,
  nativeRoot: string,
  sdkRoot: string | null,
): string {
  let result = value.replaceAll(proofRoot, '$WORK')
  if (sdkRoot) result = result.replaceAll(sdkRoot, '$SDK')
  result = result.replaceAll('ghostty-config-resolver-proof', 'ghostty-config-resolver')
  result = result.replaceAll('proof-preverified-generated', 'native-preverified-generated')
  result = result.replaceAll('proof-generated', 'native-generated')
  result = result.replaceAll('proof-materialize-generated', 'native-materialize-generated')
  if (result.includes(nativeRoot)) {
    throw new RecipeGenerationFailure('native absolute root escaped recipe tokenization')
  }
  return result
}

function sdkRootFor(target: ProofTargetRecipe): string | null {
  const record = target.tools.find((tool) => tool.role === 'sdk-or-sysroot')
  if (!record || record.acquisition.kind !== 'runner-component') return null
  if (!record.acquisition.macosSdk) return null
  return record.acquisition.path
}

main()
