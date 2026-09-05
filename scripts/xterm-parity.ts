import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/async'
import {
  readXtermManifest,
  type XtermAddonManifest,
  type XtermReferenceManifest,
} from './xterm-reference.js'

export const parityStatuses = [
  'missing',
  'partial',
  'compatible',
  'blocked',
  'not-applicable',
] as const

export type XtermParityStatus = (typeof parityStatuses)[number]

export interface XtermParityRow {
  readonly area: string
  readonly behavior: string
  readonly evidence: readonly string[]
  readonly id: string
  readonly implementationPath: string | null
  readonly notes: string
  readonly ownerPlan: string
  readonly package: string
  readonly referenceCommit: string
  readonly referencePath: string
  readonly symbol: string
  readonly targetStatus: XtermParityStatus
}

export interface XtermParityLedger {
  readonly baseline: {
    readonly releaseCommit: string
    readonly releaseVersion: string
    readonly sourceCommit: string
    readonly sourceUrl: string
  }
  readonly inventory: {
    readonly api: number
    readonly css: number
    readonly forwardDrift: number
    readonly manual: number
    readonly packages: number
    readonly total: number
  }
  readonly rows: readonly XtermParityRow[]
  readonly schemaVersion: 1
}

interface DeclarationSource {
  readonly commit: string
  readonly logicalPath: string
  readonly moduleName: string
  readonly packageName: string
  readonly path: string
}

interface DeclarationCandidate {
  readonly behavior: string
  readonly kind: string
  readonly symbol: string
}

interface DeclarationInventory {
  readonly candidates: readonly DeclarationCandidate[]
  readonly source: DeclarationSource
}

export interface XtermCssInventory {
  readonly classes: readonly string[]
  readonly ruleGroups: readonly string[]
  readonly selectors: readonly string[]
}

interface GeneratedRow extends XtermParityRow {
  readonly inventoryKind: keyof Omit<XtermParityLedger['inventory'], 'total'>
}

interface RowDisposition {
  readonly evidence: readonly string[]
  readonly implementationPath: string | null
  readonly notes: string
  readonly ownerPlan: string
  readonly targetStatus: XtermParityStatus
}

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const ledgerJsonPath = 'docs/xterm-parity.json'
const ledgerMarkdownPath = 'docs/xterm-parity.md'
const statusSet = new Set<string>(parityStatuses)

const sectionOrder = [
  'Core constructor, lifecycle, options, and events',
  'Terminal methods and input',
  'Buffer, cell, modes, parser, and Unicode',
  'Selection, markers, decorations, links, and joiners',
  'DOM, CSS, accessibility, and browser support',
  'Official addons',
  'Headless',
  'Packaging and import compatibility',
  'VT behavior, performance, and manual gates',
] as const

export class XtermParityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XtermParityError'
  }
}

function normalizeText(value: string, limit = 420): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit - 1)}…`
}

function behaviorIdentity(value: string): string {
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//gu, '')
  return normalizeText(withoutComments, Number.POSITIVE_INFINITY)
}

function normalizeSignature(value: string): string {
  return normalizeText(value, Number.POSITIVE_INFINITY)
}

function publicDeclarationText(value: string): string {
  const declaration = normalizeSignature(value)
  return declaration.replace(/^(?:(?:declare|default|export)\s+)+/u, '')
}

function idPart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/gu, '-')
  return normalized.replace(/^-|-$/gu, '')
}

function semanticIdPart(value: string): string {
  return encodeURIComponent(value)
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10)
}

function declarationKind(node: ts.Node): string | undefined {
  if (ts.isClassDeclaration(node)) return 'class'
  if (ts.isInterfaceDeclaration(node)) return 'interface'
  if (ts.isTypeAliasDeclaration(node)) return 'type'
  if (ts.isEnumDeclaration(node)) return 'enum'
  if (ts.isFunctionDeclaration(node)) return 'function'
  if (ts.isVariableStatement(node)) return 'variable'
  return undefined
}

function namedDeclarationName(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    return node.name?.text
  }
  if (ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return node.name.text
  if (ts.isFunctionDeclaration(node)) return node.name?.text
  if (!('name' in node)) return undefined
  const name = (node as { readonly name?: ts.Node }).name
  if (!name) return undefined
  return normalizeText(name.getText(source))
}

function isPrivateOrProtected(node: ts.Node): boolean {
  if (!('modifiers' in node)) return false
  const modifiers = (node as { readonly modifiers?: readonly ts.ModifierLike[] }).modifiers ?? []
  return modifiers.some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  )
}

function memberName(member: ts.TypeElement | ts.ClassElement, source: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(member)) return 'constructor'
  if (ts.isIndexSignatureDeclaration(member)) return '[index]'
  if (ts.isCallSignatureDeclaration(member)) return '()'
  if (ts.isConstructSignatureDeclaration(member)) return 'new()'
  const name = namedDeclarationName(member, source)
  if (name) return name
  throw new XtermParityError(`Unsupported public member kind ${ts.SyntaxKind[member.kind]}`)
}

function typeParameters(
  node: ts.ClassDeclaration | ts.InterfaceDeclaration,
  source: ts.SourceFile,
): string {
  if (!node.typeParameters || node.typeParameters.length === 0) return ''
  return `<${node.typeParameters.map((parameter) => parameter.getText(source)).join(', ')}>`
}

function heritage(
  node: ts.ClassDeclaration | ts.InterfaceDeclaration,
  source: ts.SourceFile,
): string {
  if (!node.heritageClauses || node.heritageClauses.length === 0) return ''
  return ` ${node.heritageClauses.map((clause) => clause.getText(source)).join(' ')}`
}

function objectDeclarationBehavior(
  kind: string,
  symbol: string,
  node: ts.ClassDeclaration | ts.InterfaceDeclaration,
  source: ts.SourceFile,
): string {
  const abstract = node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword,
  )
    ? 'abstract '
    : ''
  return normalizeSignature(
    `Public ${abstract}${kind} ${symbol}${typeParameters(node, source)}${heritage(node, source)}`,
  )
}

function declarationBehavior(
  kind: string,
  symbol: string,
  node: ts.Node,
  source: ts.SourceFile,
): string {
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    return objectDeclarationBehavior(kind, symbol, node, source)
  }
  if (ts.isEnumDeclaration(node)) {
    const qualifier = node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ConstKeyword,
    )
      ? 'const '
      : ''
    return `Public ${qualifier}${kind} ${symbol}`
  }
  return `Public ${publicDeclarationText(node.getText(source))}`
}

function membersOf(node: ts.Node): readonly (ts.TypeElement | ts.ClassElement | ts.EnumMember)[] {
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) return node.members
  if (ts.isEnumDeclaration(node)) return node.members
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) return node.type.members
  return []
}

function variableCandidates(
  statement: ts.VariableStatement,
  source: ts.SourceFile,
): readonly DeclarationCandidate[] {
  return statement.declarationList.declarations.map((declaration) => {
    const symbol = declaration.name.getText(source)
    return {
      behavior: `Public variable ${normalizeSignature(declaration.getText(source))}`,
      kind: 'variable',
      symbol,
    }
  })
}

function declarationCandidates(
  statement: ts.Statement,
  source: ts.SourceFile,
): readonly DeclarationCandidate[] {
  if (ts.isVariableStatement(statement)) return variableCandidates(statement, source)
  const kind = declarationKind(statement)
  const symbol = namedDeclarationName(statement, source)
  if (!kind || !symbol) {
    throw new XtermParityError(
      `Unsupported public declaration kind ${ts.SyntaxKind[statement.kind]}`,
    )
  }
  const candidates: DeclarationCandidate[] = [
    { behavior: declarationBehavior(kind, symbol, statement, source), kind, symbol },
  ]
  for (const member of membersOf(statement)) {
    if (isPrivateOrProtected(member)) continue
    const childSymbol = `${symbol}.${memberName(member as ts.TypeElement | ts.ClassElement, source)}`
    candidates.push({
      behavior: normalizeSignature(member.getText(source)),
      kind: ts.isEnumMember(member) ? 'enum-member' : 'member',
      symbol: childSymbol,
    })
  }
  return candidates
}

function moduleStatements(source: ts.SourceFile, moduleName: string): readonly ts.Statement[] {
  for (const statement of source.statements) {
    if (!ts.isModuleDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.name) || statement.name.text !== moduleName) continue
    if (statement.body && ts.isModuleBlock(statement.body)) return statement.body.statements
  }
  throw new XtermParityError(`${source.fileName} does not declare module ${moduleName}`)
}

function requireSourceFile(sourceFile: ts.SourceFile | undefined, path: string): ts.SourceFile {
  if (sourceFile) return sourceFile
  throw new XtermParityError(`TypeScript did not parse ${path}`)
}

function disambiguateCandidates(
  candidates: readonly DeclarationCandidate[],
): readonly DeclarationCandidate[] {
  const groups = new Map<string, DeclarationCandidate[]>()
  const exact = new Set<string>()
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.symbol}`
    const exactKey = `${key}:${behaviorIdentity(candidate.behavior)}`
    if (exact.has(exactKey)) continue
    exact.add(exactKey)
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
  }
  const normalized: DeclarationCandidate[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      normalized.push(group[0]!)
      continue
    }
    for (const candidate of group) {
      const hash = createHash('sha256')
        .update(behaviorIdentity(candidate.behavior))
        .digest('hex')
        .slice(0, 12)
      normalized.push({ ...candidate, symbol: `${candidate.symbol}@${hash}` })
    }
  }
  return normalized
}

