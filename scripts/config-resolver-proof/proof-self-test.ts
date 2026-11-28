import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  PROOF_SOURCE_DATE_EPOCH,
  PROOF_TARGETS,
  ProofContractError,
  loadProofRecipe,
  projectObservedLinkArgv,
  proofCanonicalBytes,
  type ProofTarget,
} from './proof-contract'
import {
  compareStrings,
  DRIFTED_LINK_CACHE_KEYS,
  fixtureHash,
  LINK_CACHE_KEYS,
  LINK_FILLER_PREFIX,
  observedLinkArgv,
  officialDownload,
  proofGenerationArgv,
  proofGenerationSources,
  runnerComponent,
  upstreamAcquisition,
  zigAcquisition,
  recipeFixture,
  TARGET_FIXTURES,
  type JsonObject,
  type JsonValue,
} from './proof-recipe-fixture'
import {
  assertProofRejection,
  createFixtureDirectory,
  fail,
  sha256,
  stableJson,
} from './proof-self-test-support'
import { testExternalTree, testGitTree } from './proof-tree-fixture'

type JsonPath = readonly (number | string)[]
type MutationOutcome = 'change' | 'reject'
type MutationCase = {
  readonly apply: (recipe: JsonObject) => void
  readonly covers: readonly string[]
  readonly label: string
  readonly outcome: MutationOutcome
}
type ProjectionMutationCase = {
  readonly apply: (argv: string[], target: ProofTarget) => void
  readonly label: string
  readonly outcome: 'equal' | 'reject'
  readonly requiresContractRejection?: boolean
}
type ProjectionTestResult = {
  readonly equal: number
  readonly rejected: number
  readonly transcript: readonly string[]
}
type SelfTestResult = {
  readonly externalTree: ReturnType<typeof testExternalTree>
  readonly gitTree: ReturnType<typeof testGitTree>
  readonly recipe: {
    readonly canonicalBytes: number
    readonly canonicalSha256: string
    readonly changed: number
    readonly mutationSha256: string
    readonly mutations: number
    readonly projectedEqual: number
    readonly projectedRejected: number
    readonly rejected: number
  }
}
type CheckedRecipeIdentity = {
  readonly bytes: number
  readonly sha256: string
}

const LINUX_TARGET: JsonPath = ['targets', 'linux-x64']
const DARWIN_TARGET: JsonPath = ['targets', 'darwin-arm64']
const RECIPE_SCHEMA_FIELDS = [
  'recipe.schemaVersion',
  'recipe.sourceDateEpoch',
  'recipe.targets',
  'recipe.upstream',
  'recipe.zigVersion',
  'targets.darwin-arm64',
  'targets.darwin-x64',
  'targets.linux-arm64',
  'targets.linux-x64',
  'upstream.repository',
  'upstream.revision',
  'upstream.treeSha256',
  'target.buildArgv',
  'target.environment',
  'target.inputs',
  'target.linkPlan',
  'target.optimizationMode',
  'target.runner',
  'target.stripArgv',
  'target.targetTriple',
  'target.tools',
  'runner.arch',
  'runner.image',
  'runner.imageVersion',
  'runner.os',
  'environment.name',
  'environment.value',
  'tool.acquisition',
  'tool.bytes',
  'tool.generation',
  'tool.name',
  'tool.role',
  'tool.sha256',
  'tool.version',
  'input.acquisition',
  'input.bytes',
  'input.generation',
  'input.id',
  'input.role',
  'input.sha256',
  'generation.argv',
  'generation.sources',
  'official-download.archiveBytes',
  'official-download.archiveSha256',
  'official-download.kind',
  'official-download.url',
  'git.kind',
  'git.repository',
  'git.revision',
  'git.treeAlgorithm',
  'git.treeSha256',
  'runner-component.contentKind',
  'runner-component.kind',
  'runner-component.macosSdk',
  'runner-component.path',
  'runner-component.runnerImage',
  'runner-component.runnerImageVersion',
  'macosSdk.sdkBuild',
  'macosSdk.sdkSettingsSha256',
  'macosSdk.sdkVersion',
  'macosSdk.xcodeBuild',
  'macosSdk.xcodeVersion',
] as const

