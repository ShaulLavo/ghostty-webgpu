import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from 'node:fs'
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedBytes, transferBytes } from './package-measurements'
import { canonicalObjectBytes } from './config-resolver-native/canonical'
import {
  validateNativeResolverManifest,
  type NativeArtifactFile,
  type NativeResolverManifest,
} from './config-resolver-native/contract'
import {
  NATIVE_TARGETS,
  NATIVE_TOTAL_CEILING,
  type NativeTarget,
} from './config-resolver-native/constants'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const maximumTarballBytes = NATIVE_TOTAL_CEILING

class PackageSmokeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackageSmokeError'
  }
}

interface RunOptions {
  readonly env?: NodeJS.ProcessEnv
}

interface FileState {
  readonly ctimeNs: bigint
  readonly dev: bigint
  readonly ino: bigint
  readonly mode: bigint
  readonly mtimeNs: bigint
  readonly size: bigint
}

interface OpenFileSnapshot {
  readonly descriptor: number
  readonly path: string
  readonly sha256: string
  readonly state: FileState
}

async function run(
  command: readonly string[],
  cwd: string,
  options: RunOptions = {},
): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd,
    env: options.env,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode === 0) return stdout.trim()
  throw new PackageSmokeError(
    `package smoke subprocess exited with status ${exitCode}: ${stderr.trim()}\n${stdout.trim()}`,
  )
}

function readPackFilename(output: string): string {
  if (!output.startsWith('[')) return output

  let result: unknown
  try {
    result = JSON.parse(output)
  } catch {
    throw new PackageSmokeError('npm pack returned invalid JSON')
  }
  if (!Array.isArray(result) || result.length !== 1) {
    throw new PackageSmokeError('npm pack returned an unexpected result')
  }

  const entry: unknown = result[0]
  if (typeof entry !== 'object' || entry === null) {
    throw new PackageSmokeError('npm pack result is missing package metadata')
  }

  const filename = (entry as { filename?: unknown }).filename
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new PackageSmokeError('npm pack result is missing a filename')
  }
  return filename
}

async function requirePath(path: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new PackageSmokeError(`packed package is missing ${path}`)
  }
}

async function rejectPath(path: string): Promise<void> {
  try {
    await access(path)
  } catch {
    return
  }
  throw new PackageSmokeError(`packed package contains stale output ${path}`)
}

function openFileSnapshot(path: string, maximumBytes: number): OpenFileSnapshot {
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    throw new PackageSmokeError('tarball must name a readable regular file')
  }
  try {
    const before = fstatSync(descriptor, { bigint: true })
    validateSnapshotFile(before, maximumBytes)
    const bytes = readDescriptor(descriptor, Number(before.size))
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameStats(before, after) || BigInt(bytes.length) !== after.size) {
      throw new PackageSmokeError('tarball changed while its identity was recorded')
    }
    return {
      descriptor,
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      state: fileState(after),
    }
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

function assertOpenFileUnchanged(snapshot: OpenFileSnapshot, maximumBytes: number): void {
  const heldBefore = fstatSync(snapshot.descriptor, { bigint: true })
  validateSnapshotFile(heldBefore, maximumBytes)
  const heldBytes = readDescriptor(snapshot.descriptor, Number(heldBefore.size))
  const heldAfter = fstatSync(snapshot.descriptor, { bigint: true })
  const heldHash = createHash('sha256').update(heldBytes).digest('hex')
  if (!sameStats(heldBefore, heldAfter) || !sameState(snapshot.state, fileState(heldAfter))) {
    throw new PackageSmokeError('supplied tarball metadata changed during verification')
  }
  if (heldHash !== snapshot.sha256) {
    throw new PackageSmokeError('supplied tarball bytes changed during verification')
  }

  const current = openFileSnapshot(snapshot.path, maximumBytes)
  try {
    if (!sameState(snapshot.state, current.state) || snapshot.sha256 !== current.sha256) {
      throw new PackageSmokeError('supplied tarball path changed during verification')
    }
  } finally {
    closeSync(current.descriptor)
  }
}