async function extractDeclarationInventories(
  sources: readonly DeclarationSource[],
): Promise<readonly DeclarationInventory[]> {
  const api = new API({ cwd: projectRoot })
  const snapshot = await api.updateSnapshot({ openFiles: sources.map((source) => source.path) })
  try {
    const inventories: DeclarationInventory[] = []
    for (const source of sources) {
      const project = await snapshot.getDefaultProjectForFile(source.path)
      const sourceFile = requireSourceFile(
        await project?.program.getSourceFile(source.path),
        source.path,
      )
      const candidates = moduleStatements(sourceFile, source.moduleName).flatMap((statement) =>
        declarationCandidates(statement, sourceFile),
      )
      inventories.push({ candidates: disambiguateCandidates(candidates), source })
    }
    return inventories
  } finally {
    await snapshot.dispose()
    await api.close()
  }
}

export async function extractDeclarationCandidates(
  source: DeclarationSource,
): Promise<readonly DeclarationCandidate[]> {
  const inventory = (await extractDeclarationInventories([source]))[0]
  if (inventory) return inventory.candidates
  throw new XtermParityError(`TypeScript did not inventory ${source.path}`)
}

function declarationSources(
  root: string,
  manifest: XtermReferenceManifest,
): readonly DeclarationSource[] {
  const release = manifest.release
  const sources: DeclarationSource[] = manifest.packages.map((entry) => ({
    commit: release.tagCommit,
    logicalPath: `npm:${entry.name}@${entry.version}/${entry.types}`,
    moduleName: entry.name,
    packageName: entry.name,
    path: join(root, 'node_modules', ...entry.name.split('/'), entry.types),
  }))
  for (const addon of manifest.addons) {
    sources.push({
      commit: addon.commit,
      logicalPath: `npm:${addon.name}@${addon.version}/${addon.types}`,
      moduleName: addon.name,
      packageName: addon.name,
      path: join(root, 'node_modules', ...addon.name.split('/'), addon.types),
    })
  }
  return sources
}

function memberBaseName(symbol: string): string {
  const withoutOverload = symbol.replace(/@[a-f0-9]{12}$/u, '')
  return withoutOverload.split('.').at(-1) ?? withoutOverload
}

function isBufferParserUnicode(symbol: string): boolean {
  return /(?:Buffer|Cell|Modes|Parser|Params|Unicode)/u.test(symbol)
}

function isSelectionLinkDecoration(symbol: string): boolean {
  return /(?:Selection|Marker|Decoration|Link|Joiner)/u.test(symbol)
}

function coreArea(symbol: string): string {
  if (isBufferParserUnicode(symbol)) return 'buffer-cell-modes-parser-unicode'
  if (isSelectionLinkDecoration(symbol)) return 'selection-markers-decorations-links-joiners'
  const name = memberBaseName(symbol)
  if (/^(?:write|writeln|input|paste|resize|reset|clear|scroll|focus|blur)/u.test(name)) {
    return 'terminal-methods-input'
  }
  return 'core-lifecycle-options-events'
}

function areaFor(packageName: string, symbol: string): string {
  if (packageName === '@xterm/headless') return 'headless'
  if (packageName.startsWith('@xterm/addon-')) return packageName.slice('@xterm/'.length)
  return coreArea(symbol)
}

