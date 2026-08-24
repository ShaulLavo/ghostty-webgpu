import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface XtermPackageManifest {
  readonly css?: string
  readonly cssClassCount?: number
  readonly cssRuleGroupCount?: number
  readonly cssSelectorCount?: number
  readonly cssSha256?: string
  readonly declarationSha256: string
  readonly integrity: string
  readonly main: string
  readonly module: string
  readonly name: string
  readonly runtimeModule?: string
  readonly types: string
  readonly version: string
}

export interface XtermAddonManifest {
  readonly commit: string
  readonly declarationSha256: string
  readonly directory: string
  readonly integrity: string
  readonly main: string
  readonly module: string
  readonly name: string
  readonly peerXterm?: string
  readonly types: string
  readonly version: string
}

export interface XtermReferenceManifest {
  readonly addons: readonly XtermAddonManifest[]
  readonly browserSupport: readonly string[]
  readonly environmentSupport: readonly string[]
  readonly packages: readonly XtermPackageManifest[]
  readonly release: {
    readonly tagCommit: string
    readonly version: string
  }
  readonly schemaVersion: 1
  readonly source: {
    readonly commit: string
    readonly url: string
  }
}

export interface XtermSubmoduleSnapshot {
  readonly configuredPath: string
  readonly configuredUrl: string
  readonly dirty: string
  readonly headCommit: string
  readonly headRef: string
  readonly indexCommit: string
  readonly originUrl: string
}

export interface XtermPackagePin {
  readonly commit: string
  readonly name: string
  readonly version: string
}

export interface XtermPackagePinSnapshot {
  readonly commit?: string
  readonly name?: string
  readonly version?: string
}

interface InstalledPackageJson {
  readonly commit?: string
  readonly main?: string
  readonly module?: string
  readonly name?: string
  readonly style?: string
  readonly types?: string
  readonly version?: string
}

interface PackFile {
  readonly path: string
}

interface PackResult {
  readonly files: readonly PackFile[]
  readonly name: string
  readonly version: string
}

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))

export class XtermReferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XtermReferenceError'
  }
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) return
  throw new XtermReferenceError(
    `${label}: expected ${String(expected)}, received ${String(actual)}`,
  )
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value === 'string' && value.length > 0) return
  throw new XtermReferenceError(`${label} must be a non-empty string`)
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (Number.isInteger(value) && Number(value) > 0) return
  throw new XtermReferenceError(`${label} must be a positive integer`)
}

