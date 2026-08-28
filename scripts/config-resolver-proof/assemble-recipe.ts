import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
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

const MAX_INVENTORY_BYTES = 1024 * 1024
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/
const HEAD_PATTERN = /^[0-9a-f]{40}$/
const UPSTREAM_TREE_ENTRIES = 5_864

type JsonObject = Record<string, unknown>
type Arguments = {
  readonly inventories: Readonly<Record<ProofTarget, string>>
  readonly output: string
}
type InventoryProvenance = {
  readonly runId: string
  readonly runAttempt: number
  readonly ghosttyWebGpuHead: string
}
type AssembledTarget = {
  readonly recipe: ProofTargetRecipe
  readonly provenance: InventoryProvenance
}

class AssemblyFailure extends Error {}

function main(): void {
  const args = parseArguments(process.argv.slice(2))
  assertUniqueInventoryPaths(args.inventories)
  const assembled = PROOF_TARGETS.map((target) => readTarget(args.inventories[target], target))
  assertSharedProvenance(assembled)
  const targets = Object.fromEntries(
    PROOF_TARGETS.map((target, index) => [target, assembled[index]?.recipe]),
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
  writeRecipe(args.output, recipe)
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
  return resolve(value)
}

function newPath(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new AssemblyFailure('missing output path')
  return resolve(value)
}

function assertUniqueInventoryPaths(inventories: Readonly<Record<ProofTarget, string>>): void {
  if (new Set(Object.values(inventories)).size !== PROOF_TARGETS.length) {
    throw new AssemblyFailure('inventory paths must be unique')
  }
}

function readTarget(path: string, target: ProofTarget): AssembledTarget {
  const inventory = readInventory(path, target)
  const provenance = assertInventoryIdentity(inventory, target)
  const runner = asObject(inventory.runner, `${target} runner`)
  return {
    provenance,
    recipe: {
      runner: {
        os: runner.os as 'darwin' | 'linux',
        arch: runner.arch as 'arm64' | 'x64',
        image: stringValue(runner.image, `${target} image`),
        imageVersion: stringValue(runner.imageVersion, `${target} image version`),
      },
      targetTriple: stringValue(inventory.targetTriple, `${target} triple`),
      optimizationMode: inventory.optimizationMode as 'ReleaseSafe',
      buildArgv: stringArray(inventory.buildArgv, `${target} build argv`),
      linkArgv: stringArray(inventory.linkArgv, `${target} link argv`),
      stripArgv: stringArray(inventory.stripArgv, `${target} strip argv`),
      environment: inventory.environment as ProofTargetRecipe['environment'],
      tools: inventory.tools as ProofTargetRecipe['tools'],
      inputs: inventory.inputs as ProofTargetRecipe['inputs'],
    },
  }
}

function readInventory(path: string, target: ProofTarget): JsonObject {
  const bytes = readBoundedRegularFile(path, target)
  const text = decodeUtf8(bytes, target)
  try {
    return asObject(JSON.parse(text), `${target} inventory`)
  } catch (error) {
    if (error instanceof AssemblyFailure) throw error
    throw new AssemblyFailure(`${target} inventory is not JSON`)
  }
}

function readBoundedRegularFile(path: string, target: ProofTarget): Buffer {
  const before = inventoryStat(path, target)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new AssemblyFailure(`${target} inventory is not a regular file`)
  }
  assertInventorySize(before.size, target)
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new AssemblyFailure(`${target} inventory could not be opened`)
  }
  try {
    return readOpenedInventory(descriptor, before, target)
  } finally {
    closeSync(descriptor)
  }
}

function inventoryStat(path: string, target: ProofTarget): Stats {
  try {
    return lstatSync(path)
  } catch {
    throw new AssemblyFailure(`${target} inventory is unavailable`)
  }
}

function readOpenedInventory(descriptor: number, pathStat: Stats, target: ProofTarget): Buffer {
  const before = fstatSync(descriptor)
  if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
    throw new AssemblyFailure(`${target} inventory changed before reading`)
  }
  assertInventorySize(before.size, target)
  const bytes = readFileSync(descriptor)
  const after = fstatSync(descriptor)
  assertInventorySize(bytes.length, target)
  if (!sameFileState(before, after) || bytes.length !== before.size) {
    throw new AssemblyFailure(`${target} inventory changed while reading`)
  }
  return bytes
}

function sameFileState(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function assertInventorySize(size: number, target: ProofTarget): void {
  if (size < 1 || size > MAX_INVENTORY_BYTES) {
    throw new AssemblyFailure(`${target} inventory byte length is invalid`)
  }
}

function decodeUtf8(bytes: Buffer, target: ProofTarget): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new AssemblyFailure(`${target} inventory is not UTF-8`)
  }
}

function assertInventoryIdentity(inventory: JsonObject, target: ProofTarget): InventoryProvenance {
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
  if (inventory.upstreamTreeEntries !== UPSTREAM_TREE_ENTRIES) {
    throw new AssemblyFailure('inventory upstream tree entry count mismatch')
  }
  if (inventory.sourceDateEpoch !== PROOF_SOURCE_DATE_EPOCH) {
    throw new AssemblyFailure('inventory source epoch mismatch')
  }
  if (inventory.zigVersion !== PROOF_ZIG_VERSION) {
    throw new AssemblyFailure('inventory Zig version mismatch')
  }
  if (inventory.proofRecipeSha256 !== null) {
    throw new AssemblyFailure('inventory recipe digest must be null')
  }
  if (inventory.officialReadOnlyGraph !== 'pass') {
    throw new AssemblyFailure('inventory read-only graph check mismatch')
  }
  return {
    runId: runIdValue(inventory.runId, `${target} run ID`),
    runAttempt: integerValue(inventory.runAttempt, 1, 100, `${target} run attempt`),
    ghosttyWebGpuHead: headValue(inventory.ghosttyWebGpuHead, `${target} source head`),
  }
}

function assertSharedProvenance(targets: readonly AssembledTarget[]): void {
  const first = targets[0]?.provenance
  if (!first) throw new AssemblyFailure('inventory matrix is empty')
  for (const target of targets.slice(1)) {
    if (target.provenance.runId !== first.runId) {
      throw new AssemblyFailure('inventory run IDs do not match')
    }
    if (target.provenance.runAttempt !== first.runAttempt) {
      throw new AssemblyFailure('inventory run attempts do not match')
    }
    if (target.provenance.ghosttyWebGpuHead !== first.ghosttyWebGpuHead) {
      throw new AssemblyFailure('inventory source heads do not match')
    }
  }
}

function runIdValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new AssemblyFailure(`${label} is invalid`)
  }
  return value
}

function headValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HEAD_PATTERN.test(value)) {
    throw new AssemblyFailure(`${label} is invalid`)
  }
  return value
}

function integerValue(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AssemblyFailure(`${label} is outside its bound`)
  }
  return value as number
}

function writeRecipe(path: string, recipe: ProofRecipe): void {
  let bytes: Buffer
  try {
    bytes = proofCanonicalBytes(recipe)
  } catch {
    throw new AssemblyFailure('assembled recipe does not satisfy the proof contract')
  }
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 })
  } catch {
    throw new AssemblyFailure('recipe output could not be created')
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
