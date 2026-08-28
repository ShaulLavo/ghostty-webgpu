import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const
const UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f'
const OUTPUT_LIMIT = 128 * 1024
const SENTINELS = [
  'PLAN065_PATH_SENTINEL',
  'PLAN065_SECRET_SENTINEL',
  'PLAN065_THEME_SENTINEL',
  'PLAN065_DIAGNOSTIC_SENTINEL',
] as const
const PALETTE_SHA256 = '3924d9bb39f6716d63524fb520f2100c5e93c52708967ecf5bc7e648cab0fa65'
const scriptDir = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(scriptDir, 'fixtures')

type Target = (typeof TARGETS)[number]
type JsonObject = Record<string, unknown>
type Rgb = { readonly r: number; readonly g: number; readonly b: number }
type Matrix = readonly (readonly [number, number, number])[]
type ProofColor =
  | { readonly kind: 'unset' }
  | { readonly kind: 'rgb'; readonly value: Rgb }
  | { readonly kind: 'cell-foreground' }
  | { readonly kind: 'cell-background' }
type ProofProfile = {
  readonly background: Rgb
  readonly foreground: Rgb
  readonly cursorColor: ProofColor
  readonly cursorText: ProofColor
  readonly selectionBackground: ProofColor
  readonly selectionForeground: ProofColor
  readonly minimumContrast: number
  readonly palette: readonly Rgb[]
  readonly windowColorspace: 'display-p3' | 'srgb'
  readonly surface: {
    readonly backgroundOpacity: number
    readonly backgroundOpacityCells: boolean
    readonly backgroundBlur:
      | { readonly kind: 'none' }
      | { readonly kind: 'radius'; readonly value: number }
      | { readonly kind: 'macos-glass'; readonly variant: 'clear' | 'regular' }
  }
}
type ProofResult =
  | {
      readonly proofSchemaVersion: 1
      readonly status: 'ready'
      readonly upstreamRevision: string
      readonly diagnosticCount: number
      readonly profiles: { readonly light: ProofProfile; readonly dark: ProofProfile }
    }
  | {
      readonly proofSchemaVersion: 1
      readonly status: 'not-configured' | 'resolver-error'
      readonly upstreamRevision: string
    }
type Arguments = {
  readonly helper: string
  readonly resources: string
  readonly target: Target
  readonly evidence: string
}
type FixtureRoot = {
  readonly path: string
  readonly home: string
  readonly config: string
  readonly cache: string
  readonly temporary: string
}
type DefaultLocation = {
  readonly id: 'app-current' | 'app-legacy' | 'xdg-current' | 'xdg-legacy'
  readonly path: string
  readonly fixture: string
  readonly expected: Rgb
}

class ProofFailure extends Error {}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  assertNativeTarget(args.target)
  verifyDisplayP3Vectors()

  const workRoot = mkdtempSync(join(tmpdir(), 'plan-065-verify-'))
  try {
    const bundle = relocateBundle(workRoot, args.helper, args.resources)
    inspectDependencies(bundle.helper, args.target)
    await runFixtures(workRoot, bundle.helper, bundle.resources, args.target)
    writeEvidence(args, bundle.helper)
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }

  process.stdout.write(`${JSON.stringify({ target: args.target, result: 'pass' })}\n`)
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new ProofFailure('invalid arguments')
    values.set(name, value)
  }

  const helper = values.get('--helper')
  const resources = values.get('--resources')
  const target = values.get('--target')
  const evidence = values.get('--evidence')
  if (!helper || !resources || !target || !evidence) throw new ProofFailure('missing argument')
  if (!TARGETS.includes(target as Target)) throw new ProofFailure('unsupported target')

  return {
    helper: realpathSync(helper),
    resources: realpathSync(resources),
    target: target as Target,
    evidence,
  }
}

function assertNativeTarget(target: Target): void {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
  if (`${os}-${arch}` !== target) throw new ProofFailure('native target mismatch')
}

function relocateBundle(
  workRoot: string,
  helperSource: string,
  resourceSource: string,
): { readonly helper: string; readonly resources: string } {
  const root = join(workRoot, 'relocated', 'nested', 'bundle')
  const helper = join(root, 'bin', 'ghostty-config-resolver-proof')
  const resources = join(root, 'resources')
  mkdirSync(dirname(helper), { recursive: true })
  copyFileSync(helperSource, helper)
  chmodSync(helper, 0o755)
  cpSync(resourceSource, resources, { recursive: true })
  return { helper, resources }
}