function ownerForArea(area: string): string {
  if (area === 'headless' || area === 'packaging-imports') return '014'
  if (area === 'dom-css-accessibility-browser') return '010'
  if (area === 'buffer-cell-modes-parser-unicode') return '009'
  if (area === 'selection-markers-decorations-links-joiners') return '009'
  if (area === 'vt-performance-manual') return '015'
  if (/^addon-(?:attach|clipboard|fit|progress|web-links)$/u.test(area)) return '011'
  if (/^addon-(?:search|serialize|unicode-graphemes|unicode11)$/u.test(area)) return '012'
  if (/^addon-(?:image|ligatures|web-fonts|webgl)$/u.test(area)) return '013'
  return '008'
}

const partialCoreMembers = new Set([
  'blur',
  'clearSelection',
  'cols',
  'dispose',
  'focus',
  'getSelection',
  'hasSelection',
  'input',
  'onBell',
  'onData',
  'onResize',
  'onScroll',
  'onSelectionChange',
  'onTitleChange',
  'open',
  'paste',
  'registerLinkProvider',
  'reset',
  'resize',
  'rows',
  'scrollLines',
  'scrollToBottom',
  'scrollToLine',
  'scrollToTop',
  'selectAll',
  'write',
  'writeln',
])

function partialImplementation(area: string, symbol: string): RowDisposition | undefined {
  if (area === 'headless' || area.startsWith('addon-')) return undefined
  const name = memberBaseName(symbol)
  if (!partialCoreMembers.has(name)) return undefined
  if (area === 'selection-markers-decorations-links-joiners') {
    return {
      evidence: ['src/term/tests/session.test.ts', 'src/dom/tests/terminal-ui.browser.test.ts'],
      implementationPath: 'src/term/session.ts',
      notes:
        'Native selection or link behavior exists; xterm ordering, ranges, and facade semantics remain uncertified.',
      ownerPlan: '009',
      targetStatus: 'partial',
    }
  }
  if (name === 'open' || name === 'focus' || name === 'blur') {
    return {
      evidence: ['src/dom/tests/terminal-ui.browser.test.ts'],
      implementationPath: 'src/dom/terminal.ts',
      notes:
        'The native DOM host exists, but xterm construction, synchronous open, and retained-reference semantics differ.',
      ownerPlan: '008',
      targetStatus: 'partial',
    }
  }
  return {
    evidence: ['src/term/tests/session.test.ts'],
    implementationPath: 'src/term/session.ts',
    notes:
      'A native capability exists; xterm naming, defaults, callback ordering, and lifecycle semantics remain uncertified.',
    ownerPlan: ownerForArea(area),
    targetStatus: 'partial',
  }
}

function blockedDisposition(area: string, symbol: string): RowDisposition | undefined {
  if (area !== 'buffer-cell-modes-parser-unicode') return undefined
  if (!/(?:Buffer|Parser|Unicode)/u.test(symbol)) return undefined
  return {
    evidence: [],
    implementationPath: null,
    notes:
      'Blocked on authoritative libghostty-vt buffer, parser, or Unicode hooks; a visible-row shadow model is forbidden.',
    ownerPlan: '009',
    targetStatus: 'blocked',
  }
}

function defaultDisposition(area: string, symbol: string): RowDisposition {
  const blocked = blockedDisposition(area, symbol)
  if (blocked) return blocked
  const partial = partialImplementation(area, symbol)
  if (partial) return partial
  return {
    evidence: [],
    implementationPath: null,
    notes: '',
    ownerPlan: ownerForArea(area),
    targetStatus: 'missing',
  }
}

function apiRow(source: DeclarationSource, candidate: DeclarationCandidate): GeneratedRow {
  const area = areaFor(source.packageName, candidate.symbol)
  const disposition = defaultDisposition(area, candidate.symbol)
  return {
    ...disposition,
    area,
    behavior: candidate.behavior,
    id: `api:${semanticIdPart(source.packageName)}:${semanticIdPart(candidate.kind)}:${semanticIdPart(candidate.symbol)}`,
    inventoryKind: 'api',
    package: source.packageName,
    referenceCommit: source.commit,
    referencePath: source.logicalPath,
    symbol: candidate.symbol,
  }
}

async function apiRows(
  root: string,
  manifest: XtermReferenceManifest,
): Promise<readonly GeneratedRow[]> {
  const inventories = await extractDeclarationInventories(declarationSources(root, manifest))
  const rows: GeneratedRow[] = []
  for (const inventory of inventories) {
    rows.push(...inventory.candidates.map((candidate) => apiRow(inventory.source, candidate)))
  }
  return rows
}

export function extractXtermCssInventory(value: string): XtermCssInventory {
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//gu, '')
  const ruleGroups = new Set<string>()
  const selectors = new Set<string>()
  const classes = new Set<string>()
  for (const block of withoutComments.matchAll(/([^{}]+)\{/gu)) {
    addCssPrelude((block[1] ?? '').trim(), ruleGroups, selectors, classes)
  }
  return {
    classes: [...classes].sort(),
    ruleGroups: [...ruleGroups].sort(),
    selectors: [...selectors].sort(),
  }
}

function addCssPrelude(
  prelude: string,
  ruleGroups: Set<string>,
  selectors: Set<string>,
  classes: Set<string>,
): void {
  if (!prelude || prelude.startsWith('@')) return
  ruleGroups.add(prelude)
  for (const selector of splitSelectorList(prelude)) {
    const normalized = normalizeCssSelector(selector)
    if (!normalized.includes('.')) continue
    selectors.add(normalized)
    for (const match of normalized.matchAll(/\.[_a-z][\w-]*/giu)) classes.add(match[0])
  }
}

function normalizeCssSelector(value: string): string {
  return normalizeSignature(value)
    .replace(/\s*([>+~])\s*/gu, ' $1 ')
    .trim()
}

function assertCssCount(label: string, actual: number, expected?: number): void {
  if (expected === undefined || actual === expected) return
  throw new XtermParityError(
    `Released CSS ${label} count drifted: expected ${expected}, received ${actual}`,
  )
}

function splitSelectorList(value: string): readonly string[] {
  const selectors: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '(' || character === '[') {
      depth += 1
      continue
    }
    if (character === ')' || character === ']') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (character !== ',' || depth > 0) continue
    selectors.push(value.slice(start, index))
    start = index + 1
  }
  selectors.push(value.slice(start))
  return selectors
}