// These values intentionally freeze the format, not ambient tool or filesystem metadata.
const GOLDEN_RESULT: SelfTestResult = {
  externalTree: {
    baseline: {
      bytes: 27,
      entries: 7,
      sha256: 'a768d6377f40287740b4964d74d8b2876607db8d5193c0d47b695d28365f3872',
    },
    mutationSha256: '1b952e62c88711b372a0e7914bab82f9930b9656af2c0fb053cd33a5f405831f',
    mutations: 4,
  },
  gitTree: {
    baseline: {
      bytes: 55,
      entries: 4,
      gitlinks: 1,
      sha256: '4465646445232cd47796f779883436f88bfc25e78806ab1a5a5f573332791de1',
    },
    mutationSha256: 'f55ecbe524f45c9e24f2ccb11d9346c13f183b104e681040f8c0cd7e0e802de7',
    mutations: 5,
  },
  recipe: {
    canonicalBytes: 81_038,
    canonicalSha256: 'b33f427519c7902c23adc3ef680b6dcd047b06804806df1753cb5957691fa3f3',
    changed: 12,
    mutationSha256: '85cb96fc7ec9b39b72139de3b3a655fbe52e87c787ad9c9be5805220af163c6f',
    mutations: 255,
    projectedEqual: 4,
    projectedRejected: 76,
    rejected: 163,
  },
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function valueAt(root: JsonValue, path: JsonPath): JsonValue {
  let value = root
  for (const component of path) {
    if (typeof component === 'number') {
      if (!Array.isArray(value) || value[component] === undefined)
        fail('invalid fixture array path')
      value = value[component]
      continue
    }
    if (!isJsonObject(value) || value[component] === undefined) fail('invalid fixture object path')
    value = value[component]
  }
  return value
}

function parentAt(
  root: JsonValue,
  path: JsonPath,
): { readonly key: number | string; readonly value: JsonValue } {
  if (path.length === 0) fail('fixture path has no parent')
  const key = path[path.length - 1]
  if (key === undefined) fail('fixture path has no key')
  return { key, value: valueAt(root, path.slice(0, -1)) }
}

function setValue(root: JsonValue, path: JsonPath, value: JsonValue): void {
  const parent = parentAt(root, path)
  if (typeof parent.key === 'number') {
    if (!Array.isArray(parent.value)) fail('fixture mutation expected an array')
    parent.value[parent.key] = value
    return
  }
  if (!isJsonObject(parent.value)) fail('fixture mutation expected an object')
  parent.value[parent.key] = value
}

function deleteValue(root: JsonValue, path: JsonPath): void {
  const parent = parentAt(root, path)
  if (typeof parent.key === 'number') {
    if (!Array.isArray(parent.value)) fail('fixture deletion expected an array')
    parent.value.splice(parent.key, 1)
    return
  }
  if (!isJsonObject(parent.value)) fail('fixture deletion expected an object')
  delete parent.value[parent.key]
}

function swapArray(root: JsonValue, path: JsonPath, left: number, right: number): void {
  const value = valueAt(root, path)
  if (!Array.isArray(value)) fail('fixture swap expected an array')
  const leftValue = value[left]
  const rightValue = value[right]
  if (leftValue === undefined || rightValue === undefined) fail('fixture swap index is invalid')
  value[left] = rightValue
  value[right] = leftValue
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function objectAt(root: JsonValue, path: JsonPath): JsonObject {
  const value = valueAt(root, path)
  if (!isJsonObject(value)) fail('fixture path did not resolve to an object')
  return value
}

function arrayAt(root: JsonValue, path: JsonPath): JsonValue[] {
  const value = valueAt(root, path)
  if (!Array.isArray(value)) fail('fixture path did not resolve to an array')
  return value
}

function targetAt(recipe: JsonObject, target: ProofTarget): JsonObject {
  return objectAt(recipe, ['targets', target])
}

function recordBy(
  recipe: JsonObject,
  target: ProofTarget,
  collection: 'inputs' | 'tools',
  key: 'id' | 'role',
  expected: string,
): JsonObject {
  const records = arrayAt(recipe, ['targets', target, collection])
  const matches = records.filter((record) => isJsonObject(record) && record[key] === expected)
  if (matches.length !== 1 || !isJsonObject(matches[0])) fail('fixture record lookup is ambiguous')
  return matches[0]
}

function toolByRole(recipe: JsonObject, target: ProofTarget, role: string): JsonObject {
  return recordBy(recipe, target, 'tools', 'role', role)
}

function inputById(recipe: JsonObject, target: ProofTarget, id: string): JsonObject {
  return recordBy(recipe, target, 'inputs', 'id', id)
}

function acquisitionOf(record: JsonObject): JsonObject {
  const acquisition = record.acquisition
  if (!isJsonObject(acquisition)) fail('fixture acquisition is not an object')
  return acquisition
}

function generationOf(record: JsonObject): JsonObject {
  const generation = record.generation
  if (!isJsonObject(generation)) fail('fixture generation is not an object')
  return generation
}

function mutateLinkArgument(
  recipe: JsonObject,
  target: ProofTarget,
  expected: string,
  replacement: string,
): void {
  const argv = arrayAt(recipe, ['targets', target, 'linkPlan'])
  const index = argv.indexOf(expected)
  if (index < 0) fail('fixture link argument was not found')
  argv[index] = replacement
}

function insertBeforeListen(recipe: JsonObject, target: ProofTarget, argument: string): void {
  const argv = arrayAt(recipe, ['targets', target, 'linkPlan'])
  const listen = argv.lastIndexOf('--listen=-')
  if (listen < 0) fail('fixture link listen argument was not found')
  argv.splice(listen, 0, argument)
}

function replaceLinkFiller(recipe: JsonObject, target: ProofTarget, replacement: string): void {
  const argv = arrayAt(recipe, ['targets', target, 'linkPlan'])
  const index = argv.findIndex(
    (argument) => typeof argument === 'string' && argument.startsWith(LINK_FILLER_PREFIX),
  )
  if (index < 0) fail('fixture link filler was not found')
  argv[index] = replacement
}

function mutateArrayValue(values: JsonValue[], expected: string, replacement: string): void {
  const index = values.indexOf(expected)
  if (index < 0) fail('fixture array value was not found')
  values[index] = replacement
}

function sortRecords(records: JsonValue[]): void {
  records.sort((left, right) => {
    if (!isJsonObject(left) || !isJsonObject(right)) fail('fixture record is not an object')
    const leftIdentity = left.id ?? left.name
    const rightIdentity = right.id ?? right.name
    const leftKey = `${String(left.role)}\0${String(leftIdentity)}`
    const rightKey = `${String(right.role)}\0${String(rightIdentity)}`
    return compareStrings(leftKey, rightKey)
  })
}

function mutateOptionValue(
  recipe: JsonObject,
  target: ProofTarget,
  option: string,
  replacement: string,
): void {
  const argv = arrayAt(recipe, ['targets', target, 'linkPlan'])
  const optionIndex = argv.indexOf(option)
  if (optionIndex < 0 || optionIndex + 1 >= argv.length) fail('fixture link option was not found')
  argv[optionIndex + 1] = replacement
}

function linkArgumentIndex(argv: readonly string[], marker: string): number {
  const index = argv.findIndex((argument) => argument.includes(marker))
  if (index < 0) fail(`fixture link argument was not found: ${marker}`)
  return index
}

function replaceLinkText(argv: string[], expected: string, replacement: string): void {
  let replacements = 0
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument?.includes(expected)) continue
    argv[index] = argument.replaceAll(expected, replacement)
    replacements += 1
  }
  if (replacements === 0) fail(`fixture link text was not found: ${expected}`)
}

function mutateMarkedLinkArgument(
  argv: string[],
  marker: string,
  mutate: (argument: string) => string,
): void {
  const index = linkArgumentIndex(argv, marker)
  const argument = argv[index]
  if (argument === undefined) fail('fixture marked link argument is missing')
  argv[index] = mutate(argument)
}

function planStrings(recipe: JsonObject, target: ProofTarget): string[] {
  const values = arrayAt(recipe, ['targets', target, 'linkPlan'])
  if (!values.every((value) => typeof value === 'string')) {
    fail('fixture link plan contains a non-string argument')
  }
  return values as string[]
}

function replacePlanText(
  recipe: JsonObject,
  target: ProofTarget,
  expected: string,
  replacement: string,
): void {
  replaceLinkText(planStrings(recipe, target), expected, replacement)
}