function inspectDependencies(helper: string, target: Target): void {
  if (target.startsWith('linux-')) {
    const result = spawnSync('readelf', ['-d', helper], fixedProcessOptions())
    if (result.status !== 0) throw new ProofFailure('readelf failed')
    if (result.stdout.includes('(NEEDED)')) throw new ProofFailure('Linux helper is dynamic')
    return
  }

  const result = spawnSync('otool', ['-L', helper], fixedProcessOptions())
  if (result.status !== 0) throw new ProofFailure('otool failed')
  const dependencies = result.stdout.trim().split('\n').slice(1)
  if (dependencies.some((line) => line.includes('@rpath') || line.includes('@loader_path'))) {
    throw new ProofFailure('Darwin helper has an unbundled dependency')
  }
}

async function runFixtures(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): Promise<void> {
  testAbsent(workRoot, helper, resources, target)
  testNormalSearch(workRoot, helper, resources, target)
  testIncludeGraph(workRoot, helper, resources, target)
  testDualProfile(workRoot, helper, resources, target)
  testVisualProjection(workRoot, helper, resources, target)
  testFileTheme(workRoot, helper, resources, target)
  testSurfaceVariants(workRoot, helper, resources, target)
  await testRaces(workRoot, helper, resources, target)
}

function testAbsent(workRoot: string, helper: string, resources: string, target: Target): void {
  const root = createFixtureRoot(workRoot, target)
  const before = snapshotRoots(root)
  const result = runHelper(helper, resources, root)
  const after = snapshotRoots(root)
  if (result.status !== 'not-configured') throw new ProofFailure('absent status mismatch')
  if (before !== after) throw new ProofFailure('absent roots changed')
}

function testNormalSearch(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const firstRoot = createFixtureRoot(workRoot, target)
  const locations = defaultLocations(firstRoot, target)
  for (const location of locations) {
    const root = createFixtureRoot(workRoot, target)
    const current = defaultLocations(root, target).find((item) => item.id === location.id)
    if (!current) throw new ProofFailure('location mapping failed')
    installFile(current.fixture, current.path)
    const profile = ready(runHelper(helper, resources, root)).profiles.light
    assertRgb(profile.background, current.expected, 'single default location')
  }

  const xdgRoot = createFixtureRoot(workRoot, target)
  const xdg = defaultLocations(xdgRoot, target).filter((item) => item.id.startsWith('xdg-'))
  for (const location of xdg) installFile(location.fixture, location.path)
  assertRgb(
    ready(runHelper(helper, resources, xdgRoot)).profiles.light.background,
    rgb(34, 34, 34),
    'XDG precedence',
  )

  if (!target.startsWith('darwin-')) return
  const allRoot = createFixtureRoot(workRoot, target)
  for (const location of defaultLocations(allRoot, target)) {
    installFile(location.fixture, location.path)
  }
  assertRgb(
    ready(runHelper(helper, resources, allRoot)).profiles.light.background,
    rgb(68, 68, 68),
    'macOS precedence',
  )
}

function testIncludeGraph(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const root = createFixtureRoot(workRoot, target)
  installTree(join(fixtureDir, 'include-graph'), currentXdgPath(root))
  const result = ready(runHelper(helper, resources, root))
  if (result.diagnosticCount !== 3) throw new ProofFailure('diagnostic count mismatch')
  assertRgb(result.profiles.light.background, rgb(85, 85, 85), 'include order')
  assertRgb(result.profiles.light.foreground, rgb(1, 2, 3), 'include reset')
}