function readDescriptor(descriptor: number, bytes: number): Buffer {
  const result = Buffer.alloc(bytes)
  let offset = 0
  while (offset < bytes) {
    const count = readSync(descriptor, result, offset, bytes - offset, offset)
    if (count === 0) throw new PackageSmokeError('tarball was truncated while it was read')
    offset += count
  }
  const overflow = Buffer.alloc(1)
  if (readSync(descriptor, overflow, 0, 1, bytes) !== 0) {
    throw new PackageSmokeError('tarball grew while it was read')
  }
  return result
}

function validateSnapshotFile(stats: BigIntStats, maximumBytes: number): void {
  if (!stats.isFile()) throw new PackageSmokeError('tarball is not a regular file')
  if (stats.size < 1n || stats.size > BigInt(maximumBytes)) {
    throw new PackageSmokeError('tarball exceeds its byte bound')
  }
}

function fileState(stats: BigIntStats): FileState {
  return {
    ctimeNs: stats.ctimeNs,
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    mtimeNs: stats.mtimeNs,
    size: stats.size,
  }
}

function sameStats(left: BigIntStats, right: BigIntStats): boolean {
  return sameState(fileState(left), fileState(right))
}

function sameState(left: FileState, right: FileState): boolean {
  return (
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  )
}

async function writeConsumerFiles(root: string, browserOnly = false): Promise<void> {
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'ghostty-webgpu-package-smoke', private: true, type: 'module' }, null, 2)}\n`,
  )
  await writeFile(
    join(root, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ['ES2023', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2023',
        },
        include: ['index.ts'],
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(root, 'index.ts'),
    `import {
  Terminal,
  type GhosttyWebGpuTerminalAppearanceApi,
  type RendererTheme,
  type TerminalAppearance,
  type TerminalAppearanceOptions,
  type TerminalRendererTheme,
  type TerminalTheme,
} from 'ghostty-webgpu'
${browserOnly ? '' : "import { resolveGhosttyConfigAppearance, type GhosttyConfigAppearance } from 'ghostty-webgpu/config-resolver'"}
import { Terminal as XtermTerminal, type ITerminalOptions } from 'ghostty-webgpu/xterm'
import 'ghostty-webgpu/xterm.css'