async function cssRows(
  root: string,
  manifest: XtermReferenceManifest,
): Promise<readonly GeneratedRow[]> {
  const core = manifest.packages.find((entry) => entry.name === '@xterm/xterm')
  if (!core?.css) throw new XtermParityError('The release manifest has no @xterm/xterm CSS path')
  const path = join(root, 'node_modules/@xterm/xterm', core.css)
  const inventory = extractXtermCssInventory(await readFile(path, 'utf8'))
  assertCssCount('rule-group', inventory.ruleGroups.length, core.cssRuleGroupCount)
  assertCssCount('selector', inventory.selectors.length, core.cssSelectorCount)
  assertCssCount('class', inventory.classes.length, core.cssClassCount)
  return inventory.selectors.map((symbol) => ({
    area: 'dom-css-accessibility-browser',
    behavior: `The released stylesheet defines the public ${symbol} selector.`,
    evidence: [],
    id: `css:${idPart(symbol)}:${shortHash(symbol)}`,
    implementationPath: null,
    inventoryKind: 'css',
    notes: '',
    ownerPlan: '010',
    package: '@xterm/xterm',
    referenceCommit: manifest.release.tagCommit,
    referencePath: `npm:@xterm/xterm@${core.version}/${core.css}`,
    symbol,
    targetStatus: 'missing',
  }))
}

function packageEntries(
  manifest: XtermReferenceManifest,
): readonly (XtermAddonManifest | XtermReferenceManifest['packages'][number])[] {
  return [...manifest.packages, ...manifest.addons]
}

function packageCommit(
  manifest: XtermReferenceManifest,
  entry: XtermAddonManifest | XtermReferenceManifest['packages'][number],
): string {
  return 'commit' in entry ? entry.commit : manifest.release.tagCommit
}

async function packageEntryRow(
  root: string,
  manifest: XtermReferenceManifest,
  entry: XtermAddonManifest | XtermReferenceManifest['packages'][number],
  key: 'main' | 'module' | 'runtimeModule' | 'style' | 'types',
  value: string,
): Promise<GeneratedRow> {
  const exists = await pathExists(root, `node_modules/${entry.name}/${value}`)
  return {
    area: 'packaging-imports',
    behavior: `${key} entry ${value}.`,
    evidence: [],
    id: `package:${semanticIdPart(entry.name)}:${semanticIdPart(key)}`,
    implementationPath: null,
    inventoryKind: 'packages',
    notes: exists
      ? ''
      : 'The published package metadata points to a file that is absent from the tarball.',
    ownerPlan: '014',
    package: entry.name,
    referenceCommit: packageCommit(manifest, entry),
    referencePath: `npm:${entry.name}@${entry.version}/package.json`,
    symbol: key,
    targetStatus: 'missing',
  }
}

function addRuntimeExportBlock(names: Set<string>, block: string, path: string): void {
  for (const rawEntry of block.split(',')) {
    const entry = rawEntry.trim()
    if (!entry) continue
    const alias = entry.match(/\bas\s+([A-Za-z_$][\w$]*)$/u)?.[1]
    const direct = entry.match(/^([A-Za-z_$][\w$]*)$/u)?.[1]
    const name = alias ?? direct
    if (!name) throw new XtermParityError(`Cannot parse runtime export ${entry} in ${path}`)
    names.add(name)
  }
}

function parseRuntimeExports(value: string, path: string): readonly string[] {
  const names = new Set<string>()
  for (const block of value.matchAll(/\bexport\s*\{([^}]*)\}/gu)) {
    addRuntimeExportBlock(names, block[1] ?? '', path)
  }
  if (names.size > 0) return [...names].sort()
  throw new XtermParityError(`No static ESM exports found in ${path}`)
}

async function runtimeExportRows(
  root: string,
  manifest: XtermReferenceManifest,
  entry: XtermAddonManifest | XtermReferenceManifest['packages'][number],
): Promise<readonly GeneratedRow[]> {
  const runtimeModule =
    'runtimeModule' in entry ? (entry.runtimeModule ?? entry.module) : entry.module
  const path = join(root, 'node_modules', ...entry.name.split('/'), runtimeModule)
  const exports = parseRuntimeExports(await readFile(path, 'utf8'), path)
  return exports.map((symbol) => ({
    area: 'packaging-imports',
    behavior: `The released ESM artifact exports ${symbol}.`,
    evidence: [],
    id: `package:${semanticIdPart(entry.name)}:runtime-export:${semanticIdPart(symbol)}`,
    implementationPath: null,
    inventoryKind: 'packages',
    notes: '',
    ownerPlan: '014',
    package: entry.name,
    referenceCommit: packageCommit(manifest, entry),
    referencePath: `npm:${entry.name}@${entry.version}/${runtimeModule}`,
    symbol,
    targetStatus: 'missing',
  }))
}

async function packageRows(
  root: string,
  manifest: XtermReferenceManifest,
): Promise<readonly GeneratedRow[]> {
  const rows: GeneratedRow[] = []
  for (const entry of packageEntries(manifest)) {
    rows.push({
      area: 'packaging-imports',
      behavior: `Import-compatible package ${entry.name}@${entry.version}.`,
      evidence: [],
      id: `package:${semanticIdPart(entry.name)}:package`,
      implementationPath: null,
      inventoryKind: 'packages',
      notes:
        'peerXterm' in entry && entry.peerXterm
          ? `Published with @xterm/xterm peer range ${entry.peerXterm}; this does not match the 6.0.0 core baseline.`
          : '',
      ownerPlan: '014',
      package: entry.name,
      referenceCommit: packageCommit(manifest, entry),
      referencePath: `npm:${entry.name}@${entry.version}/package.json`,
      symbol: 'package',
      targetStatus: 'missing',
    })
    rows.push(await packageEntryRow(root, manifest, entry, 'main', entry.main))
    rows.push(await packageEntryRow(root, manifest, entry, 'module', entry.module))
    rows.push(await packageEntryRow(root, manifest, entry, 'types', entry.types))
    if ('css' in entry && entry.css) {
      rows.push(await packageEntryRow(root, manifest, entry, 'style', entry.css))
    }
    if ('runtimeModule' in entry && entry.runtimeModule && entry.runtimeModule !== entry.module) {
      rows.push(await packageEntryRow(root, manifest, entry, 'runtimeModule', entry.runtimeModule))
    }
    rows.push(...(await runtimeExportRows(root, manifest, entry)))
  }
  return rows
}