function testDualProfile(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const root = createFixtureRoot(workRoot, target)
  installTree(join(fixtureDir, 'dual-profile'), currentXdgPath(root))
  const result = ready(runHelper(helper, resources, root))
  const { light, dark } = result.profiles
  assertRgb(light.background, rgb(247, 247, 247), 'light background')
  assertRgb(light.foreground, rgb(74, 69, 67), 'light foreground')
  assertRgb(colorRgb(light.cursorText), rgb(247, 247, 247), 'light cursor text')
  assertRgb(light.palette[0]!, rgb(9, 3, 0), 'light palette zero')
  assertRgb(light.palette[15]!, rgb(247, 247, 247), 'light palette fifteen')
  assertRgb(dark.background, rgb(33, 33, 33), 'dark background')
  assertRgb(dark.foreground, rgb(208, 208, 208), 'dark foreground')
  assertRgb(colorRgb(dark.cursorText), rgb(21, 21, 21), 'dark cursor text')
  assertRgb(dark.palette[0]!, rgb(21, 21, 21), 'dark palette zero')
  assertRgb(dark.palette[6]!, rgb(125, 214, 207), 'dark palette six')
  if (light.palette.length !== 256 || dark.palette.length !== 256) {
    throw new ProofFailure('dual palette length mismatch')
  }
  assertSurface(light, 0.9, false, { kind: 'radius', value: 20 })
  assertSurface(dark, 0.9, false, { kind: 'radius', value: 20 })
}

function testVisualProjection(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const root = createFixtureRoot(workRoot, target)
  installTree(join(fixtureDir, 'visual'), currentXdgPath(root))
  const result = ready(runHelper(helper, resources, root))
  const { light, dark } = result.profiles
  if (JSON.stringify(light) !== JSON.stringify(dark)) {
    throw new ProofFailure('null conditional clone mismatch')
  }
  assertRgb(light.background, rgb(16, 32, 48), 'explicit background')
  assertRgb(light.foreground, rgb(255, 215, 0), 'named foreground')
  assertColorKind(light.cursorColor, 'cell-foreground')
  assertColorKind(light.cursorText, 'cell-background')
  assertColorKind(light.selectionBackground, 'cell-foreground')
  assertColorKind(light.selectionForeground, 'cell-background')
  if (light.minimumContrast !== 4.5) throw new ProofFailure('minimum contrast mismatch')
  if (light.windowColorspace !== 'display-p3') throw new ProofFailure('colorspace mismatch')
  assertSurface(light, 0.75, true, { kind: 'radius', value: 20 })
  assertRgb(light.palette[1]!, rgb(1, 2, 3), 'explicit palette one')
  assertRgb(light.palette[42]!, rgb(18, 52, 86), 'explicit palette forty-two')
  if (paletteSha256(light.palette) !== PALETTE_SHA256) {
    throw new ProofFailure('generated palette mismatch')
  }
}

function testFileTheme(workRoot: string, helper: string, resources: string, target: Target): void {
  const root = createFixtureRoot(workRoot, target)
  installTree(join(fixtureDir, 'file-theme'), currentXdgPath(root))
  const themeSource = join(fixtureDir, 'file-theme', 'themes', 'PLAN065_THEME_SENTINEL')
  const themeTarget = join(root.config, 'ghostty', 'themes', 'PLAN065_THEME_SENTINEL')
  installFile(themeSource, themeTarget)
  const profile = ready(runHelper(helper, resources, root)).profiles.light
  assertRgb(profile.background, rgb(18, 58, 188), 'file theme background')
  assertRgb(profile.foreground, rgb(254, 220, 186), 'file theme foreground')
  assertColorKind(profile.cursorText, 'cell-background')
}

function testSurfaceVariants(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): void {
  const vectors = [
    ['macos-glass-clear.ghostty', { kind: 'macos-glass', variant: 'clear' }],
    ['macos-glass-regular.ghostty', { kind: 'macos-glass', variant: 'regular' }],
    ['no-blur.ghostty', { kind: 'none' }],
  ] as const

  for (const [fixture, expected] of vectors) {
    const root = createFixtureRoot(workRoot, target)
    installFile(join(fixtureDir, 'surface', fixture), currentXdgPath(root))
    const profile = ready(runHelper(helper, resources, root)).profiles.light
    if (JSON.stringify(profile.surface.backgroundBlur) !== JSON.stringify(expected)) {
      throw new ProofFailure('surface variant mismatch')
    }
  }
}

async function testRaces(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
): Promise<void> {
  const root = createFixtureRoot(workRoot, target)
  const locations = defaultLocations(root, target)
  for (const location of locations) {
    await runRace(workRoot, helper, resources, target, location.id, 'delete')
    await runRace(workRoot, helper, resources, target, location.id, 'rename')
  }
}