const color = { b: 3, g: 2, r: 1 }
const rendererTheme: RendererTheme = {
  background: color,
  cursor: color,
  foreground: color,
  minimumContrast: 1,
  selectionBackground: color,
  selectionForeground: color,
}
const terminalRendererTheme: TerminalRendererTheme = rendererTheme
const terminalTheme: TerminalTheme = {
  ...terminalRendererTheme,
  palette: Array.from({ length: 256 }, () => color),
}
const terminalAppearance: TerminalAppearance = {
  colorScheme: 'dark',
  cursor: { blink: false, style: 'block' },
  font: {
    boldWeight: 700,
    family: 'monospace',
    letterSpacing: 0,
    lineHeight: 1.2,
    size: 14,
    weight: 400,
  },
  grid: { cellHeight: 20, cellWidth: 10, columns: 80, pixelRatio: 1, rows: 24 },
  rendererTheme: terminalRendererTheme,
  scrollbackLimit: undefined,
  theme: terminalTheme,
}
const appearanceOptions: TerminalAppearanceOptions = { theme: terminalTheme }
const legacyAppearanceApi: GhosttyWebGpuTerminalAppearanceApi = {
  setColorScheme() {},
  setCursor() {},
  setFont() {},
  setTheme() {},
}
const xtermOptions: ITerminalOptions = { cursorBlink: true, theme: { background: '#010203' } }
${
  browserOnly
    ? ''
    : `const appearance: Promise<GhosttyConfigAppearance | undefined> = resolveGhosttyConfigAppearance().then(
  (result) => (result.status === 'ready' ? result.appearance : undefined),
)
void appearance`
}
void Terminal
void XtermTerminal
void appearanceOptions
void legacyAppearanceApi
void rendererTheme
void terminalAppearance
void terminalRendererTheme
void terminalTheme
void xtermOptions
`,
  )
}

async function verifyBrowserFiles(packageRoot: string): Promise<void> {
  for (const path of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/config-resolver/index.js',
    'dist/config-resolver/index.d.ts',
    'dist/xterm/terminal.js',
    'dist/xterm/terminal.d.ts',
    'dist/xterm/xterm.css',
    'types/legacy/config-resolver.d.ts',
    'types/legacy/index.d.ts',
    'types/legacy/xterm-css.d.ts',
    'types/legacy/xterm.d.ts',
    'ghostty-vt.wasm',
    'bridge.wasm',
  ]) {
    await requirePath(join(packageRoot, path))
  }
}

async function verifyPackagedFiles(packageRoot: string): Promise<NativeResolverManifest> {
  await verifyBrowserFiles(packageRoot)
  const manifest = await verifyPackagedNativeTree(packageRoot)
  await rejectPath(join(packageRoot, 'native/config-resolver/bootstrap.json'))
  await rejectPath(join(packageRoot, 'scripts/config-resolver-native'))
  await rejectPath(join(packageRoot, 'dist/xterm/operation-queue.js'))
  await rejectPath(join(packageRoot, 'dist/render/shaders/background.wgsl.js'))
  return manifest
}

interface ExpectedNativeFile {
  readonly bytes: number
  readonly mode: '0644' | '0755'
  readonly sha256: string
}

async function verifyPackagedNativeTree(packageRoot: string): Promise<NativeResolverManifest> {
  const nativeRoot = join(packageRoot, 'native')
  const nativeMetadata = await lstat(nativeRoot)
  if (!nativeMetadata.isDirectory() || nativeMetadata.isSymbolicLink()) {
    throw new PackageSmokeError('packed native root is not a real directory')
  }
  const manifestPath = join(nativeRoot, 'config-resolver/manifest.json')
  const manifestBytes = await readFile(manifestPath)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes))
  } catch {
    throw new PackageSmokeError('packed native manifest is not valid UTF-8 JSON')
  }
  if (!manifestBytes.equals(canonicalObjectBytes(value))) {
    throw new PackageSmokeError('packed native manifest is not canonical JSON plus LF')
  }
  const manifest = validateNativeResolverManifest(value)
  const expected = new Map<string, ExpectedNativeFile>()
  expected.set('config-resolver/manifest.json', {
    bytes: manifestBytes.length,
    mode: '0644',
    sha256: createHash('sha256').update(manifestBytes).digest('hex'),
  })
  for (const target of NATIVE_TARGETS) {
    addExpectedTargetFiles(expected, target, manifest.targets[target].files)
  }
  const expectedDirectories = nativeDirectoriesFor(expected.keys())
  const actual = await collectNativeEntries(nativeRoot)
  if (!sameStringSet(actual.directories, expectedDirectories)) {
    throw new PackageSmokeError('packed package native directories differ from the manifest')
  }
  if (!sameStringSet(actual.files, new Set(expected.keys()))) {
    throw new PackageSmokeError('packed package native files differ from the manifest')
  }
  for (const [path, file] of expected) {
    await verifyInstalledNativeFile(join(nativeRoot, ...path.split('/')), file)
  }
  return manifest
}

function addExpectedTargetFiles(
  expected: Map<string, ExpectedNativeFile>,
  target: NativeTarget,
  files: readonly NativeArtifactFile[],
): void {
  for (const file of files) {
    const path = `config-resolver/${target}/${file.path}`
    if (expected.has(path)) throw new PackageSmokeError('native manifest repeats a packaged path')
    expected.set(path, file)
  }
}

function nativeDirectoriesFor(paths: Iterable<string>): Set<string> {
  const directories = new Set<string>()
  for (const path of paths) {
    const components = path.split('/')
    components.pop()
    while (components.length > 0) {
      directories.add(components.join('/'))
      components.pop()
    }
  }
  return directories
}

async function collectNativeEntries(
  root: string,
): Promise<{ readonly directories: Set<string>; readonly files: Set<string> }> {
  const directories = new Set<string>()
  const files = new Set<string>()
  await walkNativeDirectory(root, '', directories, files)
  return { directories, files }
}

async function walkNativeDirectory(
  root: string,
  parent: string,
  directories: Set<string>,
  files: Set<string>,
): Promise<void> {
  const absolute = parent ? join(root, ...parent.split('/')) : root
  const entries = await readdir(absolute, { withFileTypes: true })
  for (const entry of entries) {
    const path = parent ? `${parent}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new PackageSmokeError('packed native tree has a symlink')
    if (entry.isFile()) {
      files.add(path)
      continue
    }
    if (!entry.isDirectory()) throw new PackageSmokeError('packed native tree has a special file')
    directories.add(path)
    await walkNativeDirectory(root, path, directories, files)
  }
}