function validatePackageManifest(entry: XtermPackageManifest): void {
  if (!entry.css) return
  assertString(entry.cssSha256, `${entry.name} cssSha256`)
  assertPositiveInteger(entry.cssRuleGroupCount, `${entry.name} cssRuleGroupCount`)
  assertPositiveInteger(entry.cssSelectorCount, `${entry.name} cssSelectorCount`)
  assertPositiveInteger(entry.cssClassCount, `${entry.name} cssClassCount`)
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function git(args: readonly string[], cwd = projectRoot): string {
  try {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
  } catch (cause) {
    throw new XtermReferenceError(`git ${args.join(' ')} failed: ${String(cause)}`)
  }
}

async function sha256(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

export async function readXtermManifest(root = projectRoot): Promise<XtermReferenceManifest> {
  const path = join(root, 'references/xterm-manifest.json')
  const value = await readJson<XtermReferenceManifest>(path)
  assertEqual('manifest schemaVersion', value.schemaVersion, 1)
  assertString(value.source?.url, 'manifest source.url')
  assertString(value.source?.commit, 'manifest source.commit')
  assertString(value.release?.version, 'manifest release.version')
  assertString(value.release?.tagCommit, 'manifest release.tagCommit')
  if (!Array.isArray(value.packages) || value.packages.length !== 2) {
    throw new XtermReferenceError('manifest must contain the core and headless packages')
  }
  if (!Array.isArray(value.addons) || value.addons.length === 0) {
    throw new XtermReferenceError('manifest must contain the pinned addon set')
  }
  if (!Array.isArray(value.browserSupport) || value.browserSupport.length === 0) {
    throw new XtermReferenceError('manifest must contain browser support claims')
  }
  if (!Array.isArray(value.environmentSupport)) {
    throw new XtermReferenceError('manifest must contain environment support claims')
  }
  for (const entry of value.packages) validatePackageManifest(entry)
  return value
}

function readSubmoduleSnapshot(root: string): XtermSubmoduleSnapshot {
  const referenceRoot = join(root, 'references/xterm.js')
  return {
    configuredPath: git(['config', '-f', '.gitmodules', '--get', 'submodule.xterm.path'], root),
    configuredUrl: git(['config', '-f', '.gitmodules', '--get', 'submodule.xterm.url'], root),
    originUrl: git(['remote', 'get-url', 'origin'], referenceRoot),
    headCommit: git(['rev-parse', 'HEAD'], referenceRoot),
    headRef: git(['rev-parse', '--abbrev-ref', 'HEAD'], referenceRoot),
    indexCommit: git(['rev-parse', ':references/xterm.js'], root),
    dirty: git(['status', '--porcelain=v1', '--untracked-files=all'], referenceRoot),
  }
}

export function validateXtermSubmoduleSnapshot(
  snapshot: XtermSubmoduleSnapshot,
  source: XtermReferenceManifest['source'],
): void {
  assertEqual('submodule path', snapshot.configuredPath, 'references/xterm.js')
  assertEqual('submodule URL', snapshot.configuredUrl, source.url)
  assertEqual('submodule origin', snapshot.originUrl, source.url)
  assertEqual('submodule HEAD', snapshot.headCommit, source.commit)
  assertEqual('submodule HEAD ref', snapshot.headRef, 'HEAD')
  assertEqual('submodule index commit', snapshot.indexCommit, source.commit)
  if (snapshot.dirty.length === 0) return
  throw new XtermReferenceError(`xterm reference is dirty:\n${snapshot.dirty}`)
}

function verifySubmodule(root: string, manifest: XtermReferenceManifest): void {
  validateXtermSubmoduleSnapshot(readSubmoduleSnapshot(root), manifest.source)
}

function packageRoot(root: string, name: string): string {
  return join(root, 'node_modules', ...name.split('/'))
}

async function verifyPackage(
  root: string,
  expected: XtermPackageManifest | XtermAddonManifest,
  expectedCommit: string,
): Promise<void> {
  const rootPath = packageRoot(root, expected.name)
  const installed = await readJson<InstalledPackageJson>(join(rootPath, 'package.json'))
  validateXtermPackagePin(installed, {
    commit: expectedCommit,
    name: expected.name,
    version: expected.version,
  })
  assertEqual(`${expected.name} main`, installed.main, expected.main)
  assertEqual(`${expected.name} module`, installed.module, expected.module)
  assertEqual(`${expected.name} types`, installed.types, expected.types)
  assertEqual(
    `${expected.name} declaration sha256`,
    await sha256(join(rootPath, expected.types)),
    expected.declarationSha256,
  )
  if ('runtimeModule' in expected && expected.runtimeModule) {
    await readFile(join(rootPath, expected.runtimeModule))
  }
  if (!('css' in expected) || !expected.css) return
  assertEqual(`${expected.name} CSS path`, installed.style, expected.css)
  assertEqual(
    `${expected.name} CSS sha256`,
    await sha256(join(rootPath, expected.css)),
    expected.cssSha256,
  )
}

export function validateXtermPackagePin(
  snapshot: XtermPackagePinSnapshot,
  expected: XtermPackagePin,
): void {
  assertEqual(`${expected.name} name`, snapshot.name, expected.name)
  assertEqual(`${expected.name} version`, snapshot.version, expected.version)
  assertEqual(`${expected.name} release commit`, snapshot.commit, expected.commit)
}

async function verifyPackagePins(root: string, manifest: XtermReferenceManifest): Promise<void> {
  const packageJson = await readJson<{
    readonly devDependencies?: Readonly<Record<string, string>>
  }>(join(root, 'package.json'))
  const lock = await readFile(join(root, 'bun.lock'), 'utf8')
  const expectedPackages = [...manifest.packages, ...manifest.addons]
  for (const expected of expectedPackages) {
    assertEqual(
      `${expected.name} devDependency`,
      packageJson.devDependencies?.[expected.name],
      expected.version,
    )
    if (!lock.includes(`"${expected.name}@${expected.version}"`)) {
      throw new XtermReferenceError(`${expected.name}@${expected.version} is absent from bun.lock`)
    }
    if (!lock.includes(expected.integrity)) {
      throw new XtermReferenceError(`${expected.name} integrity is absent from bun.lock`)
    }
    const expectedCommit = 'commit' in expected ? expected.commit : manifest.release.tagCommit
    await verifyPackage(root, expected, expectedCommit)
  }
}

async function addonDirectories(root: string): Promise<readonly string[]> {
  const entries = await readdir(join(root, 'references/xterm.js/addons'), { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('addon-'))
    .map((entry) => entry.name)
    .sort()
}

async function verifyAddon(root: string, expected: XtermAddonManifest): Promise<void> {
  const addonRoot = join(root, 'references/xterm.js/addons', expected.directory)
  const installed = await readJson<InstalledPackageJson>(join(addonRoot, 'package.json'))
  assertEqual(`${expected.name} name`, installed.name, expected.name)
  assertEqual(`${expected.name} version`, installed.version, expected.version)
  assertEqual(`${expected.name} main`, installed.main, expected.main)
  assertEqual(`${expected.name} module`, installed.module, expected.module)
  assertEqual(`${expected.name} types`, installed.types, expected.types)
  await readFile(join(addonRoot, expected.types))
  const released = await readJson<{ readonly peerDependencies?: Readonly<Record<string, string>> }>(
    join(packageRoot(root, expected.name), 'package.json'),
  )
  assertEqual(
    `${expected.name} xterm peer`,
    released.peerDependencies?.['@xterm/xterm'],
    expected.peerXterm,
  )
}

async function verifyAddons(root: string, manifest: XtermReferenceManifest): Promise<void> {
  const expectedDirectories = manifest.addons.map((addon) => addon.directory).sort()
  const actualDirectories = await addonDirectories(root)
  assertEqual('addon directory set', actualDirectories.join(','), expectedDirectories.join(','))
  for (const addon of manifest.addons) await verifyAddon(root, addon)
}

async function verifyBrowserClaim(root: string, manifest: XtermReferenceManifest): Promise<void> {
  const readme = await readFile(join(root, 'references/xterm.js/README.md'), 'utf8')
  const claims = [...manifest.browserSupport, ...manifest.environmentSupport]
  for (const claim of claims) {
    if (readme.includes(claim)) continue
    throw new XtermReferenceError(`Pinned README no longer names supported environment ${claim}`)
  }
}

function parsePackResult(output: string): PackResult {
  const parsed = JSON.parse(output) as readonly PackResult[]
  const result = parsed[0]
  if (result) return result
  throw new XtermReferenceError('npm pack returned no package result')
}

function verifyProjectPack(root: string): void {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  })
  const result = parsePackResult(output)
  const forbidden = result.files.find((file) => file.path.startsWith('references/'))
  if (forbidden) {
    throw new XtermReferenceError(`npm artifact includes reference file ${forbidden.path}`)
  }
  const projectPackage = JSON.parse(
    execFileSync('npm', ['pkg', 'get', 'name', 'version'], { cwd: root, encoding: 'utf8' }),
  ) as { readonly name: string; readonly version: string }
  assertEqual('packed package name', result.name, projectPackage.name)
  assertEqual('packed package version', result.version, projectPackage.version)
}

export async function verifyXtermReference(
  options: { readonly pack?: boolean; readonly root?: string } = {},
): Promise<XtermReferenceManifest> {
  const root = options.root ?? projectRoot
  const manifest = await readXtermManifest(root)
  verifySubmodule(root, manifest)
  await verifyPackagePins(root, manifest)
  await verifyAddons(root, manifest)
  await verifyBrowserClaim(root, manifest)
  if (options.pack) verifyProjectPack(root)
  return manifest
}

async function main(): Promise<void> {
  const pack = process.argv.includes('--pack')
  const manifest = await verifyXtermReference({ pack })
  const suffix = pack ? ' and npm artifact' : ''
  console.log(
    `Verified xterm ${manifest.release.version}, ${manifest.addons.length} addons, pinned source ${manifest.source.commit}${suffix}`,
  )
}

if (import.meta.main) await main()