async function runRace(
  workRoot: string,
  helper: string,
  resources: string,
  target: Target,
  locationId: DefaultLocation['id'],
  action: 'delete' | 'rename',
): Promise<void> {
  const root = createFixtureRoot(workRoot, target)
  const location = defaultLocations(root, target).find((item) => item.id === locationId)
  if (!location) throw new ProofFailure('race location missing')
  installFile(location.fixture, location.path)

  const child = spawn(helper, ['--proof-pause-after-discovery'], {
    cwd: root.path,
    env: helperEnvironment(root, resources),
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  })
  const output: Buffer[] = []
  const errors: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk))
  const closed = waitForClose(child)
  await waitForReady(child.stdio[3] as Readable | null)

  if (action === 'delete') rmSync(location.path)
  if (action === 'rename') renameSync(location.path, join(root.path, 'removed-config'))
  const before = snapshotRoots(root)
  ;(child.stdio[4] as Writable | null)?.end('1')
  const code = await closed
  if (code !== 0) throw new ProofFailure('race helper failed')

  const stdout = Buffer.concat(output)
  const stderr = Buffer.concat(errors)
  const result = parseOutput(stdout, stderr)
  if (result.status !== 'not-configured') throw new ProofFailure('race status mismatch')
  if (before !== snapshotRoots(root)) throw new ProofFailure('race roots changed')
}

function createFixtureRoot(workRoot: string, _target: Target): FixtureRoot {
  const path = mkdtempSync(join(workRoot, 'fixture-'))
  const root = {
    path,
    home: join(path, 'home'),
    config: join(path, 'config'),
    cache: join(path, 'cache'),
    temporary: join(path, 'tmp'),
  }
  for (const directory of [root.home, root.config, root.cache, root.temporary]) {
    mkdirSync(directory, { recursive: true })
  }
  return root
}

function defaultLocations(root: FixtureRoot, target: Target): readonly DefaultLocation[] {
  const locations: DefaultLocation[] = [
    {
      id: 'xdg-legacy',
      path: join(root.config, 'ghostty', 'config'),
      fixture: join(fixtureDir, 'precedence', 'xdg-legacy.ghostty'),
      expected: rgb(17, 17, 17),
    },
    {
      id: 'xdg-current',
      path: join(root.config, 'ghostty', 'config.ghostty'),
      fixture: join(fixtureDir, 'precedence', 'xdg-current.ghostty'),
      expected: rgb(34, 34, 34),
    },
  ]
  if (!target.startsWith('darwin-')) return locations

  const appSupport = join(root.home, 'Library', 'Application Support', 'com.mitchellh.ghostty')
  locations.push(
    {
      id: 'app-legacy',
      path: join(appSupport, 'config'),
      fixture: join(fixtureDir, 'precedence', 'app-legacy.ghostty'),
      expected: rgb(51, 51, 51),
    },
    {
      id: 'app-current',
      path: join(appSupport, 'config.ghostty'),
      fixture: join(fixtureDir, 'precedence', 'app-current.ghostty'),
      expected: rgb(68, 68, 68),
    },
  )
  return locations
}

function currentXdgPath(root: FixtureRoot): string {
  return join(root.config, 'ghostty', 'config.ghostty')
}

function installTree(source: string, configTarget: string): void {
  const targetDir = dirname(configTarget)
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(source)) {
    if (entry === 'themes') continue
    cpSync(join(source, entry), join(targetDir, entry), { recursive: true })
  }
}

function installFile(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
}