async function verifyInstalledNativeFile(
  path: string,
  expected: ExpectedNativeFile,
): Promise<void> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new PackageSmokeError('packed native asset is not a regular file')
  }
  const mode = (metadata.mode & 0o777).toString(8).padStart(4, '0')
  if (mode !== expected.mode) throw new PackageSmokeError('packed native asset mode differs')
  const bytes = await readFile(path)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== expected.bytes || sha256 !== expected.sha256) {
    throw new PackageSmokeError('packed native asset identity differs')
  }
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

async function verifyTypes(root: string): Promise<void> {
  await run([join(projectRoot, 'node_modules/.bin/tsc'), '--project', 'tsconfig.json'], root)
  const legacy = join(projectRoot, 'node_modules/typescript-legacy/bin/tsc')
  await run(['node', legacy, '--project', 'tsconfig.json'], root)
  await run(['node', legacy, '--project', 'tsconfig.json', '--moduleResolution', 'node'], root)
}

async function verifyRootIsolation(root: string, packageRoot: string): Promise<void> {
  const native = join(packageRoot, 'native')
  const hidden = join(packageRoot, 'native.package-smoke-hidden')
  const hasNative = existsSync(native)
  if (hasNative) await rename(native, hidden)
  try {
    await run(
      [
        'node',
        '--input-type=module',
        '--eval',
        `import * as Native from 'ghostty-webgpu'
import { Terminal as XtermTerminal } from 'ghostty-webgpu/xterm'
const { Terminal } = Native
if (typeof Terminal.create !== 'function') throw new Error('root Terminal is not the native API')
if (typeof XtermTerminal !== 'function') throw new Error('missing xterm Terminal export')
if (Terminal === XtermTerminal) throw new Error('native and xterm entry points resolve to one class')
if ('GhosttyWebGpuTerminal' in Native) throw new Error('root still exports the removed terminal name')`,
      ],
      root,
    )
  } finally {
    if (hasNative) await rename(hidden, native)
  }
}

async function verifyBrowserConditions(root: string): Promise<ReturnType<typeof transferBytes>> {
  const browserRoot = join(root, 'browser-root.ts')
  const browserResolver = join(root, 'browser-resolver.ts')
  await writeFile(
    browserRoot,
    "import { Terminal } from 'ghostty-webgpu'\nimport { Terminal as XtermTerminal } from 'ghostty-webgpu/xterm'\nconsole.log(Terminal, XtermTerminal)\n",
  )
  await writeFile(
    browserResolver,
    "import { resolveGhosttyConfigAppearance } from 'ghostty-webgpu/config-resolver'\nconsole.log(resolveGhosttyConfigAppearance)\n",
  )

  const rootBuild = await Bun.build({
    entrypoints: [browserRoot],
    format: 'esm',
    target: 'browser',
  })
  if (!rootBuild.success || rootBuild.outputs.length !== 1) {
    throw new PackageSmokeError('browser-safe root did not bundle for a browser target')
  }
  const bundle = await rootBuild.outputs[0]!.text()
  for (const forbidden of [
    'node:',
    'config-resolver',
    'native/config-resolver',
    'resolveGhosttyConfigAppearance',
  ]) {
    if (!bundle.includes(forbidden)) continue
    throw new PackageSmokeError('browser-safe root bundle contains a host-only dependency')
  }

  const resolverBuild = await Bun.build({
    entrypoints: [browserResolver],
    format: 'esm',
    target: 'browser',
    throw: false,
  })
  if (resolverBuild.success) {
    throw new PackageSmokeError('host resolver unexpectedly resolved for a browser target')
  }
  if (!resolverBuild.logs.some((log) => log.message.includes('ghostty-webgpu/config-resolver'))) {
    throw new PackageSmokeError('host resolver browser build failed for an unrelated reason')
  }
  return transferBytes(new TextEncoder().encode(bundle))
}