function browserRows(manifest: XtermReferenceManifest): readonly GeneratedRow[] {
  const browsers: GeneratedRow[] = manifest.browserSupport.map((browser) => ({
    area: 'dom-css-accessibility-browser',
    behavior: `Support the latest evergreen ${browser} environment named by the pinned xterm README.`,
    evidence: ['docs/phase-3-acceptance.md'],
    id: `browser:${idPart(browser)}`,
    implementationPath: 'src/dom/terminal.ts',
    inventoryKind: 'manual',
    notes:
      'Browser-native terminal behavior exists, but the complete xterm interaction and accessibility matrix is not certified.',
    ownerPlan: '010',
    package: '@xterm/xterm',
    referenceCommit: manifest.source.commit,
    referencePath: 'references/xterm.js/README.md',
    symbol: browser,
    targetStatus: 'partial',
  }))
  const environments: GeneratedRow[] = manifest.environmentSupport.map((environment) => ({
    area: 'dom-css-accessibility-browser',
    behavior: `Preserve the pinned xterm README claim that the terminal works in ${environment}.`,
    evidence: [],
    id: `environment:${idPart(environment)}`,
    implementationPath: null,
    inventoryKind: 'manual',
    notes:
      'This is an environment claim, separate from the latest-version evergreen browser matrix.',
    ownerPlan: '010',
    package: '@xterm/xterm',
    referenceCommit: manifest.source.commit,
    referencePath: 'references/xterm.js/README.md',
    symbol: environment,
    targetStatus: 'missing',
  }))
  return [...browsers, ...environments]
}

function manualRows(manifest: XtermReferenceManifest): readonly GeneratedRow[] {
  const releasePath = `npm:@xterm/xterm@${manifest.release.version}/typings/xterm.d.ts`
  const lifecycle = [
    {
      behavior: 'Construction exposes released defaults and rows/cols before open.',
      evidence: ['src/xterm/tests/parity-smoke.test.ts'],
      id: 'behavior:constructor-defaults-and-pre-open-properties',
      implementationPath: 'src/term/session.ts',
      symbol: 'constructor defaults and pre-open properties',
    },
    {
      behavior: 'Write callbacks run after queued parsing and preserve call ordering.',
      evidence: ['src/xterm/tests/parity-smoke.test.ts'],
      id: 'behavior:write-callback-ordering',
      implementationPath: 'src/term/session.ts',
      symbol: 'write callback ordering',
    },
    {
      behavior:
        'open(parent) is synchronous; a second open is a no-op and does not move the terminal.',
      evidence: ['src/xterm/tests/parity-smoke.browser.test.ts'],
      id: 'behavior:open-lifecycle',
      implementationPath: 'src/dom/terminal.ts',
      symbol: 'open lifecycle',
    },
    {
      behavior:
        'Disposal detaches DOM while released element and textarea references remain disconnected objects.',
      evidence: ['src/xterm/tests/parity-smoke.browser.test.ts'],
      id: 'behavior:dispose-lifecycle',
      implementationPath: 'src/dom/terminal.ts',
      symbol: 'dispose lifecycle',
    },
    {
      behavior: 'Disposed event subscriptions stop delivery and disposal is idempotent.',
      evidence: ['src/xterm/tests/parity-smoke.test.ts'],
      id: 'behavior:event-subscription-disposal',
      implementationPath: 'src/term/session.ts',
      symbol: 'event subscription disposal',
    },
  ]
  const rows: GeneratedRow[] = lifecycle.map((entry) => ({
    area: 'core-lifecycle-options-events',
    behavior: entry.behavior,
    evidence: entry.evidence,
    id: entry.id,
    implementationPath: entry.implementationPath,
    inventoryKind: 'manual',
    notes: 'The differential driver records the current mismatch without claiming compatibility.',
    ownerPlan: '008',
    package: '@xterm/xterm',
    referenceCommit: manifest.release.tagCommit,
    referencePath: releasePath,
    symbol: entry.symbol,
    targetStatus: 'partial',
  }))
  rows.push(
    {
      area: 'vt-performance-manual',
      behavior:
        'Released xterm VT corpora and Ghostty-native parsing agree for the certified protocol matrix.',
      evidence: ['src/core/tests/terminal.test.ts'],
      id: 'behavior:vt-corpus',
      implementationPath: 'src/core/terminal.ts',
      inventoryKind: 'manual',
      notes: 'Ghostty VT coverage exists; differential xterm protocol certification remains open.',
      ownerPlan: '015',
      package: '@xterm/xterm',
      referenceCommit: manifest.release.tagCommit,
      referencePath: releasePath,
      symbol: 'VT behavior',
      targetStatus: 'partial',
    },
    {
      area: 'vt-performance-manual',
      behavior:
        'Compatibility preserves the two-draw renderer, damage scheduling, and recorded performance gates.',
      evidence: ['docs/renderer-refactor-baseline.md'],
      id: 'behavior:performance-gates',
      implementationPath: 'src/render/renderer.ts',
      inventoryKind: 'manual',
      notes:
        'Native performance is qualified; compatibility-facade overhead has not been measured.',
      ownerPlan: '015',
      package: '@xterm/xterm',
      referenceCommit: manifest.source.commit,
      referencePath: 'references/xterm.js/README.md',
      symbol: 'performance gates',
      targetStatus: 'partial',
    },
    {
      area: 'vt-performance-manual',
      behavior:
        'Physical keyboard, IME, clipboard, and screen-reader behavior passes the operator matrix.',
      evidence: ['docs/phase-3-acceptance.md'],
      id: 'behavior:physical-operator-gate',
      implementationPath: 'src/dom/terminal.ts',
      inventoryKind: 'manual',
      notes:
        'The physical operator checklist remains pending and cannot be replaced by automation.',
      ownerPlan: '015',
      package: '@xterm/xterm',
      referenceCommit: manifest.source.commit,
      referencePath: 'references/xterm.js/README.md',
      symbol: 'physical operator gate',
      targetStatus: 'partial',
    },
  )
  return rows
}