function projectionMutationCases(): readonly ProjectionMutationCase[] {
  return [
    {
      apply: (argv) => {
        replaceLinkText(argv, LINK_CACHE_KEYS.primary, DRIFTED_LINK_CACHE_KEYS.primary)
        replaceLinkText(argv, LINK_CACHE_KEYS.secondary, DRIFTED_LINK_CACHE_KEYS.secondary)
        replaceLinkText(argv, LINK_CACHE_KEYS.tertiary, DRIFTED_LINK_CACHE_KEYS.tertiary)
      },
      label: 'raw-cache-key-drift',
      outcome: 'equal',
    },
    {
      apply: (argv) => replaceLinkText(argv, LINK_CACHE_KEYS.primary, '0'.repeat(31)),
      label: 'raw-cache-key-malformed',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) =>
        replaceLinkText(argv, LINK_CACHE_KEYS.primary, LINK_CACHE_KEYS.primary.toUpperCase()),
      label: 'raw-cache-key-uppercase',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => replaceLinkText(argv, LINK_CACHE_KEYS.primary, '{{zig-cache-key-0000}}'),
      label: 'raw-cache-placeholder',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary_alias=', (argument) =>
          argument.replace(LINK_CACHE_KEYS.primary, 'cccccccccccccccccccccccccccccccc'),
        )
      },
      label: 'raw-cache-alias-split',
      outcome: 'reject',
    },
    {
      apply: (argv) => replaceLinkText(argv, LINK_CACHE_KEYS.secondary, LINK_CACHE_KEYS.primary),
      label: 'raw-cache-alias-collapsed',
      outcome: 'reject',
    },
    {
      apply: (argv, target) => {
        const root = TARGET_FIXTURES[target].root
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace(root, '/var/tmp/ghostty-config-resolver-proof-build-v1'),
        )
      },
      label: 'raw-cache-wrong-root',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv, target) => {
        const root = TARGET_FIXTURES[target].root
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument
            .replace(root, '/evil')
            .replace(LINK_CACHE_KEYS.primary, LINK_CACHE_KEYS.primary.toUpperCase()),
        )
      },
      label: 'raw-cache-wrong-root-uppercase',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv, target) => {
        const root = TARGET_FIXTURES[target].root
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace(root, '/evil').replace(LINK_CACHE_KEYS.primary, '0'.repeat(31)),
        )
      },
      label: 'raw-cache-wrong-root-malformed',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv, target) => {
        const root = TARGET_FIXTURES[target].root
        const opposite = target.startsWith('darwin-')
          ? TARGET_FIXTURES['linux-x64'].root
          : TARGET_FIXTURES['darwin-x64'].root
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace(root, opposite),
        )
      },
      label: 'raw-cache-opposite-root',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace('/primary.zig', '/../../evil/primary.zig'),
        )
      },
      label: 'raw-cache-parent-traversal',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace('/primary.zig', '/./primary.zig'),
        )
      },
      label: 'raw-cache-current-directory',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace('/primary.zig', '//primary.zig'),
        )
      },
      label: 'raw-cache-empty-component',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace('/primary.zig', '/changed.zig'),
        )
      },
      label: 'raw-cache-suffix',
      outcome: 'reject',
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '-Mcache_primary=', (argument) =>
          argument.replace('-Mcache_primary=', '-Mcache_changed='),
        )
      },
      label: 'raw-cache-module',
      outcome: 'reject',
    },
    {
      apply: (argv) => {
        mutateMarkedLinkArgument(argv, '--proof-secondary=', (argument) =>
          argument.replace('--proof-secondary=', '--proof-changed='),
        )
      },
      label: 'raw-cache-flag',
      outcome: 'reject',
    },
    {
      apply: (argv) => {
        const primary = linkArgumentIndex(argv, '-Mcache_primary=')
        const secondary = linkArgumentIndex(argv, '--proof-secondary=')
        ;[argv[primary], argv[secondary]] = [argv[secondary] ?? '', argv[primary] ?? '']
      },
      label: 'raw-cache-order',
      outcome: 'reject',
    },
    {
      apply: (argv) => argv.splice(linkArgumentIndex(argv, '-Mcache_primary_alias='), 1),
      label: 'raw-cache-count',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv) => {
        const index = argv.findIndex((argument) => argument.startsWith(LINK_FILLER_PREFIX))
        if (index < 0) fail('fixture link filler was not found')
        argv[index] = `${LINK_FILLER_PREFIX}{{zig-cache-key-0000}}`
      },
      label: 'raw-cache-placeholder-elsewhere',
      outcome: 'reject',
      requiresContractRejection: true,
    },
    {
      apply: (argv, target) => {
        const root = TARGET_FIXTURES[target].root
        mutateMarkedLinkArgument(
          argv,
          '-Mcache_primary=',
          (argument) => `${argument}=${root}/final-cache/o/${LINK_CACHE_KEYS.secondary}/second.zig`,
        )
      },
      label: 'raw-cache-multiple-per-argument',
      outcome: 'reject',
      requiresContractRejection: true,
    },
  ]
}

function runProjectionMutationCase(
  target: (typeof PROOF_TARGETS)[number],
  expectedJson: string,
  entry: ReturnType<typeof projectionMutationCases>[number],
): 'equal' | 'reject' {
  const candidate = observedLinkArgv(target)
  entry.apply(candidate, target)
  let projected: readonly string[] | null = null
  let rejected = false
  try {
    projected = projectObservedLinkArgv(candidate, target)
  } catch (error) {
    if (!(error instanceof ProofContractError)) throw error
    rejected = true
  }
  if (entry.requiresContractRejection && !rejected) {
    fail(`${target} ${entry.label} did not reject at the contract boundary`)
  }
  const equal = !rejected && stableJson(projected) === expectedJson
  if (entry.outcome === 'equal') {
    if (!equal) fail(`${target} ${entry.label} changed or rejected the plan`)
    return 'equal'
  }
  if (equal) fail(`${target} ${entry.label} did not reject the observed plan`)
  return 'reject'
}

function testProjectionMutations(): ProjectionTestResult {
  const transcript: string[] = []
  let equalCount = 0
  let rejectedCount = 0
  for (const target of PROOF_TARGETS) {
    const expectedJson = stableJson(projectObservedLinkArgv(observedLinkArgv(target), target))
    for (const entry of projectionMutationCases()) {
      const outcome = runProjectionMutationCase(target, expectedJson, entry)
      transcript.push(`${target}:${entry.label}:${outcome}`)
      if (outcome === 'equal') equalCount += 1
      else rejectedCount += 1
    }
  }
  return { equal: equalCount, rejected: rejectedCount, transcript }
}

function setMutation(
  label: string,
  covers: string,
  path: JsonPath,
  value: JsonValue,
  outcome: MutationOutcome,
): MutationCase {
  return {
    apply: (recipe) => setValue(recipe, path, value),
    covers: [covers],
    label,
    outcome,
  }
}

function deleteMutation(
  label: string,
  covers: string,
  path: JsonPath,
  outcome: MutationOutcome,
): MutationCase {
  return {
    apply: (recipe) => deleteValue(recipe, path),
    covers: [covers],
    label,
    outcome,
  }
}

function swapMutation(
  label: string,
  covers: string,
  path: JsonPath,
  left: number,
  right: number,
  outcome: MutationOutcome,
): MutationCase {
  return {
    apply: (recipe) => swapArray(recipe, path, left, right),
    covers: [covers],
    label,
    outcome,
  }
}

function customMutation(
  label: string,
  covers: readonly string[],
  outcome: MutationOutcome,
  apply: (recipe: JsonObject) => void,
): MutationCase {
  return { apply, covers, label, outcome }
}