async function verifyHostExportShape(packageRoot: string): Promise<void> {
  const value: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (typeof value !== 'object' || value === null)
    throw new PackageSmokeError('package.json is invalid')
  const exportsValue = (value as { exports?: unknown }).exports
  if (typeof exportsValue !== 'object' || exportsValue === null) {
    throw new PackageSmokeError('package exports are missing')
  }
  const resolver = (exportsValue as Record<string, unknown>)['./config-resolver']
  if (typeof resolver !== 'object' || resolver === null || Array.isArray(resolver)) {
    throw new PackageSmokeError('config resolver export is missing')
  }
  const keys = Object.keys(resolver).sort()
  const expected = ['bun', 'node', 'types', 'types@>=7.0'].sort()
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new PackageSmokeError('config resolver has a browser/default fallback')
  }
}

interface ResolverFixtureEnvironment {
  readonly environment: NodeJS.ProcessEnv
  readonly sentinels: readonly string[]
}

async function resolverEnvironment(
  workspace: string,
  label: string,
  configText?: string,
): Promise<ResolverFixtureEnvironment> {
  const pathSentinel = `PRIVATE_PATH_${label}_7a91c5`
  const resourceSentinel = `PRIVATE_RESOURCE_${label}_3f48b2`
  const root = join(workspace, pathSentinel)
  const home = join(root, 'home')
  const config = join(root, 'config')
  const temporary = join(root, 'tmp')
  const emptyPath = join(root, 'empty-path')
  await mkdir(join(config, 'ghostty'), { recursive: true })
  await mkdir(home)
  await mkdir(temporary)
  await mkdir(emptyPath)
  if (configText !== undefined) {
    await writeFile(join(config, 'ghostty', 'config.ghostty'), configText)
  }
  return {
    environment: {
      CFFIXED_USER_HOME: home,
      GHOSTTY_RESOURCES_DIR: join(root, resourceSentinel),
      HOME: home,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PATH: emptyPath,
      TMPDIR: temporary,
      XDG_CONFIG_HOME: config,
    },
    sentinels: [pathSentinel, resourceSentinel],
  }
}

async function verifyResolverRuntime(root: string, workspace: string): Promise<void> {
  const runtimes = await resolverRuntimes()
  const ready = await resolverEnvironment(
    workspace,
    'READY',
    'background = #102030\nforeground = #f0e0d0\n',
  )
  const readyProgram = `import { resolveGhosttyConfigAppearance } from 'ghostty-webgpu/config-resolver'
const result = await resolveGhosttyConfigAppearance()
if (result.status !== 'ready') throw new Error('resolver did not return ready')
const background = result.appearance.profiles.light.theme.background
if (background.r !== 16 || background.g !== 32 || background.b !== 48) {
  throw new Error('resolver returned the wrong fixture appearance')
}
if (!/^[0-9a-f]{64}$/.test(result.appearance.revision)) throw new Error('invalid revision')
console.log('ready-pass')`
  await runResolverProbe(root, runtimes, ready, readyProgram, 'ready-pass')

  const configSentinel = 'PRIVATE_CONFIG_VALUE_e18c67'
  const themeSentinel = 'PRIVATE_THEME_LABEL_94b02d'
  const diagnostic = await resolverEnvironment(
    workspace,
    'DIAGNOSTIC',
    `background = #102030\nfont-size = ${configSentinel}\ntheme = ${themeSentinel}\n`,
  )
  const diagnosticSentinels = [...diagnostic.sentinels, configSentinel, themeSentinel]
  const diagnosticProgram = `import { resolveGhosttyConfigAppearance } from 'ghostty-webgpu/config-resolver'
const result = await resolveGhosttyConfigAppearance()
if (result.status !== 'ready') throw new Error('diagnostic fixture was not resolved')
if (result.appearance.diagnosticCount < 1) throw new Error('diagnostic fixture lacked diagnostics')
const serialized = JSON.stringify(result)
for (const sentinel of ${JSON.stringify(diagnosticSentinels)}) {
  if (serialized.includes(sentinel)) throw new Error('resolver leaked diagnostic input')
}
console.log('diagnostic-pass')`
  await runResolverProbe(
    root,
    runtimes,
    { ...diagnostic, sentinels: diagnosticSentinels },
    diagnosticProgram,
    'diagnostic-pass',
  )

  const missing = await resolverEnvironment(workspace, 'MISSING')
  const missingProgram = `import { resolveGhosttyConfigAppearance } from 'ghostty-webgpu/config-resolver'
const result = await resolveGhosttyConfigAppearance()
if (result.status !== 'unavailable' || result.reason !== 'config-not-found') {
  throw new Error('missing config did not return its fixed reason')
}
const serialized = JSON.stringify(result)
for (const sentinel of ${JSON.stringify(missing.sentinels)}) {
  if (serialized.includes(sentinel)) throw new Error('resolver leaked missing-config input')
}
console.log('missing-pass')`
  await runResolverProbe(root, runtimes, missing, missingProgram, 'missing-pass')
}

