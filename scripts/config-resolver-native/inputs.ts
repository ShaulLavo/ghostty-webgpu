import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { canonicalObjectBytes, NativeContractError, sha256 } from './canonical'
import {
  NATIVE_BUILD_RECIPE_PATH,
  NATIVE_INPUTS_PATH,
  NATIVE_PROOF_RECIPE_SHA256,
  NATIVE_TARGETS,
  NATIVE_UPSTREAM_REPOSITORY,
  NATIVE_UPSTREAM_REVISION,
  NATIVE_UPSTREAM_TREE_SHA256,
} from './constants'
import {
  loadBuildRecipe,
  loadNativeInputs,
  validateNativeInputs,
  type NativeInputs,
  type NativeOwnedFile,
} from './contract'
import { compareBytes } from './order'

const FIXED_OWNED_PATHS = [
  '.github/workflows/ci.yml',
  '.github/workflows/config-resolver.yml',
  'bun.lock',
  'package.json',
  'scripts/build-config-resolver.ts',
  'scripts/config-resolver-proof/proof-contract.ts',
  'scripts/config-resolver-proof/proof-recipe.json',
  'scripts/config-resolver-proof/upstream-audit.ts',
  'scripts/verify-config-resolver-artifacts.ts',
  'src/config-resolver/canonicalize.ts',
  'src/config-resolver/schema.ts',
  'src/config-resolver/types.ts',
  'src/core/version.ts',
  'tsconfig.json',
] as const

export function createNativeInputs(repositoryRoot: string): NativeInputs {
  const recipe = loadBuildRecipe(join(repositoryRoot, NATIVE_BUILD_RECIPE_PATH))
  const ownedFiles = discoverOwnedPaths(repositoryRoot).map((path) =>
    worktreeOwnedFile(repositoryRoot, path),
  )
  return validateNativeInputs({
    schemaVersion: 1,
    upstream: {
      repository: NATIVE_UPSTREAM_REPOSITORY,
      revision: NATIVE_UPSTREAM_REVISION,
      treeSha256: NATIVE_UPSTREAM_TREE_SHA256,
    },
    proofRecipeSha256: NATIVE_PROOF_RECIPE_SHA256,
    buildRecipeSha256: recipe.sha256,
    ownedFiles,
    targets: Object.fromEntries(
      NATIVE_TARGETS.map((target) => [
        target,
        { tools: recipe.value.targets[target].tools, inputs: recipe.value.targets[target].inputs },
      ]),
    ),
  })
}

export function verifyNativeInputs(
  repositoryRoot: string,
  options: { readonly gitHead?: string; readonly requireCurrentCleanHead?: boolean } = {},
): { readonly value: NativeInputs; readonly sha256: string } {
  const loaded = loadNativeInputs(join(repositoryRoot, NATIVE_INPUTS_PATH))
  const expected = createNativeInputs(repositoryRoot)
  if (!loaded.bytes.equals(canonicalObjectBytes(expected))) {
    throw new NativeContractError('native inputs do not match the worktree closure')
  }
  if (options.gitHead) verifyOwnedFilesAtHead(repositoryRoot, loaded.value, options.gitHead)
  if (options.gitHead && options.requireCurrentCleanHead) {
    verifyCurrentCleanHead(repositoryRoot, options.gitHead)
  }
  return { value: loaded.value, sha256: loaded.sha256 }
}

export function verifyOwnedFilesAtHead(
  repositoryRoot: string,
  inputs: NativeInputs,
  expectedHead: string,
): void {
  if (!/^[0-9a-f]{40}$/.test(expectedHead)) {
    throw new NativeContractError('native build source HEAD is invalid')
  }
  for (const expected of inputs.ownedFiles) {
    const actual = gitOwnedFile(repositoryRoot, expectedHead, expected.path)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new NativeContractError(`native owned input differs from ${expectedHead}`)
    }
  }
}

function verifyCurrentCleanHead(repositoryRoot: string, expectedHead: string): void {
  const head = gitText(repositoryRoot, ['rev-parse', 'HEAD']).trim()
  if (head !== expectedHead)
    throw new NativeContractError('native build source HEAD does not match')
  if (gitText(repositoryRoot, ['status', '--short']).length !== 0) {
    throw new NativeContractError('native build source tree is not clean')
  }
}