function recipeMutations(): readonly MutationCase[] {
  const cases: MutationCase[] = [
    setMutation('schema-version-v1', 'recipe.schemaVersion', ['schemaVersion'], 1, 'reject'),
    setMutation(
      'source-date-epoch',
      'recipe.sourceDateEpoch',
      ['sourceDateEpoch'],
      PROOF_SOURCE_DATE_EPOCH + 1,
      'reject',
    ),
    deleteMutation('targets-property', 'recipe.targets', ['targets'], 'reject'),
    deleteMutation('upstream-property', 'recipe.upstream', ['upstream'], 'reject'),
    setMutation('zig-version', 'recipe.zigVersion', ['zigVersion'], '0.16.1', 'reject'),
    deleteMutation(
      'target-darwin-arm64',
      'targets.darwin-arm64',
      ['targets', 'darwin-arm64'],
      'reject',
    ),
    deleteMutation('target-darwin-x64', 'targets.darwin-x64', ['targets', 'darwin-x64'], 'reject'),
    deleteMutation(
      'target-linux-arm64',
      'targets.linux-arm64',
      ['targets', 'linux-arm64'],
      'reject',
    ),
    deleteMutation('target-linux-x64', 'targets.linux-x64', ['targets', 'linux-x64'], 'reject'),
    setMutation(
      'upstream-repository',
      'upstream.repository',
      ['upstream', 'repository'],
      'https://example.invalid/ghostty.git',
      'reject',
    ),
    setMutation(
      'upstream-revision',
      'upstream.revision',
      ['upstream', 'revision'],
      'f'.repeat(40),
      'reject',
    ),
    setMutation(
      'upstream-tree-sha256',
      'upstream.treeSha256',
      ['upstream', 'treeSha256'],
      'f'.repeat(64),
      'reject',
    ),
    swapMutation(
      'build-argv-order',
      'target.buildArgv',
      LINUX_TARGET.concat(['buildArgv']),
      0,
      1,
      'reject',
    ),
    swapMutation(
      'environment-order',
      'target.environment',
      LINUX_TARGET.concat(['environment']),
      0,
      1,
      'reject',
    ),
    swapMutation('input-order', 'target.inputs', LINUX_TARGET.concat(['inputs']), 0, 1, 'reject'),
    swapMutation(
      'link-plan-order',
      'target.linkPlan',
      LINUX_TARGET.concat(['linkPlan']),
      0,
      1,
      'reject',
    ),
    setMutation(
      'optimization-mode',
      'target.optimizationMode',
      LINUX_TARGET.concat(['optimizationMode']),
      'Debug',
      'reject',
    ),
    deleteMutation('runner-property', 'target.runner', LINUX_TARGET.concat(['runner']), 'reject'),
    swapMutation(
      'strip-argv-order',
      'target.stripArgv',
      LINUX_TARGET.concat(['stripArgv']),
      0,
      1,
      'reject',
    ),
    setMutation(
      'target-triple',
      'target.targetTriple',
      LINUX_TARGET.concat(['targetTriple']),
      'x86_64-linux-gnu',
      'reject',
    ),
    swapMutation('tool-order', 'target.tools', LINUX_TARGET.concat(['tools']), 0, 1, 'reject'),
    setMutation(
      'runner-arch',
      'runner.arch',
      LINUX_TARGET.concat(['runner', 'arch']),
      'arm64',
      'reject',
    ),
    setMutation(
      'runner-image',
      'runner.image',
      LINUX_TARGET.concat(['runner', 'image']),
      'changed-image',
      'reject',
    ),
    setMutation(
      'runner-image-version',
      'runner.imageVersion',
      LINUX_TARGET.concat(['runner', 'imageVersion']),
      'changed-version',
      'reject',
    ),
    setMutation(
      'runner-os',
      'runner.os',
      LINUX_TARGET.concat(['runner', 'os']),
      'darwin',
      'reject',
    ),
    setMutation(
      'environment-name',
      'environment.name',
      LINUX_TARGET.concat(['environment', 0, 'name']),
      'LC_ALL',
      'reject',
    ),
    setMutation(
      'environment-value',
      'environment.value',
      LINUX_TARGET.concat(['environment', 0, 'value']),
      'C',
      'reject',
    ),
    customMutation('tool-acquisition-variant', ['tool.acquisition'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'zig').acquisition = upstreamAcquisition()
    }),
    customMutation('tool-bytes', ['tool.bytes'], 'change', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'strip').bytes = 1_234_567
    }),
    customMutation('tool-generation', ['tool.generation'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'strip').generation = {
        argv: ['/usr/bin/strip', '--version'],
        sources: ['tool:zig'],
      }
    }),
    customMutation('tool-name', ['tool.name'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'linker').name = 'link-driver'
    }),
    customMutation('tool-role', ['tool.role'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'linker').role = 'strip'
    }),
    customMutation('tool-sha256', ['tool.sha256'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'linker').sha256 = 'e'.repeat(64)
    }),
    customMutation('tool-version', ['tool.version'], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'zig').version = '2.0.0'
    }),
    customMutation('input-acquisition-variant', ['input.acquisition'], 'change', (recipe) => {
      inputById(recipe, 'linux-x64', 'runtime').acquisition =
        officialDownload('replacement-runtime')
    }),
    customMutation('input-bytes', ['input.bytes'], 'change', (recipe) => {
      inputById(recipe, 'linux-x64', 'runtime').bytes = 7_654_321
    }),
    customMutation('input-generation', ['input.generation'], 'reject', (recipe) => {
      delete inputById(recipe, 'linux-x64', 'proof-generated-hb-c').generation
    }),
    customMutation('input-id', ['input.id'], 'change', (recipe) => {
      inputById(recipe, 'linux-x64', 'runtime').id = 'runtime-two'
    }),
    customMutation('input-role', ['input.role'], 'reject', (recipe) => {
      inputById(recipe, 'linux-x64', 'upstream').role = 'runtime-resource'
    }),
    customMutation('input-sha256', ['input.sha256'], 'change', (recipe) => {
      inputById(recipe, 'linux-x64', 'runtime').sha256 = 'd'.repeat(64)
    }),
    customMutation('generation-argv-order', ['generation.argv'], 'reject', (recipe) => {
      const argv = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).argv
      if (!Array.isArray(argv)) fail('fixture generation argv is not an array')
      ;[argv[0], argv[1]] = [argv[1] ?? null, argv[0] ?? null]
    }),
    customMutation('generation-source', ['generation.sources'], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      generation.sources.splice(1, 1)
    }),
    customMutation(
      'official-archive-bytes',
      ['official-download.archiveBytes'],
      'reject',
      (recipe) => {
        acquisitionOf(toolByRole(recipe, 'linux-x64', 'zig')).archiveBytes = 999
      },
    ),
    customMutation(
      'official-archive-sha256',
      ['official-download.archiveSha256'],
      'reject',
      (recipe) => {
        acquisitionOf(toolByRole(recipe, 'linux-x64', 'zig')).archiveSha256 = 'c'.repeat(64)
      },
    ),
    customMutation('official-kind', ['official-download.kind'], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'zig')).kind = 'git'
    }),
    customMutation('official-url', ['official-download.url'], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'zig')).url =
        'https://example.invalid/downloads/replacement.tar.xz'
    }),
    customMutation('git-kind', ['git.kind'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).kind =
        'runner-component'
    }),
    customMutation('git-repository', ['git.repository'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).repository =
        'https://example.invalid/replacement.git'
    }),
    customMutation('git-revision', ['git.revision'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).revision = 'b'.repeat(
        40,
      )
    }),
    customMutation('git-tree-algorithm', ['git.treeAlgorithm'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).treeAlgorithm =
        'git-tree-v2'
    }),
    customMutation('git-tree-sha256', ['git.treeSha256'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).treeSha256 = 'b'.repeat(
        64,
      )
    }),
    customMutation('runner-content-kind', ['runner-component.contentKind'], 'change', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).contentKind = 'external-tree-v1'
    }),
    customMutation('runner-kind', ['runner-component.kind'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).kind = 'official-download'
    }),
    customMutation('runner-macos-sdk', ['runner-component.macosSdk'], 'reject', (recipe) => {
      delete acquisitionOf(toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot')).macosSdk
    }),
    customMutation('runner-path', ['runner-component.path'], 'change', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).path =
        '/usr/share/ghostty/proof-runtime-two'
    }),
    customMutation('runner-image-field', ['runner-component.runnerImage'], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).runnerImage = 'other-image'
    }),
    customMutation(
      'runner-image-version-field',
      ['runner-component.runnerImageVersion'],
      'reject',
      (recipe) => {
        acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).runnerImageVersion =
          'other-version'
      },
    ),
    customMutation('macos-sdk-build', ['macosSdk.sdkBuild'], 'change', (recipe) => {
      macosSdkOf(recipe).sdkBuild = '24B100'
    }),
    customMutation(
      'macos-sdk-settings-sha256',
      ['macosSdk.sdkSettingsSha256'],
      'change',
      (recipe) => {
        macosSdkOf(recipe).sdkSettingsSha256 = 'a'.repeat(64)
      },
    ),
    customMutation('macos-sdk-version', ['macosSdk.sdkVersion'], 'reject', (recipe) => {
      macosSdkOf(recipe).sdkVersion = '15.1'
    }),
    customMutation('macos-xcode-build', ['macosSdk.xcodeBuild'], 'change', (recipe) => {
      macosSdkOf(recipe).xcodeBuild = '16B40'
    }),
    customMutation('macos-xcode-version', ['macosSdk.xcodeVersion'], 'change', (recipe) => {
      macosSdkOf(recipe).xcodeVersion = '16.1'
    }),
  ]
  cases.push(...strictUnknownKeyMutations())
  cases.push(...acquisitionVariantMutations())
  cases.push(...semanticContractMutations())
  return cases
}