interface ResolverRuntimes {
  readonly node: string
  readonly bun: string
}

async function resolverRuntimes(): Promise<ResolverRuntimes> {
  const node = Bun.which('node')
  if (!node) throw new PackageSmokeError('Node runtime is unavailable')
  const [nodePath, bunPath] = await Promise.all([realpath(node), realpath(process.execPath)])
  if (nodePath === bunPath) throw new PackageSmokeError('Node and Bun resolve to one runtime')
  return { node: nodePath, bun: bunPath }
}

async function runResolverProbe(
  root: string,
  runtimes: ResolverRuntimes,
  fixture: ResolverFixtureEnvironment,
  program: string,
  expected: string,
): Promise<void> {
  const nodeProgram = `if (process.release?.name !== 'node' || process.versions.bun) throw new Error('not Node')
${program}`
  const bunProgram = `if (!process.versions.bun) throw new Error('not Bun')
${program}`
  const node = await runResolverCommand(
    [runtimes.node, '--input-type=module', '--eval', nodeProgram],
    root,
    fixture.environment,
  )
  const bun = await runResolverCommand(
    [runtimes.bun, '--eval', bunProgram],
    root,
    fixture.environment,
  )
  if (node !== expected || bun !== expected) {
    throw new PackageSmokeError('resolver probe output differs')
  }
  for (const sentinel of fixture.sentinels) {
    if (node.includes(sentinel) || bun.includes(sentinel)) {
      throw new PackageSmokeError('resolver probe output leaked private input')
    }
  }
}