function runHelper(helper: string, resources: string, root: FixtureRoot): ProofResult {
  const result = spawnSync(helper, [], {
    cwd: root.path,
    env: helperEnvironment(root, resources),
    encoding: 'buffer',
    maxBuffer: OUTPUT_LIMIT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
  if (result.status !== 0) throw new ProofFailure('helper failed')
  return parseOutput(result.stdout, result.stderr)
}

function helperEnvironment(root: FixtureRoot, resources: string): NodeJS.ProcessEnv {
  return {
    CFFIXED_USER_HOME: root.home,
    GHOSTTY_RESOURCES_DIR: resources,
    HOME: root.home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: root.temporary,
    XDG_CACHE_HOME: root.cache,
    XDG_CONFIG_HOME: root.config,
  }
}

function fixedProcessOptions(): {
  readonly encoding: 'utf8'
  readonly env: NodeJS.ProcessEnv
  readonly maxBuffer: number
} {
  return {
    encoding: 'utf8',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    maxBuffer: OUTPUT_LIMIT,
  }
}

function parseOutput(stdout: Buffer, stderr: Buffer): ProofResult {
  if (stderr.length !== 0) throw new ProofFailure('helper wrote stderr')
  if (stdout.length === 0 || stdout.length > OUTPUT_LIMIT) {
    throw new ProofFailure('helper stdout length mismatch')
  }
  assertNoSentinel(stdout, stderr)

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.toString('utf8'))
  } catch {
    throw new ProofFailure('helper output is not JSON')
  }
  return validateResult(parsed)
}

function validateResult(value: unknown): ProofResult {
  const result = asObject(value, 'result')
  if (result.proofSchemaVersion !== 1) throw new ProofFailure('schema version mismatch')
  if (result.upstreamRevision !== UPSTREAM_REVISION) throw new ProofFailure('revision mismatch')
  if (result.status === 'not-configured' || result.status === 'resolver-error') {
    assertKeys(result, ['proofSchemaVersion', 'status', 'upstreamRevision'], 'unavailable result')
    return result as ProofResult
  }
  if (result.status !== 'ready') throw new ProofFailure('status mismatch')
  assertKeys(
    result,
    ['diagnosticCount', 'profiles', 'proofSchemaVersion', 'status', 'upstreamRevision'],
    'ready result',
  )
  assertInteger(result.diagnosticCount, 0, 65_535, 'diagnostic count')
  const profiles = asObject(result.profiles, 'profiles')
  assertKeys(profiles, ['dark', 'light'], 'profiles')
  validateProfile(profiles.light)
  validateProfile(profiles.dark)
  return result as ProofResult
}

function validateProfile(value: unknown): ProofProfile {
  const profile = asObject(value, 'profile')
  assertKeys(
    profile,
    [
      'background',
      'cursorColor',
      'cursorText',
      'foreground',
      'minimumContrast',
      'palette',
      'selectionBackground',
      'selectionForeground',
      'surface',
      'windowColorspace',
    ],
    'profile',
  )
  validateRgb(profile.background)
  validateRgb(profile.foreground)
  validateColor(profile.cursorColor)
  validateColor(profile.cursorText)
  validateColor(profile.selectionBackground)
  validateColor(profile.selectionForeground)
  assertFinite(profile.minimumContrast, 1, 21, 'minimum contrast')
  if (!Array.isArray(profile.palette) || profile.palette.length !== 256) {
    throw new ProofFailure('palette length mismatch')
  }
  for (const color of profile.palette) validateRgb(color)
  if (profile.windowColorspace !== 'srgb' && profile.windowColorspace !== 'display-p3') {
    throw new ProofFailure('window colorspace mismatch')
  }
  validateSurface(profile.surface)
  return profile as ProofProfile
}

function validateRgb(value: unknown): Rgb {
  const color = asObject(value, 'RGB')
  assertKeys(color, ['b', 'g', 'r'], 'RGB')
  for (const channel of ['r', 'g', 'b'] as const) {
    assertInteger(color[channel], 0, 255, `RGB ${channel}`)
  }
  return color as Rgb
}

function validateColor(value: unknown): ProofColor {
  const color = asObject(value, 'color')
  if (color.kind === 'rgb') {
    assertKeys(color, ['kind', 'value'], 'RGB color')
    validateRgb(color.value)
    return color as ProofColor
  }
  assertKeys(color, ['kind'], 'dynamic color')
  if (!['unset', 'cell-foreground', 'cell-background'].includes(color.kind as string)) {
    throw new ProofFailure('color kind mismatch')
  }
  return color as ProofColor
}