function macosSdkOf(recipe: JsonObject): JsonObject {
  const acquisition = acquisitionOf(toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot'))
  if (!isJsonObject(acquisition.macosSdk)) fail('fixture macOS SDK metadata is not an object')
  return acquisition.macosSdk
}

function strictUnknownKeyMutations(): readonly MutationCase[] {
  return [
    customMutation('unknown-key-recipe', [], 'reject', (recipe) => {
      recipe.unknownField = true
    }),
    customMutation('unknown-key-targets', [], 'reject', (recipe) => {
      objectAt(recipe, ['targets']).unknownField = true
    }),
    customMutation('unknown-key-upstream', [], 'reject', (recipe) => {
      objectAt(recipe, ['upstream']).unknownField = true
    }),
    customMutation('unknown-key-target', [], 'reject', (recipe) => {
      targetAt(recipe, 'linux-x64').unknownField = true
    }),
    customMutation('unknown-key-runner', [], 'reject', (recipe) => {
      objectAt(recipe, LINUX_TARGET.concat(['runner'])).unknownField = true
    }),
    customMutation('unknown-key-environment', [], 'reject', (recipe) => {
      objectAt(recipe, LINUX_TARGET.concat(['environment', 0])).unknownField = true
    }),
    customMutation('unknown-key-tool', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'linker').unknownField = true
    }),
    customMutation('unknown-key-input', [], 'reject', (recipe) => {
      inputById(recipe, 'linux-x64', 'dependency').unknownField = true
    }),
    customMutation('unknown-key-generation', [], 'reject', (recipe) => {
      generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).unknownField = true
    }),
    customMutation('unknown-key-official-download', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'zig')).unknownField = true
    }),
    customMutation('unknown-key-git', [], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c')).unknownField = true
    }),
    customMutation('unknown-key-runner-component', [], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).unknownField = true
    }),
    customMutation('unknown-key-macos-sdk', [], 'reject', (recipe) => {
      macosSdkOf(recipe).unknownField = true
    }),
  ]
}

function acquisitionVariantMutations(): readonly MutationCase[] {
  return [
    customMutation('official-to-git', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'zig').acquisition = upstreamAcquisition()
    }),
    customMutation('git-to-runner-component', [], 'reject', (recipe) => {
      inputById(recipe, 'linux-x64', 'proof-generated-hb-c').acquisition = runnerComponent(
        'linux-x64',
        '/usr/share/ghostty/generated-hb',
        'file',
      )
    }),
    customMutation('runner-component-to-official', [], 'change', (recipe) => {
      inputById(recipe, 'linux-x64', 'runtime').acquisition = officialDownload('runner-to-official')
    }),
  ]
}

function semanticContractMutations(): readonly MutationCase[] {
  return targetSetMutations().concat(
    rootBoundaryMutations(),
    commandMutations(),
    linkContractMutations(),
    linkPlanTokenMutations(),
    generatedInputMutations(),
    toolContractMutations(),
  )
}

function targetSetMutations(): readonly MutationCase[] {
  return [
    customMutation('target-set-extra', [], 'reject', (recipe) => {
      objectAt(recipe, ['targets'])['freebsd-x64'] = cloneJson(targetAt(recipe, 'linux-x64'))
    }),
    customMutation('target-set-swapped', [], 'reject', (recipe) => {
      const targets = objectAt(recipe, ['targets'])
      const arm64 = cloneJson(targetAt(recipe, 'darwin-arm64'))
      targets['darwin-arm64'] = cloneJson(targetAt(recipe, 'darwin-x64'))
      targets['darwin-x64'] = arm64
    }),
  ]
}

function rootBoundaryMutations(): readonly MutationCase[] {
  const cases: MutationCase[] = []
  const boundaries: readonly [ProofTarget, string][] = [
    ['darwin-arm64', TARGET_FIXTURES['linux-x64'].root],
    ['linux-x64', TARGET_FIXTURES['darwin-x64'].root],
  ]
  const forms: readonly [string, (root: string) => string][] = [
    ['standalone', (root) => `${root}/foreign`],
    ['assignment', (root) => `PROOF_ROOT=${root}/foreign`],
    ['framework', (root) => `-F${root}/foreign`],
    ['include', (root) => `-I${root}/foreign`],
    ['library', (root) => `-L${root}/foreign`],
  ]
  for (const [target, root] of boundaries) {
    for (const [label, argument] of forms) {
      cases.push(
        customMutation(`opposite-root-${target}-${label}`, [], 'reject', (recipe) => {
          replaceLinkFiller(recipe, target, argument(root))
        }),
      )
    }
  }
  cases.push(
    customMutation('opposite-root-runner-component', [], 'reject', (recipe) => {
      acquisitionOf(inputById(recipe, 'linux-x64', 'runtime')).path =
        `${TARGET_FIXTURES['darwin-x64'].root}/foreign`
    }),
    customMutation('opposite-root-generation-argv', [], 'reject', (recipe) => {
      const generation = generationOf(
        inputById(recipe, 'darwin-arm64', 'proof-generated-help-strings'),
      )
      if (!Array.isArray(generation.argv)) fail('fixture generation argv is not an array')
      generation.argv.push(`${TARGET_FIXTURES['linux-x64'].root}/foreign`)
    }),
  )
  return cases
}

function commandMutations(): readonly MutationCase[] {
  const linuxRoot = TARGET_FIXTURES['linux-x64'].root
  const darwinRoot = TARGET_FIXTURES['darwin-arm64'].root
  return [
    customMutation('build-fixed-child', [], 'reject', (recipe) => {
      const argv = arrayAt(recipe, LINUX_TARGET.concat(['buildArgv']))
      argv[0] = '/usr/bin/zig'
    }),
    customMutation('build-final-cache', [], 'reject', (recipe) => {
      mutateArrayValue(
        arrayAt(recipe, LINUX_TARGET.concat(['buildArgv'])),
        `${linuxRoot}/final-cache`,
        `${linuxRoot}/cache`,
      )
    }),
    customMutation('build-proof-generation-mode', [], 'reject', (recipe) => {
      mutateArrayValue(
        arrayAt(recipe, LINUX_TARGET.concat(['buildArgv'])),
        '-Dproof-preverified-generated=true',
        '-Dproof-preverified-generated=false',
      )
    }),
    customMutation('environment-missing-entry', [], 'reject', (recipe) => {
      arrayAt(recipe, LINUX_TARGET.concat(['environment'])).splice(0, 1)
    }),
    customMutation('environment-extra-entry', [], 'reject', (recipe) => {
      arrayAt(recipe, LINUX_TARGET.concat(['environment'])).push({
        name: 'TZ',
        value: 'UTC',
      })
    }),
    customMutation('environment-final-cache-boundary', [], 'reject', (recipe) => {
      objectAt(recipe, LINUX_TARGET.concat(['environment', 7])).value = `${linuxRoot}/cache`
    }),
    customMutation('strip-linux-option', [], 'reject', (recipe) => {
      arrayAt(recipe, LINUX_TARGET.concat(['stripArgv']))[1] = '-x'
    }),
    customMutation('strip-linux-output', [], 'reject', (recipe) => {
      arrayAt(recipe, LINUX_TARGET.concat(['stripArgv']))[2] = `${linuxRoot}/bundle/bin/other`
    }),
    customMutation('strip-darwin-option', [], 'reject', (recipe) => {
      arrayAt(recipe, DARWIN_TARGET.concat(['stripArgv']))[1] = '--strip-all'
    }),
    customMutation('strip-darwin-output', [], 'reject', (recipe) => {
      arrayAt(recipe, DARWIN_TARGET.concat(['stripArgv']))[2] = `${darwinRoot}/bundle/bin/other`
    }),
  ]
}