async function forwardRows(
  root: string,
  manifest: XtermReferenceManifest,
  releaseRows: readonly GeneratedRow[],
): Promise<readonly GeneratedRow[]> {
  const released = new Map(
    releaseRows.map((row) => [
      declarationComparisonKey(row.package, row.symbol, row.behavior),
      row,
    ]),
  )
  const sources: DeclarationSource[] = [
    {
      commit: manifest.source.commit,
      logicalPath: 'references/xterm.js/typings/xterm.d.ts',
      moduleName: '@xterm/xterm',
      packageName: '@xterm/xterm',
      path: join(root, 'references/xterm.js/typings/xterm.d.ts'),
    },
    {
      commit: manifest.source.commit,
      logicalPath: 'references/xterm.js/typings/xterm-headless.d.ts',
      moduleName: '@xterm/headless',
      packageName: '@xterm/headless',
      path: join(root, 'references/xterm.js/typings/xterm-headless.d.ts'),
    },
  ]
  for (const addon of manifest.addons) {
    sources.push({
      commit: manifest.source.commit,
      logicalPath: `references/xterm.js/addons/${addon.directory}/${addon.types}`,
      moduleName: addon.name,
      packageName: addon.name,
      path: join(root, 'references/xterm.js/addons', addon.directory, addon.types),
    })
  }
  const inventories = await extractDeclarationInventories(sources)
  const rows: (readonly GeneratedRow[])[] = []
  for (const inventory of inventories) {
    rows.push(forwardDeclarationRows(inventory, manifest, released))
  }
  rows.push(removedDeclarationRows(releaseRows, inventories, sources, manifest))
  return rows.flat()
}

function declarationComparisonKey(packageName: string, symbol: string, behavior: string): string {
  return `${packageName}:${symbol}:${behaviorIdentity(behavior)}`
}

function currentDeclarationKeys(inventories: readonly DeclarationInventory[]): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const inventory of inventories) {
    for (const candidate of inventory.candidates) {
      keys.add(
        declarationComparisonKey(
          inventory.source.packageName,
          candidate.symbol,
          candidate.behavior,
        ),
      )
    }
  }
  return keys
}

function removedDeclarationRows(
  releaseRows: readonly GeneratedRow[],
  inventories: readonly DeclarationInventory[],
  sources: readonly DeclarationSource[],
  manifest: XtermReferenceManifest,
): readonly GeneratedRow[] {
  const current = currentDeclarationKeys(inventories)
  const sourcePaths = new Map(sources.map((source) => [source.packageName, source.logicalPath]))
  const rows: GeneratedRow[] = []
  for (const releaseRow of releaseRows) {
    const key = declarationComparisonKey(releaseRow.package, releaseRow.symbol, releaseRow.behavior)
    if (current.has(key)) continue
    const referencePath = sourcePaths.get(releaseRow.package)
    if (!referencePath) {
      throw new XtermParityError(`No pinned declaration path for ${releaseRow.package}`)
    }
    rows.push({
      area: releaseRow.area,
      behavior: `Pinned master omits released behavior: ${releaseRow.behavior}`,
      evidence: [],
      id: releaseRow.id.replace(/^api:/u, 'forward-removed:'),
      implementationPath: null,
      inventoryKind: 'forwardDrift',
      notes: `The released API remains a certified ${manifest.release.version} requirement but is absent at ${manifest.source.commit}.`,
      ownerPlan: '015',
      package: `${releaseRow.package}@pinned-master-removal`,
      referenceCommit: manifest.source.commit,
      referencePath,
      symbol: releaseRow.symbol,
      targetStatus: 'not-applicable',
    })
  }
  return rows
}

function forwardDeclarationRows(
  inventory: DeclarationInventory,
  manifest: XtermReferenceManifest,
  released: ReadonlyMap<string, GeneratedRow>,
): readonly GeneratedRow[] {
  const source = inventory.source
  const rows: GeneratedRow[] = []
  for (const candidate of inventory.candidates) {
    const key = declarationComparisonKey(source.packageName, candidate.symbol, candidate.behavior)
    if (released.has(key)) continue
    rows.push({
      area: areaFor(source.packageName, candidate.symbol),
      behavior: candidate.behavior,
      evidence: [],
      id: `forward:${semanticIdPart(source.packageName)}:${semanticIdPart(candidate.kind)}:${semanticIdPart(candidate.symbol)}`,
      implementationPath: null,
      inventoryKind: 'forwardDrift',
      notes: `Forward-only API at ${manifest.source.commit}; outside the certified released-package baseline.`,
      ownerPlan: '015',
      package: `${source.packageName}@pinned-master`,
      referenceCommit: manifest.source.commit,
      referencePath: source.logicalPath,
      symbol: candidate.symbol,
      targetStatus: 'not-applicable',
    })
  }
  return rows
}

async function forwardCssRows(
  root: string,
  manifest: XtermReferenceManifest,
  releaseRows: readonly GeneratedRow[],
): Promise<readonly GeneratedRow[]> {
  const released = new Set(releaseRows.map((row) => row.symbol))
  const path = join(root, 'references/xterm.js/css/xterm.css')
  const inventory = extractXtermCssInventory(await readFile(path, 'utf8'))
  const current = new Set(inventory.selectors)
  const added: GeneratedRow[] = inventory.selectors
    .filter((selector) => !released.has(selector))
    .map((symbol) => ({
      area: 'dom-css-accessibility-browser',
      behavior: `Pinned master defines the forward-only ${symbol} selector.`,
      evidence: [],
      id: `forward-css:${idPart(symbol)}:${shortHash(symbol)}`,
      implementationPath: null,
      inventoryKind: 'forwardDrift',
      notes: `Forward-only CSS at ${manifest.source.commit}; outside the certified released-package baseline.`,
      ownerPlan: '015',
      package: '@xterm/xterm@pinned-master',
      referenceCommit: manifest.source.commit,
      referencePath: 'references/xterm.js/css/xterm.css',
      symbol,
      targetStatus: 'not-applicable',
    }))
  const removed: GeneratedRow[] = releaseRows
    .filter((row) => !current.has(row.symbol))
    .map((row) => ({
      area: 'dom-css-accessibility-browser',
      behavior: `Pinned master omits the released ${row.symbol} selector.`,
      evidence: [],
      id: `forward-css-removed:${idPart(row.symbol)}:${shortHash(row.symbol)}`,
      implementationPath: null,
      inventoryKind: 'forwardDrift',
      notes: `The released selector remains a certified ${manifest.release.version} requirement but is absent at ${manifest.source.commit}.`,
      ownerPlan: '015',
      package: '@xterm/xterm@pinned-master-removal',
      referenceCommit: manifest.source.commit,
      referencePath: 'references/xterm.js/css/xterm.css',
      symbol: row.symbol,
      targetStatus: 'not-applicable',
    }))
  return [...added, ...removed]
}

async function readExistingRows(root: string): Promise<ReadonlyMap<string, XtermParityRow>> {
  try {
    const ledger = JSON.parse(
      await readFile(join(root, ledgerJsonPath), 'utf8'),
    ) as XtermParityLedger
    return new Map(ledger.rows.map((row) => [row.id, row]))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw cause
  }
}

