import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PROOF_SOURCE_DATE_EPOCH,
  PROOF_TARGETS,
  PROOF_UPSTREAM_REPOSITORY,
  PROOF_UPSTREAM_REVISION,
  PROOF_UPSTREAM_TREE_SHA256,
  PROOF_ZIG_VERSION,
  proofCanonicalBytes,
  type ProofRecipe,
  type ProofTarget,
  type ProofTargetRecipe,
} from './proof-contract'

type JsonObject = Record<string, unknown>
type Arguments = {
  readonly inventories: Readonly<Record<ProofTarget, string>>
  readonly output: string
}

class AssemblyFailure extends Error {}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  const targets = Object.fromEntries(
    PROOF_TARGETS.map((target) => [target, readTarget(args.inventories[target], target)]),
  ) as Readonly<Record<ProofTarget, ProofTargetRecipe>>
  const recipe: ProofRecipe = {
    schemaVersion: 1,
    sourceDateEpoch: PROOF_SOURCE_DATE_EPOCH,
    upstream: {
      repository: PROOF_UPSTREAM_REPOSITORY,
      revision: PROOF_UPSTREAM_REVISION,
      treeSha256: PROOF_UPSTREAM_TREE_SHA256,
    },
    zigVersion: PROOF_ZIG_VERSION,
    targets,
  }
  writeFileSync(args.output, proofCanonicalBytes(recipe), { flag: 'wx' })
}

function parseArguments(argv: readonly string[]): Arguments {
  const names = new Set(PROOF_TARGETS.map((target) => `--${target}`))
  names.add('--output')
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !names.has(name)) throw new AssemblyFailure('invalid argument')
    if (values.has(name)) throw new AssemblyFailure('duplicate argument')
    values.set(name, value)
  }
  if (values.size !== names.size) throw new AssemblyFailure('missing argument')
  return {
    inventories: Object.fromEntries(
      PROOF_TARGETS.map((target) => [target, existingPath(values, `--${target}`)]),
    ) as Readonly<Record<ProofTarget, string>>,
    output: newPath(values, '--output'),
  }
}

function existingPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new AssemblyFailure('missing inventory path')
  return realpathSync(value)
}

function newPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new AssemblyFailure('missing output path')
  return resolve(value)
}

function readTarget(path: string, target: ProofTarget): ProofTargetRecipe {
  const inventory = asObject(JSON.parse(readFileSync(path, 'utf8')), target)
  assertInventoryIdentity(inventory, target)
  const runner = asObject(inventory.runner, `${target} runner`)
  return {
    runner: {
      os: runner.os as 'darwin' | 'linux',
      arch: runner.arch as 'arm64' | 'x64',
      image: stringValue(runner.image, `${target} image`),
      imageVersion: stringValue(runner.imageVersion, `${target} image version`),
    },
    targetTriple: stringValue(inventory.targetTriple, `${target} triple`),
    optimizationMode: 'ReleaseSafe',
    buildArgv: stringArray(inventory.buildArgv, `${target} build argv`),
    linkArgv: stringArray(inventory.linkArgv, `${target} link argv`),
    stripArgv: stringArray(inventory.stripArgv, `${target} strip argv`),
    environment: inventory.environment as ProofTargetRecipe['environment'],
    tools: inventory.tools as ProofTargetRecipe['tools'],
    inputs: inventory.inputs as ProofTargetRecipe['inputs'],
  }
}

function assertInventoryIdentity(inventory: JsonObject, target: ProofTarget): void {
  if (inventory.schemaVersion !== 1 || inventory.kind !== 'config-resolver-inventory') {
    throw new AssemblyFailure('inventory kind mismatch')
  }
  if (inventory.target !== target) throw new AssemblyFailure('inventory target mismatch')
  if (inventory.upstreamRevision !== PROOF_UPSTREAM_REVISION) {
    throw new AssemblyFailure('inventory upstream revision mismatch')
  }
  if (inventory.upstreamTreeSha256 !== PROOF_UPSTREAM_TREE_SHA256) {
    throw new AssemblyFailure('inventory upstream tree mismatch')
  }
  if (inventory.sourceDateEpoch !== PROOF_SOURCE_DATE_EPOCH) {
    throw new AssemblyFailure('inventory source epoch mismatch')
  }
  if (inventory.zigVersion !== PROOF_ZIG_VERSION) {
    throw new AssemblyFailure('inventory Zig version mismatch')
  }
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AssemblyFailure(`${label} must be an object`)
  }
  return value as JsonObject
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1) {
    throw new AssemblyFailure(`${label} must be a string`)
  }
  return value
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AssemblyFailure(`${label} must be a string array`)
  }
  return value as readonly string[]
}

try {
  main()
} catch (error) {
  const reason = error instanceof AssemblyFailure ? error.message : 'unexpected assembly failure'
  process.stdout.write(`${JSON.stringify({ recipe: 'invalid', reason })}\n`)
  process.exitCode = 1
}