function linkContractMutations(): readonly MutationCase[] {
  const target: ProofTarget = 'linux-x64'
  const root = TARGET_FIXTURES[target].root
  const triple = TARGET_FIXTURES[target].triple
  const darwinRoot = TARGET_FIXTURES['darwin-arm64'].root
  return [
    customMutation('link-fixed-zig-child', [], 'reject', (recipe) => {
      arrayAt(recipe, LINUX_TARGET.concat(['linkPlan']))[0] = '/usr/bin/zig'
    }),
    customMutation('link-fixed-build-exe-child', [], 'reject', (recipe) => {
      arrayAt(recipe, LINUX_TARGET.concat(['linkPlan']))[1] = 'build-obj'
    }),
    customMutation('link-target-value', [], 'reject', (recipe) => {
      mutateOptionValue(recipe, target, '-target', 'aarch64-linux-musl')
    }),
    customMutation('link-target-form', [], 'reject', (recipe) => {
      mutateLinkArgument(recipe, target, '-target', `-target=${triple}`)
    }),
    customMutation('link-target-count', [], 'reject', (recipe) => {
      const argv = arrayAt(recipe, LINUX_TARGET.concat(['linkPlan']))
      const option = argv.indexOf('-target')
      if (option < 0 || option + 1 >= argv.length) fail('fixture target pair was not found')
      argv[option] = `${LINK_FILLER_PREFIX}removed-target-option`
      argv[option + 1] = `${LINK_FILLER_PREFIX}removed-target-value`
    }),
    customMutation('link-plan-length', [], 'reject', (recipe) => {
      insertBeforeListen(recipe, target, `${LINK_FILLER_PREFIX}extra`)
    }),
    customMutation('link-name', [], 'reject', (recipe) => {
      mutateOptionValue(recipe, target, '--name', 'other-proof')
    }),
    customMutation('link-name-form', [], 'reject', (recipe) => {
      const argv = arrayAt(recipe, LINUX_TARGET.concat(['linkPlan']))
      const option = argv.indexOf('--name')
      if (option < 0 || option + 1 >= argv.length) fail('fixture name pair was not found')
      argv[option] = '--name=ghostty-config-resolver-proof'
      argv[option + 1] = `${LINK_FILLER_PREFIX}removed-name-value`
    }),
    customMutation('link-zig-lib-dir', [], 'reject', (recipe) => {
      mutateOptionValue(recipe, target, '--zig-lib-dir', `${root}/toolchain/lib`)
    }),
    customMutation('link-final-cache', [], 'reject', (recipe) => {
      mutateOptionValue(recipe, target, '--cache-dir', `${root}/cache`)
    }),
    customMutation('link-option-value-adjacency', [], 'reject', (recipe) => {
      const argv = arrayAt(recipe, LINUX_TARGET.concat(['linkPlan']))
      const option = argv.indexOf('--cache-dir')
      if (option < 0 || option + 2 >= argv.length) fail('fixture cache option was not found')
      ;[argv[option + 1], argv[option + 2]] = [argv[option + 2] ?? null, argv[option + 1] ?? null]
    }),
    customMutation('link-global-cache', [], 'reject', (recipe) => {
      mutateOptionValue(recipe, target, '--global-cache-dir', `${root}/cache`)
    }),
    customMutation('link-root-module', [], 'reject', (recipe) => {
      mutateLinkArgument(
        recipe,
        target,
        `-Mroot=${root}/overlay/main.zig`,
        `-Mroot=${root}/upstream/src/main.zig`,
      )
    }),
    customMutation('link-generated-module-path', [], 'reject', (recipe) => {
      mutateLinkArgument(
        recipe,
        target,
        `-Mhelp_strings=${root}/prefix/proof-generated/help_strings.zig`,
        `-Mhelp_strings=${root}/cache/help_strings.zig`,
      )
    }),
    customMutation('link-generated-module-missing', [], 'reject', (recipe) => {
      mutateLinkArgument(
        recipe,
        target,
        `-Mwuffs_c=${root}/prefix/proof-generated/wuffs_c.zig`,
        `${LINK_FILLER_PREFIX}removed-wuffs`,
      )
    }),
    customMutation('link-generated-module-inactive', [], 'reject', (recipe) => {
      replaceLinkFiller(
        recipe,
        'darwin-arm64',
        `-Mhb_c=${darwinRoot}/prefix/proof-generated/hb_c.zig`,
      )
    }),
    customMutation('link-fincremental-missing', [], 'reject', (recipe) => {
      mutateLinkArgument(recipe, target, '-fincremental', `${LINK_FILLER_PREFIX}incremental`)
    }),
    customMutation('link-response-file', [], 'reject', (recipe) => {
      replaceLinkFiller(recipe, target, '@response.rsp')
    }),
    customMutation('link-verbose-link', [], 'reject', (recipe) => {
      replaceLinkFiller(recipe, target, '--verbose-link')
    }),
    customMutation('link-listen-value', [], 'reject', (recipe) => {
      mutateLinkArgument(recipe, target, '--listen=-', '--listen=1')
    }),
    customMutation('link-listen-duplicate', [], 'reject', (recipe) => {
      replaceLinkFiller(recipe, target, '--listen=-')
    }),
    customMutation('link-listen-not-terminal', [], 'reject', (recipe) => {
      const argv = arrayAt(recipe, LINUX_TARGET.concat(['linkPlan']))
      const listen = argv.length - 1
      const previous = listen - 1
      ;[argv[previous], argv[listen]] = [argv[listen] ?? null, argv[previous] ?? null]
    }),
  ]
}