async function runResolverCommand(
  command: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const child = Bun.spawn([...command], {
    cwd,
    env: environment,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0 || stderr !== '') {
    throw new PackageSmokeError('resolver privacy probe failed')
  }
  return stdout.trim()
}

function hostTarget(): NativeTarget {
  const value = `${process.platform}-${process.arch}`
  if (!NATIVE_TARGETS.includes(value as NativeTarget)) {
    throw new PackageSmokeError('package smoke host is unsupported')
  }
  return value as NativeTarget
}

function verifyHostCompatibility(manifest: NativeResolverManifest): void {
  const target = hostTarget()
  const compatibility = manifest.targets[target].compatibility
  if (target.startsWith('darwin-') && compatibility.os !== 'darwin') {
    throw new PackageSmokeError('host target lacks Darwin compatibility')
  }
  if (!target.startsWith('linux-')) return
  if (compatibility.os !== 'linux' || compatibility.libc !== 'none') {
    throw new PackageSmokeError('host target is not the accepted static Linux artifact')
  }
}

async function verifyRelocatedInstall(packageRoot: string): Promise<void> {
  const [installed, source] = await Promise.all([realpath(packageRoot), realpath(projectRoot)])
  if (installed === source || installed.startsWith(`${source}/`)) {
    throw new PackageSmokeError('package smoke did not use its relocated install')
  }
}

async function verifyInstalledPackage(root: string, workspace: string): Promise<void> {
  const packageRoot = join(root, 'node_modules/ghostty-webgpu')
  const manifest = await verifyPackagedFiles(packageRoot)
  verifyHostCompatibility(manifest)
  await verifyRelocatedInstall(packageRoot)
  await verifyTypes(root)
  await verifyRootIsolation(root, packageRoot)
  await verifyBrowserConditions(root)
  await verifyHostExportShape(packageRoot)
  await verifyResolverRuntime(root, workspace)
}

async function verifyInstalledBrowserPackage(root: string, tarball: string): Promise<void> {
  const packageRoot = join(root, 'node_modules/ghostty-webgpu')
  await verifyBrowserFiles(packageRoot)
  await verifyRelocatedInstall(packageRoot)
  await verifyTypes(root)
  await verifyRootIsolation(root, packageRoot)
  const javascript = await verifyBrowserConditions(root)
  await verifyHostExportShape(packageRoot)
  await rejectPath(join(root, 'node_modules/ghostty-web'))
  await recordBrowserMeasurements(root, packageRoot, tarball, javascript)
  await run(['bun', join(projectRoot, 'scripts/renderer-fallback-smoke.ts'), 'canvas2d'], root, {
    env: { ...process.env, GHOSTTY_PACKAGE_ROOT: packageRoot },
  })
  console.log(
    'Packed browser imports, types, bundling, WASM and Canvas2D presentation verified; native artifacts were not qualified',
  )
}

async function recordBrowserMeasurements(
  root: string,
  packageRoot: string,
  tarball: string,
  javascript: ReturnType<typeof transferBytes>,
): Promise<void> {
  const wasm = []
  for (const file of ['ghostty-vt.wasm', 'bridge.wasm']) {
    wasm.push({
      file,
      ...transferBytes(new Uint8Array(await Bun.file(join(packageRoot, file)).arrayBuffer())),
    })
  }
  const nativeRoot = join(packageRoot, 'native')
  const nativeExists = existsSync(nativeRoot)
  const evidence = {
    tarball: {
      bytes: Bun.file(tarball).size,
      sha256: createHash('sha256')
        .update(new Uint8Array(await Bun.file(tarball).arrayBuffer()))
        .digest('hex'),
    },
    installed: {
      packageBytes: await installedBytes(packageRoot),
      includingDependenciesBytes: await installedBytes(join(root, 'node_modules')),
      optionalNativeBytes: nativeExists ? await installedBytes(nativeRoot) : 0,
    },
    transfer: {
      javascript,
      wasm,
      method:
        'Unminified Bun browser bundle of native and compatibility constructors; each WASM asset compressed separately. CSS and HTTP overhead excluded.',
    },
    nativeQualification: 'not performed',
  }
  const output = join(projectRoot, '.artifacts/package-browser.json')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
  console.log(`Package measurements: ${output}`)
}

async function suppliedTarball(argv: readonly string[]): Promise<string | undefined> {
  if (argv.length === 0) return undefined
  if (argv.length !== 2 || argv[0] !== '--tarball' || !argv[1]) {
    throw new PackageSmokeError(
      'usage: bun scripts/package-smoke.ts [--tarball /absolute/file.tgz]',
    )
  }
  if (!isAbsolute(argv[1])) throw new PackageSmokeError('--tarball must be an absolute path')
  return argv[1]
}

async function createTarball(workspace: string): Promise<string> {
  const packRoot = join(workspace, 'pack')
  await mkdir(packRoot)
  const packOutput = await run(
    ['npm', 'pack', '--silent', '--dry-run=false', '--pack-destination', packRoot],
    projectRoot,
  )
  return join(packRoot, readPackFilename(packOutput))
}

async function main(): Promise<void> {
  const browserOnly = process.argv[2] === '--browser'
  const input = await suppliedTarball(process.argv.slice(browserOnly ? 3 : 2))
  const snapshot = input ? openFileSnapshot(input, maximumTarballBytes) : undefined
  let workspace: string | undefined
  let failure: unknown
  let verified = ''
  try {
    workspace = await mkdtemp(join(tmpdir(), 'ghostty-webgpu-package-'))
    const consumerRoot = join(workspace, 'consumer')
    await mkdir(consumerRoot)
    await writeConsumerFiles(consumerRoot, browserOnly)
    const tarball = input ?? (await createTarball(workspace))
    await run(
      ['npm', 'install', '--dry-run=false', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      consumerRoot,
    )
    if (browserOnly) await verifyInstalledBrowserPackage(consumerRoot, tarball)
    if (!browserOnly) await verifyInstalledPackage(consumerRoot, workspace)
    verified = input ? snapshot!.sha256 : (tarball.split('/').at(-1) ?? '')
  } catch (error) {
    failure = error
  } finally {
    if (snapshot) {
      try {
        assertOpenFileUnchanged(snapshot, maximumTarballBytes)
      } catch (error) {
        failure = error
      } finally {
        closeSync(snapshot.descriptor)
      }
    }
    if (workspace) await rm(workspace, { force: true, recursive: true })
  }
  if (failure) throw failure
  console.log(`Verified packed consumer ${verified}`)
}

await main()