function mergeDisposition(row: GeneratedRow, existing?: XtermParityRow): GeneratedRow {
  if (!existing) return row
  if (existing.behavior !== row.behavior || existing.referenceCommit !== row.referenceCommit) {
    return {
      ...row,
      notes: [row.notes, 'Reference behavior changed; compatibility status was reset.']
        .filter(Boolean)
        .join(' '),
    }
  }
  return {
    ...row,
    evidence: existing.evidence,
    implementationPath: existing.implementationPath,
    notes: existing.notes,
    ownerPlan: existing.ownerPlan,
    targetStatus: existing.targetStatus,
  }
}

function assertUniqueRows(rows: readonly XtermParityRow[]): void {
  const ids = new Set<string>()
  for (const row of rows) {
    if (!ids.has(row.id)) {
      ids.add(row.id)
      continue
    }
    throw new XtermParityError(`Duplicate parity row id ${row.id}`)
  }
}

function inventoryCounts(rows: readonly GeneratedRow[]): XtermParityLedger['inventory'] {
  const counts = { api: 0, css: 0, forwardDrift: 0, manual: 0, packages: 0, total: rows.length }
  for (const row of rows) counts[row.inventoryKind] += 1
  return counts
}

function ledgerInventoryKind(
  row: XtermParityRow,
): keyof Omit<XtermParityLedger['inventory'], 'total'> {
  if (row.id.startsWith('api:')) return 'api'
  if (row.id.startsWith('css:')) return 'css'
  if (row.id.startsWith('forward:') || row.id.startsWith('forward-')) return 'forwardDrift'
  if (row.id.startsWith('package:')) return 'packages'
  if (/^(?:behavior|browser|environment):/u.test(row.id)) return 'manual'
  throw new XtermParityError(`Parity row ${row.id} has an unknown inventory kind`)
}

function ledgerInventoryCounts(rows: readonly XtermParityRow[]): XtermParityLedger['inventory'] {
  const counts = { api: 0, css: 0, forwardDrift: 0, manual: 0, packages: 0, total: rows.length }
  for (const row of rows) counts[ledgerInventoryKind(row)] += 1
  return counts
}

function validateInventoryCounts(ledger: XtermParityLedger): void {
  const actual = ledgerInventoryCounts(ledger.rows)
  for (const key of Object.keys(actual) as readonly (keyof typeof actual)[]) {
    if (ledger.inventory[key] === actual[key]) continue
    throw new XtermParityError(
      `Parity inventory ${key} is ${ledger.inventory[key]}; generated rows contain ${actual[key]}`,
    )
  }
}

export async function generateXtermParityLedger(root = projectRoot): Promise<XtermParityLedger> {
  const manifest = await readXtermManifest(root)
  const api = await apiRows(root, manifest)
  const css = await cssRows(root, manifest)
  const generated: GeneratedRow[] = [
    ...api,
    ...css,
    ...(await packageRows(root, manifest)),
    ...browserRows(manifest),
    ...manualRows(manifest),
    ...(await forwardRows(root, manifest, api)),
    ...(await forwardCssRows(root, manifest, css)),
  ]
  assertUniqueRows(generated)
  const existing = await readExistingRows(root)
  const merged = generated
    .map((row) => mergeDisposition(row, existing.get(row.id)))
    .sort((left, right) => left.id.localeCompare(right.id))
  return {
    baseline: {
      releaseCommit: manifest.release.tagCommit,
      releaseVersion: manifest.release.version,
      sourceCommit: manifest.source.commit,
      sourceUrl: manifest.source.url,
    },
    inventory: inventoryCounts(generated),
    rows: merged.map(({ inventoryKind: _, ...row }) => row),
    schemaVersion: 1,
  }
}

function sectionFor(area: string): (typeof sectionOrder)[number] {
  if (area.startsWith('addon-')) return 'Official addons'
  if (area === 'headless') return 'Headless'
  if (area === 'packaging-imports') return 'Packaging and import compatibility'
  if (area === 'dom-css-accessibility-browser')
    return 'DOM, CSS, accessibility, and browser support'
  if (area === 'terminal-methods-input') return 'Terminal methods and input'
  if (area === 'buffer-cell-modes-parser-unicode') {
    return 'Buffer, cell, modes, parser, and Unicode'
  }
  if (area === 'selection-markers-decorations-links-joiners') {
    return 'Selection, markers, decorations, links, and joiners'
  }
  if (area === 'vt-performance-manual') return 'VT behavior, performance, and manual gates'
  return 'Core constructor, lifecycle, options, and events'
}

function markdownCell(value: string): string {
  return normalizeText(value, 180)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/\|/gu, '\\|')
    .replace(/`/gu, '\\`')
}

function rowEvidence(row: XtermParityRow): string {
  const values = [row.implementationPath ?? '', ...row.evidence].filter(Boolean)
  if (values.length === 0) return '—'
  return values.map((value) => `\`${markdownCell(value)}\``).join('<br>')
}

function statusCounts(rows: readonly XtermParityRow[]): string {
  return parityStatuses
    .map((status) => `${status}: ${rows.filter((row) => row.targetStatus === status).length}`)
    .join(' · ')
}