function linkPlanTokenMutations(): readonly MutationCase[] {
  const target: ProofTarget = 'linux-x64'
  const root = TARGET_FIXTURES[target].root
  const oppositeRoot = TARGET_FIXTURES['darwin-x64'].root
  return [
    customMutation('link-plan-raw-cache-key', [], 'reject', (recipe) => {
      replacePlanText(recipe, target, '{{zig-cache-key-0000}}', LINK_CACHE_KEYS.primary)
    }),
    customMutation('link-plan-malformed-cache-key', [], 'reject', (recipe) => {
      replacePlanText(recipe, target, '{{zig-cache-key-0000}}', '0'.repeat(31))
    }),
    customMutation('link-plan-uppercase-cache-key', [], 'reject', (recipe) => {
      replacePlanText(recipe, target, '{{zig-cache-key-0000}}', 'A'.repeat(32))
    }),
    customMutation('link-plan-token-gap', [], 'reject', (recipe) => {
      replacePlanText(recipe, target, '{{zig-cache-key-0001}}', '{{zig-cache-key-0003}}')
    }),
    customMutation('link-plan-token-reorder', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      replaceLinkText(plan, '{{zig-cache-key-0000}}', '{{proof-token-swap}}')
      replaceLinkText(plan, '{{zig-cache-key-0001}}', '{{zig-cache-key-0000}}')
      replaceLinkText(plan, '{{proof-token-swap}}', '{{zig-cache-key-0001}}')
    }),
    customMutation('link-plan-wrong-root', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '-Mcache_primary=', (argument) =>
        argument.replace(root, '/var/tmp/ghostty-config-resolver-proof-build-v1'),
      )
    }),
    customMutation('link-plan-wrong-root-uppercase', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '{{zig-cache-key-0002}}', (argument) =>
        argument.replace(root, '/evil').replace('{{zig-cache-key-0002}}', 'A'.repeat(32)),
      )
    }),
    customMutation('link-plan-wrong-root-malformed', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '{{zig-cache-key-0002}}', (argument) =>
        argument.replace(root, '/evil').replace('{{zig-cache-key-0002}}', '0'.repeat(31)),
      )
    }),
    customMutation('link-plan-opposite-root', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '-Mcache_primary=', (argument) =>
        argument.replace(root, oppositeRoot),
      )
    }),
    customMutation('link-plan-parent-traversal', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '-Mcache_primary=', (argument) =>
        argument.replace('/primary.zig', '/../../evil/primary.zig'),
      )
    }),
    customMutation('link-plan-current-directory', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '-Mcache_primary=', (argument) =>
        argument.replace('/primary.zig', '/./primary.zig'),
      )
    }),
    customMutation('link-plan-empty-component', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(plan, '-Mcache_primary=', (argument) =>
        argument.replace('/primary.zig', '//primary.zig'),
      )
    }),
    customMutation('link-plan-placeholder-elsewhere', [], 'reject', (recipe) => {
      replaceLinkFiller(recipe, target, `${LINK_FILLER_PREFIX}{{zig-cache-key-0000}}`)
    }),
    customMutation('link-plan-multiple-tokens-per-argument', [], 'reject', (recipe) => {
      const plan = planStrings(recipe, target)
      mutateMarkedLinkArgument(
        plan,
        '-Mcache_primary=',
        (argument) => `${argument}/${root}/final-cache/o/{{zig-cache-key-0001}}/second.zig`,
      )
    }),
  ]
}

function removeInputById(recipe: JsonObject, target: ProofTarget, id: string): void {
  const inputs = arrayAt(recipe, ['targets', target, 'inputs'])
  const index = inputs.findIndex((record) => isJsonObject(record) && record.id === id)
  if (index < 0) fail('fixture input was not found')
  inputs.splice(index, 1)
}

function generatedInputMutations(): readonly MutationCase[] {
  return [
    customMutation('generated-linux-id-missing', [], 'reject', (recipe) => {
      removeInputById(recipe, 'linux-x64', 'proof-generated-hb-c')
    }),
    customMutation('generated-linux-id-extra', [], 'reject', (recipe) => {
      const inputs = arrayAt(recipe, LINUX_TARGET.concat(['inputs']))
      const extra = cloneJson(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      extra.id = 'proof-generated-extra'
      inputs.push(extra)
      sortRecords(inputs)
    }),
    customMutation('generated-darwin-inactive-hb', [], 'reject', (recipe) => {
      const inputs = arrayAt(recipe, DARWIN_TARGET.concat(['inputs']))
      const extra = cloneJson(inputById(recipe, 'darwin-arm64', 'proof-generated-help-strings'))
      extra.id = 'proof-generated-hb-c'
      inputs.push(extra)
      sortRecords(inputs)
    }),
    customMutation('generated-argv-cache', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.argv)) fail('fixture generation argv is not an array')
      mutateArrayValue(
        generation.argv,
        `${TARGET_FIXTURES['linux-x64'].root}/cache`,
        `${TARGET_FIXTURES['linux-x64'].root}/final-cache`,
      )
    }),
    customMutation('generated-argv-mode', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.argv)) fail('fixture generation argv is not an array')
      mutateArrayValue(
        generation.argv,
        '-Dproof-preverified-generated=false',
        '-Dproof-preverified-generated=true',
      )
    }),
    customMutation('generated-sources-missing', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      generation.sources.splice(0, 1)
    }),
    customMutation('generated-sources-order', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      ;[generation.sources[0], generation.sources[1]] = [
        generation.sources[1] ?? null,
        generation.sources[0] ?? null,
      ]
    }),
    customMutation('generated-sources-extra-runtime', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      generation.sources.push('input:runtime')
      generation.sources.sort()
    }),
    customMutation('generated-sources-unknown', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      generation.sources.push('input:missing')
      generation.sources.sort()
    }),
    customMutation('generated-sources-self', [], 'reject', (recipe) => {
      const generation = generationOf(inputById(recipe, 'linux-x64', 'proof-generated-hb-c'))
      if (!Array.isArray(generation.sources)) fail('fixture generation sources is not an array')
      generation.sources.push('input:proof-generated-hb-c')
      generation.sources.sort()
    }),
    customMutation('generated-upstream-acquisition', [], 'reject', (recipe) => {
      inputById(recipe, 'linux-x64', 'proof-generated-hb-c').acquisition =
        officialDownload('generated-source')
    }),
    customMutation('darwin-zig-lib-missing', [], 'reject', (recipe) => {
      removeInputById(recipe, 'darwin-arm64', 'zig-bundled-lib-tree')
    }),
    customMutation('darwin-zig-lib-duplicate', [], 'reject', (recipe) => {
      const inputs = arrayAt(recipe, DARWIN_TARGET.concat(['inputs']))
      inputs.push(cloneJson(inputById(recipe, 'darwin-arm64', 'zig-bundled-lib-tree')))
      sortRecords(inputs)
    }),
    customMutation('darwin-zig-lib-generated', [], 'reject', (recipe) => {
      inputById(recipe, 'darwin-arm64', 'zig-bundled-lib-tree').generation = {
        argv: proofGenerationArgv('darwin-arm64'),
        sources: proofGenerationSources('darwin-arm64'),
      }
    }),
    customMutation('darwin-zig-lib-role', [], 'reject', (recipe) => {
      inputById(recipe, 'darwin-arm64', 'zig-bundled-lib-tree').role = 'runtime-resource'
    }),
    customMutation('darwin-zig-lib-acquisition', [], 'reject', (recipe) => {
      inputById(recipe, 'darwin-arm64', 'zig-bundled-lib-tree').acquisition =
        officialDownload('wrong-zig-lib')
    }),
    customMutation('linux-zig-lib-separate-input', [], 'reject', (recipe) => {
      const inputs = arrayAt(recipe, LINUX_TARGET.concat(['inputs']))
      inputs.push({
        acquisition: zigAcquisition('linux-x64'),
        bytes: 1,
        id: 'zig-bundled-lib-tree',
        role: 'generated-resource-source',
        sha256: fixtureHash('linux-separate-zig-lib'),
      })
      sortRecords(inputs)
    }),
  ]
}