function validateSurface(value: unknown): void {
  const surface = asObject(value, 'surface')
  assertKeys(surface, ['backgroundBlur', 'backgroundOpacity', 'backgroundOpacityCells'], 'surface')
  assertFinite(surface.backgroundOpacity, 0, 1, 'background opacity')
  if (typeof surface.backgroundOpacityCells !== 'boolean') {
    throw new ProofFailure('background opacity cells mismatch')
  }
  const blur = asObject(surface.backgroundBlur, 'background blur')
  if (blur.kind === 'none') {
    assertKeys(blur, ['kind'], 'none blur')
    return
  }
  if (blur.kind === 'radius') {
    assertKeys(blur, ['kind', 'value'], 'radius blur')
    assertInteger(blur.value, 0, 255, 'blur radius')
    return
  }
  if (blur.kind !== 'macos-glass') throw new ProofFailure('blur kind mismatch')
  assertKeys(blur, ['kind', 'variant'], 'glass blur')
  if (blur.variant !== 'clear' && blur.variant !== 'regular') {
    throw new ProofFailure('glass variant mismatch')
  }
}

function ready(result: ProofResult): Extract<ProofResult, { readonly status: 'ready' }> {
  if (result.status !== 'ready') throw new ProofFailure('ready result required')
  return result
}

function colorRgb(color: ProofColor): Rgb {
  if (color.kind !== 'rgb') throw new ProofFailure('static color required')
  return color.value
}

function assertColorKind(color: ProofColor, expected: ProofColor['kind']): void {
  if (color.kind !== expected) throw new ProofFailure('dynamic color mismatch')
}

function assertSurface(
  profile: ProofProfile,
  opacity: number,
  cells: boolean,
  blur: ProofProfile['surface']['backgroundBlur'],
): void {
  if (profile.surface.backgroundOpacity !== opacity) throw new ProofFailure('opacity mismatch')
  if (profile.surface.backgroundOpacityCells !== cells) {
    throw new ProofFailure('cell opacity mismatch')
  }
  if (JSON.stringify(profile.surface.backgroundBlur) !== JSON.stringify(blur)) {
    throw new ProofFailure('blur mismatch')
  }
}

function assertRgb(actual: Rgb, expected: Rgb, label: string): void {
  if (actual.r !== expected.r || actual.g !== expected.g || actual.b !== expected.b) {
    throw new ProofFailure(`${label} RGB mismatch`)
  }
}

function paletteSha256(palette: readonly Rgb[]): string {
  const bytes = Buffer.from(palette.flatMap((color) => [color.r, color.g, color.b]))
  return createHash('sha256').update(bytes).digest('hex')
}

function verifyDisplayP3Vectors(): void {
  const vectors = [
    { input: rgb(0, 0, 0), expected: rgb(0, 0, 0) },
    { input: rgb(255, 255, 255), expected: rgb(255, 255, 255) },
    { input: rgb(255, 0, 0), expected: rgb(255, 0, 0) },
    { input: rgb(0, 255, 0), expected: rgb(0, 255, 0) },
    { input: rgb(0, 0, 255), expected: rgb(0, 0, 255) },
    { input: rgb(128, 128, 128), expected: rgb(128, 128, 128) },
    { input: rgb(10, 10, 10), expected: rgb(10, 10, 10) },
    { input: rgb(11, 11, 11), expected: rgb(11, 11, 11) },
    { input: rgb(111, 85, 28), expected: rgb(116, 84, 8) },
  ] as const

  for (const vector of vectors) {
    const actual = displayP3ToSrgb(vector.input)
    if (!sameRgb(actual, vector.expected)) throw new ProofFailure('Display-P3 vector mismatch')
  }

  const below = convertDisplayP3Raw(rgb(42, 35, 42))[2]!
  const above = convertDisplayP3Raw(rgb(198, 135, 238))[2]!
  if (!(below < 42.5 && below > 42.4999)) {
    throw new ProofFailure('lower rounding vector mismatch')
  }
  if (!(above > 244.5 && above < 244.5001)) {
    throw new ProofFailure('upper rounding vector mismatch')
  }
}

function displayP3ToSrgb(input: Rgb): Rgb {
  const encoded = convertDisplayP3Raw(input)
  return rgb(roundHalfUp(encoded[0]!), roundHalfUp(encoded[1]!), roundHalfUp(encoded[2]!))
}