export function discoverOwnedPaths(repositoryRoot: string): readonly string[] {
  const paths: string[] = [...FIXED_OWNED_PATHS]
  walkOwnedDirectory(repositoryRoot, 'scripts/config-resolver-native', paths)
  const filtered = paths.filter((path) => path !== NATIVE_INPUTS_PATH)
  filtered.sort(compareBytes)
  for (let index = 1; index < filtered.length; index += 1) {
    if (filtered[index - 1] === filtered[index]) {
      throw new NativeContractError('native owned path closure contains a duplicate')
    }
  }
  assertOwnedImportClosure(repositoryRoot, filtered)
  return filtered
}

function assertOwnedImportClosure(repositoryRoot: string, paths: readonly string[]): void {
  const owned = new Set(paths)
  for (const path of paths) {
    if (!path.endsWith('.ts')) continue
    const source = readFileSync(join(repositoryRoot, ...path.split('/')), 'utf8')
    for (const specifier of relativeImports(source)) {
      const imported = resolveOwnedImport(repositoryRoot, path, specifier)
      if (owned.has(imported)) continue
      throw new NativeContractError(`native import is outside the owned closure: ${imported}`)
    }
  }
}

function relativeImports(source: string): readonly string[] {
  const imports: string[] = []
  const pattern = /(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1]
    if (specifier) imports.push(specifier)
  }
  return imports
}

function resolveOwnedImport(repositoryRoot: string, importer: string, specifier: string): string {
  const source = join(repositoryRoot, ...dirname(importer).split('/'))
  const requested = resolve(source, specifier)
  const candidates = importCandidates(requested)
  const absolute = candidates.find(
    (candidate) => existsSync(candidate) && lstatSync(candidate).isFile(),
  )
  if (!absolute) throw new NativeContractError(`native import cannot be resolved: ${specifier}`)
  const path = relative(repositoryRoot, absolute).split(sep).join('/')
  if (!path || path === '..' || path.startsWith('../')) {
    throw new NativeContractError('native import escapes the repository')
  }
  return path
}

function importCandidates(requested: string): readonly string[] {
  if (requested.endsWith('.js')) return [`${requested.slice(0, -3)}.ts`]
  return [requested, `${requested}.ts`, `${requested}.json`, join(requested, 'index.ts')]
}

function walkOwnedDirectory(repositoryRoot: string, relative: string, paths: string[]): void {
  const absolute = join(repositoryRoot, ...relative.split('/'))
  const entries = readdirSync(absolute, { encoding: 'utf8' }).sort(compareBytes)
  for (const name of entries) {
    const path = `${relative}/${name}`
    const stat = lstatSync(join(repositoryRoot, ...path.split('/')))
    if (stat.isSymbolicLink())
      throw new NativeContractError('native owned inputs contain a symlink')
    if (stat.isDirectory()) {
      walkOwnedDirectory(repositoryRoot, path, paths)
      continue
    }
    if (!stat.isFile()) throw new NativeContractError('native owned inputs contain a special file')
    paths.push(path)
  }
}

function worktreeOwnedFile(repositoryRoot: string, path: string): NativeOwnedFile {
  const absolute = join(repositoryRoot, ...path.split('/'))
  const stat = lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new NativeContractError(`native owned input is not a regular file: ${path}`)
  }
  const mode = stat.mode & 0o111 ? '100755' : '100644'
  const contents = readFileSync(absolute)
  return { path, mode, bytes: contents.length, sha256: sha256(contents) }
}

function gitOwnedFile(repositoryRoot: string, head: string, path: string): NativeOwnedFile {
  const tree = gitBuffer(repositoryRoot, ['ls-tree', '-z', head, '--', path])
  const record = tree.toString('utf8')
  if (!record.endsWith('\0') || record.indexOf('\0') !== record.length - 1) {
    throw new NativeContractError(`native owned input is untracked: ${path}`)
  }
  const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\r\n]+)$/.exec(record.slice(0, -1))
  if (!match || match[3] !== path)
    throw new NativeContractError(`native owned input is untracked: ${path}`)
  const contents = gitBuffer(repositoryRoot, ['cat-file', 'blob', `${head}:${path}`])
  return {
    path,
    mode: match[1] as '100644' | '100755',
    bytes: contents.length,
    sha256: sha256(contents),
  }
}

function gitText(repositoryRoot: string, argv: readonly string[]): string {
  return gitBuffer(repositoryRoot, argv).toString('utf8')
}

function gitBuffer(repositoryRoot: string, argv: readonly string[]): Buffer {
  const result = spawnSync('git', ['-C', repositoryRoot, ...argv], {
    encoding: 'buffer',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0 || result.stderr.length !== 0) {
    throw new NativeContractError('Git native-input inspection failed')
  }
  return result.stdout
}