function toolContractMutations(): readonly MutationCase[] {
  return [
    customMutation('tools-count-missing', [], 'reject', (recipe) => {
      arrayAt(recipe, LINUX_TARGET.concat(['tools'])).splice(0, 1)
    }),
    customMutation('tools-count-extra', [], 'reject', (recipe) => {
      const tools = arrayAt(recipe, LINUX_TARGET.concat(['tools']))
      tools.push(cloneJson(toolByRole(recipe, 'linux-x64', 'zig')))
    }),
    customMutation('linker-bytes-equal-zig', [], 'reject', (recipe) => {
      const linker = toolByRole(recipe, 'linux-x64', 'linker')
      linker.bytes = Number(linker.bytes) + 1
    }),
    customMutation('linker-sha-equal-zig', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'linker').sha256 = fixtureHash('wrong-linker')
    }),
    customMutation('linker-archive-pin', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'linker')).archiveBytes = 1
    }),
    customMutation('zig-identity-name', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'zig').name = 'zig-proof'
    }),
    customMutation('zig-identity-version', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'zig').version = '0.16.1'
    }),
    customMutation('zig-architecture-archive-pin', [], 'reject', (recipe) => {
      toolByRole(recipe, 'darwin-arm64', 'zig').acquisition = zigAcquisition('darwin-x64')
    }),
    customMutation('strip-identity-name', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'strip').name = 'strip'
    }),
    customMutation('strip-component-path', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'strip')).path = '/bin/strip'
    }),
    customMutation('strip-component-kind', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'linux-x64', 'strip')).contentKind = 'external-tree-v1'
    }),
    customMutation('strip-acquisition-model', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'strip').acquisition = officialDownload('strip')
    }),
    customMutation('darwin-sdk-identity-name', [], 'reject', (recipe) => {
      toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot').name = 'sdk'
    }),
    customMutation('darwin-sdk-version-metadata', [], 'reject', (recipe) => {
      toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot').version = '14.0'
    }),
    customMutation('darwin-sdk-acquisition-model', [], 'reject', (recipe) => {
      toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot').acquisition =
        zigAcquisition('darwin-arm64')
    }),
    customMutation('darwin-sdk-content-kind', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot')).contentKind = 'file'
    }),
    customMutation('darwin-sdk-component-path', [], 'reject', (recipe) => {
      acquisitionOf(toolByRole(recipe, 'darwin-arm64', 'sdk-or-sysroot')).path = '/opt/MacOSX.sdk'
    }),
    customMutation('linux-zig-lib-tool-name', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'sdk-or-sysroot').name = 'linux-sysroot'
    }),
    customMutation('linux-zig-lib-tool-version', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'sdk-or-sysroot').version = '0.16.1'
    }),
    customMutation('linux-zig-lib-tool-acquisition', [], 'reject', (recipe) => {
      toolByRole(recipe, 'linux-x64', 'sdk-or-sysroot').acquisition =
        officialDownload('linux-zig-lib')
    }),
  ]
}

function assertMutationCoverage(cases: readonly MutationCase[]): void {
  const covered = new Set(cases.flatMap((entry) => entry.covers).filter(Boolean))
  const expected = new Set<string>(RECIPE_SCHEMA_FIELDS)
  const missing = [...expected].filter((field) => !covered.has(field))
  const unexpected = [...covered].filter((field) => !expected.has(field))
  if (missing.length !== 0) fail(`recipe mutation coverage is missing ${missing.join(',')}`)
  if (unexpected.length !== 0)
    fail(`recipe mutation coverage is unexpected ${unexpected.join(',')}`)
}

function reverseObjectKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (!isJsonObject(value)) return value
  const result: JsonObject = {}
  for (const key of Object.keys(value).reverse())
    result[key] = reverseObjectKeys(value[key] ?? null)
  return result
}

function testRecipe(root: string): SelfTestResult['recipe'] {
  createFixtureDirectory(root)
  const recipe = recipeFixture()
  const canonical = proofCanonicalBytes(recipe)
  const canonicalSha256 = sha256(canonical)
  const reordered = proofCanonicalBytes(reverseObjectKeys(recipe))
  if (!canonical.equals(reordered)) fail('object insertion order changed canonical recipe bytes')

  const canonicalPath = join(root, 'canonical.json')
  writeFileSync(canonicalPath, canonical)
  const loaded = loadProofRecipe(canonicalPath)
  if (loaded.sha256 !== canonicalSha256) fail('canonical recipe load digest changed')

  const noncanonicalPath = join(root, 'noncanonical.json')
  writeFileSync(noncanonicalPath, `${JSON.stringify(recipe, null, 2)}\n`)
  assertProofRejection(() => loadProofRecipe(noncanonicalPath), 'pretty-printed recipe')
  writeFileSync(noncanonicalPath, canonical.subarray(0, canonical.length - 1))
  assertProofRejection(() => loadProofRecipe(noncanonicalPath), 'recipe without final LF')

  const cases = recipeMutations()
  assertMutationCoverage(cases)
  const projection = testProjectionMutations()
  const transcript = [...projection.transcript]
  let changed = 0
  let rejected = 0
  for (const entry of cases) {
    const candidate = cloneJson(recipe)
    entry.apply(candidate)
    if (entry.outcome === 'reject') {
      assertProofRejection(() => proofCanonicalBytes(candidate), entry.label)
      transcript.push(`${entry.label}:reject`)
      rejected += 1
      continue
    }
    const candidateSha256 = sha256(proofCanonicalBytes(candidate))
    if (candidateSha256 === canonicalSha256) fail(`${entry.label} did not change canonical bytes`)
    transcript.push(`${entry.label}:change:${candidateSha256}`)
    changed += 1
  }

  return {
    canonicalBytes: canonical.length,
    canonicalSha256,
    changed,
    mutationSha256: sha256(`${transcript.join('\n')}\n`),
    mutations: cases.length + projection.transcript.length,
    projectedEqual: projection.equal,
    projectedRejected: projection.rejected,
    rejected,
  }
}

function assertGoldenResult(actual: SelfTestResult): void {
  if (stableJson(actual) === stableJson(GOLDEN_RESULT)) return
  fail(`golden vectors changed: ${stableJson(actual)}`)
}

function runSelfTest(root: string): SelfTestResult {
  return {
    externalTree: testExternalTree(join(root, 'external-tree')),
    gitTree: testGitTree(join(root, 'git-tree')),
    recipe: testRecipe(join(root, 'recipe')),
  }
}

function checkedRecipeIdentity(path: string): CheckedRecipeIdentity {
  const loaded = loadProofRecipe(resolve(path))
  return { bytes: loaded.bytes.length, sha256: loaded.sha256 }
}

function recipeArgument(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--recipe' || !argv[1]) {
    fail('usage: proof-self-test.ts --recipe <canonical-proof-recipe.json>')
  }
  return argv[1]
}

function boundedError(error: unknown, root: string): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown failure'
  return raw.replaceAll(root, '<tmp>').replaceAll('\n', ' ').slice(0, 1_024)
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'ghostty-proof-self-test-'))
  try {
    const recipePath = recipeArgument(process.argv.slice(2))
    const result = runSelfTest(root)
    assertGoldenResult(result)
    const checkedRecipe = checkedRecipeIdentity(recipePath)
    process.stdout.write(`${stableJson({ checkedRecipe, result, status: 'PASS' })}\n`)
  } catch (error) {
    process.stderr.write(`${stableJson({ error: boundedError(error, root), status: 'FAIL' })}\n`)
    process.exitCode = 1
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
}

main()