function convertDisplayP3Raw(input: Rgb): readonly number[] {
  const p3ToXyz = [
    [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
    [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
    [0, 0.04511338185890264, 1.043944368900976],
  ] as const
  const xyzToSrgb = [
    [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
    [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
    [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
  ] as const
  const linearP3 = [input.r, input.g, input.b].map((channel) => decodeColor(channel / 255))
  const xyz = multiplyMatrix(p3ToXyz, linearP3)
  const linearSrgb = multiplyMatrix(xyzToSrgb, xyz)
  return linearSrgb.map((channel) => encodeColor(clampColor(channel)) * 255)
}

function multiplyMatrix(matrix: Matrix, vector: readonly number[]): readonly number[] {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index]!, 0))
}

function decodeColor(channel: number): number {
  if (channel <= 0.04045) return channel / 12.92
  return ((channel + 0.055) / 1.055) ** 2.4
}

function encodeColor(channel: number): number {
  if (channel <= 0.0031308) return 12.92 * channel
  return 1.055 * channel ** (1 / 2.4) - 0.055
}

function clampColor(channel: number): number {
  return Math.max(0, Math.min(1, channel))
}

function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5)
}

function sameRgb(left: Rgb, right: Rgb): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b
}

function snapshotRoots(root: FixtureRoot): string {
  const records: string[] = []
  walkSnapshot(root.home, 'home', records)
  walkSnapshot(root.config, 'config', records)
  return createHash('sha256').update(records.join('\n')).digest('hex')
}

function walkSnapshot(path: string, label: string, records: string[]): void {
  const stat = lstatSync(path)
  const mode = (stat.mode & 0o777).toString(8)
  if (stat.isSymbolicLink()) {
    records.push(`${label}\0l\0${mode}\0${readlinkSync(path)}`)
    return
  }
  if (stat.isFile()) {
    records.push(`${label}\0f\0${mode}\0${sha256(readFileSync(path))}`)
    return
  }
  if (!stat.isDirectory()) throw new ProofFailure('unsupported fixture entry')
  records.push(`${label}\0d\0${mode}`)
  const entries = readdirSync(path).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )
  for (const entry of entries) walkSnapshot(join(path, entry), `${label}/${entry}`, records)
}

function waitForReady(stream: Readable | null): Promise<void> {
  if (!stream) return Promise.reject(new ProofFailure('race ready pipe missing'))
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new ProofFailure('race ready timeout')), 30_000)
    stream.once('data', (chunk: Buffer) => {
      clearTimeout(timeout)
      if (chunk.length !== 1 || chunk[0] !== 0x31) {
        reject(new ProofFailure('race ready signal mismatch'))
        return
      }
      resolve()
    })
    stream.once('error', () => {
      clearTimeout(timeout)
      reject(new ProofFailure('race ready pipe failed'))
    })
  })
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new ProofFailure('race helper timeout'))
    }, 30_000)
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new ProofFailure('race helper spawn failed'))
    })
  })
}

function assertNoSentinel(...values: readonly Buffer[]): void {
  for (const value of values) {
    const text = value.toString('utf8')
    if (SENTINELS.some((sentinel) => text.includes(sentinel))) {
      throw new ProofFailure('sentinel leaked')
    }
  }
}

function writeEvidence(args: Arguments, helper: string): void {
  const artifact = readFileSync(helper)
  const evidence = {
    schemaVersion: 1,
    target: args.target,
    nativeExecution: 'pass',
    artifactSha256: sha256(artifact),
    artifactBytes: statSync(helper).size,
    semanticFixtures: 'pass',
    noWriteFixtures: 'pass',
    dependencies: 'pass',
    compatibilityProbe: args.target.startsWith('linux-') ? 'pass-static' : 'pass-system-only',
    relocation: 'pass',
    displayP3Vectors: 'pass',
  } as const
  writeFileSync(args.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProofFailure(`${label} must be an object`)
  }
  return value as JsonObject
}

function assertKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new ProofFailure(`${label} keys mismatch`)
  }
}

function assertInteger(value: unknown, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProofFailure(`${label} must be a bounded integer`)
  }
}

function assertFinite(value: unknown, minimum: number, maximum: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ProofFailure(`${label} must be a bounded number`)
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function rgb(r: number, g: number, b: number): Rgb {
  return { r, g, b }
}

try {
  await main()
} catch (error) {
  const reason = error instanceof ProofFailure ? error.message : 'unexpected proof failure'
  process.stdout.write(`${JSON.stringify({ result: 'fail', reason })}\n`)
  process.exitCode = 1
}