export function renderXtermParityMarkdown(ledger: XtermParityLedger): string {
  const lines = [
    '# xterm compatibility ledger',
    '',
    `Pinned comparison baseline: \`@xterm/xterm@${ledger.baseline.releaseVersion}\` at \`${ledger.baseline.releaseCommit}\`.`,
    `Forward reference: [xterm.js](${ledger.baseline.sourceUrl.replace(/\.git$/u, '')}/tree/${ledger.baseline.sourceCommit}) at \`${ledger.baseline.sourceCommit}\`.`,
    '',
    `Inventory: ${ledger.inventory.total} rows (${ledger.inventory.api} API, ${ledger.inventory.css} CSS, ${ledger.inventory.packages} package, ${ledger.inventory.manual} behavioral, ${ledger.inventory.forwardDrift} forward-drift).`,
    '',
    `${statusCounts(ledger.rows)}.`,
    '',
    'This ledger is a diagnostic reference for xterm compatibility. Product release readiness follows [Plan 016: ghostty-web replacement readiness](../plans/016-ghostty-web-replacement-readiness.md). Zero-gap xterm certification is retired as a product release requirement.',
    '',
    'Row statuses and historical ownership remain recorded when plans are superseded, deferred, or retired. A `compatible` row must name evidence. Forward-only rows are explicitly `not-applicable` to the pinned release. Existing certification wording in row notes describes the historical xterm comparison scope, not a product readiness claim.',
    '',
  ]
  for (const section of sectionOrder) {
    const rows = ledger.rows.filter((row) => sectionFor(row.area) === section)
    lines.push(`## ${section}`, '')
    if (rows.length === 0) {
      lines.push('_No rows._', '')
      continue
    }
    lines.push(
      '| ID | Package | Symbol | Behavior | Status | Owner | Implementation / evidence | Notes |',
    )
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const row of rows) {
      lines.push(
        `| \`${markdownCell(row.id)}\` | \`${markdownCell(row.package)}\` | \`${markdownCell(row.symbol)}\` | ${markdownCell(row.behavior)} | \`${row.targetStatus}\` | ${row.ownerPlan} | ${rowEvidence(row)} | ${markdownCell(row.notes) || '—'} |`,
      )
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function jsonText(ledger: XtermParityLedger): string {
  return `${JSON.stringify(ledger, null, 2)}\n`
}

async function assertCurrent(path: string, expected: string): Promise<void> {
  let actual: string
  try {
    actual = await readFile(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    throw new XtermParityError(
      `${relative(projectRoot, path)} is missing; run bun run xterm:parity:update`,
    )
  }
  if (actual === expected) return
  throw new XtermParityError(
    `${relative(projectRoot, path)} is stale; run bun run xterm:parity:update`,
  )
}

async function pathExists(root: string, path: string): Promise<boolean> {
  try {
    await access(join(root, path.split('#')[0] ?? path))
    return true
  } catch {
    return false
  }
}

function planStatuses(markdown: string): ReadonlyMap<string, string> {
  const statuses = new Map<string, string>()
  for (const line of markdown.split('\n')) {
    const match = line.match(
      /^\|\s*(\d{3})\s*\|.*\|\s*(TODO|IN PROGRESS|DONE|BLOCKED|REJECTED|SUPERSEDED|DEFERRED|RETIRED)(?:\s+[^|]*)?\s*\|$/u,
    )
    if (!match?.[1] || !match[2]) continue
    statuses.set(match[1], match[2])
  }
  return statuses
}

async function validateRow(
  root: string,
  row: XtermParityRow,
  plans: ReadonlyMap<string, string>,
): Promise<void> {
  if (
    !row.id ||
    !row.area ||
    !row.package ||
    !row.symbol ||
    !row.behavior ||
    !row.referenceCommit ||
    !row.referencePath
  ) {
    throw new XtermParityError(`Parity row ${row.id || '<unknown>'} has an empty required field`)
  }
  if (!Array.isArray(row.evidence)) {
    throw new XtermParityError(`Parity row ${row.id} evidence must be an array`)
  }
  if (!statusSet.has(row.targetStatus)) {
    throw new XtermParityError(`Parity row ${row.id} has invalid status ${row.targetStatus}`)
  }
  if (!/^\d{3}$/u.test(row.ownerPlan) || !plans.has(row.ownerPlan)) {
    throw new XtermParityError(`Parity row ${row.id} has unknown owner plan ${row.ownerPlan}`)
  }
  if (row.targetStatus === 'compatible' && row.evidence.length === 0) {
    throw new XtermParityError(`Compatible parity row ${row.id} has no evidence`)
  }
  if (row.targetStatus === 'not-applicable' && row.notes.length === 0) {
    throw new XtermParityError(`Not-applicable parity row ${row.id} has no reason`)
  }
  if (row.targetStatus === 'not-applicable' && ledgerInventoryKind(row) !== 'forwardDrift') {
    throw new XtermParityError(`Released parity row ${row.id} cannot be not-applicable`)
  }
  if (row.implementationPath && !(await pathExists(root, row.implementationPath))) {
    throw new XtermParityError(`Parity row ${row.id} implementation path is missing`)
  }
  for (const evidence of row.evidence) {
    if (await pathExists(root, evidence)) continue
    throw new XtermParityError(`Parity row ${row.id} evidence path is missing: ${evidence}`)
  }
  const ownerDone = plans.get(row.ownerPlan) === 'DONE'
  const gap =
    row.targetStatus === 'missing' ||
    row.targetStatus === 'partial' ||
    row.targetStatus === 'blocked'
  if (!ownerDone || !gap) return
  throw new XtermParityError(
    `DONE Plan ${row.ownerPlan} still owns ${row.targetStatus} row ${row.id}`,
  )
}

export async function validateXtermParityLedger(
  ledger: XtermParityLedger,
  root = projectRoot,
): Promise<void> {
  if (ledger.schemaVersion !== 1) throw new XtermParityError('Unsupported parity schema version')
  validateInventoryCounts(ledger)
  const manifest = await readXtermManifest(root)
  if (ledger.baseline.releaseCommit !== manifest.release.tagCommit) {
    throw new XtermParityError('Parity release commit does not match the reference manifest')
  }
  if (ledger.baseline.releaseVersion !== manifest.release.version) {
    throw new XtermParityError('Parity release version does not match the reference manifest')
  }
  if (ledger.baseline.sourceCommit !== manifest.source.commit) {
    throw new XtermParityError('Parity source commit does not match the reference manifest')
  }
  if (ledger.baseline.sourceUrl !== manifest.source.url) {
    throw new XtermParityError('Parity source URL does not match the reference manifest')
  }
  assertUniqueRows(ledger.rows)
  const plans = planStatuses(await readFile(join(root, 'plans/README.md'), 'utf8'))
  for (const row of ledger.rows) await validateRow(root, row, plans)
}

async function writeLedger(root: string, ledger: XtermParityLedger): Promise<void> {
  await writeFile(join(root, ledgerJsonPath), jsonText(ledger))
  await writeFile(join(root, ledgerMarkdownPath), renderXtermParityMarkdown(ledger))
}

async function checkLedger(root: string, ledger: XtermParityLedger): Promise<void> {
  await validateXtermParityLedger(ledger, root)
  await assertCurrent(join(root, ledgerJsonPath), jsonText(ledger))
  await assertCurrent(join(root, ledgerMarkdownPath), renderXtermParityMarkdown(ledger))
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write')
  const check = process.argv.includes('--check') || !write
  if (write && process.argv.includes('--check')) {
    throw new XtermParityError('Choose either --write or --check')
  }
  const ledger = await generateXtermParityLedger()
  if (write) await writeLedger(projectRoot, ledger)
  if (check) await checkLedger(projectRoot, ledger)
  console.log(
    `Validated ${ledger.inventory.total} xterm parity rows (${statusCounts(ledger.rows)})`,
  )
}

if (import.meta.main) await main()
