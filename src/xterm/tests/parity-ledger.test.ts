import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  generateXtermParityLedger,
  renderXtermParityMarkdown,
  validateXtermParityLedger,
  XtermParityError,
  type XtermParityLedger,
  type XtermParityRow,
} from '../../../scripts/xterm-parity.js'
import {
  projectRoot,
  readXtermManifest,
  type XtermReferenceManifest,
} from '../../../scripts/xterm-reference.js'

const releaseVersion = '6.0.0'
const releaseCommit = 'f447274f430fd22513f6adbf9862d19524471c04'
const sourceCommit = '08ad9a4de9252f387cc5fbf68aa3d98e0ba8a0b7'
const sourceUrl = 'https://github.com/xtermjs/xterm.js.git'

const expectedApiByPackage = Object.freeze({
  '@xterm/addon-attach': 6,
  '@xterm/addon-clipboard': 19,
  '@xterm/addon-fit': 9,
  '@xterm/addon-image': 21,
  '@xterm/addon-ligatures': 7,
  '@xterm/addon-progress': 9,
  '@xterm/addon-search': 27,
  '@xterm/addon-serialize': 23,
  '@xterm/addon-unicode-graphemes': 4,
  '@xterm/addon-unicode11': 4,
  '@xterm/addon-web-fonts': 7,
  '@xterm/addon-web-links': 8,
  '@xterm/addon-webgl': 10,
  '@xterm/headless': 224,
  '@xterm/xterm': 306,
})

const expectedForwardApiByPackage = Object.freeze({
  '@xterm/addon-clipboard@pinned-master': 4,
  '@xterm/addon-image@pinned-master': 3,
  '@xterm/addon-search@pinned-master': 2,
  '@xterm/addon-webgl@pinned-master': 4,
  '@xterm/headless@pinned-master': 21,
  '@xterm/xterm@pinned-master': 40,
})

const expectedRemovedApiByPackage = Object.freeze({
  '@xterm/addon-clipboard@pinned-master-removal': 7,
  '@xterm/addon-webgl@pinned-master-removal': 1,
  '@xterm/headless@pinned-master-removal': 4,
  '@xterm/xterm@pinned-master-removal': 3,
})

const expectedReleasedCssSelectors = Object.freeze([
  '.xterm-char-measure-element',
  '.xterm.column-select.focus',
  '.xterm .composition-view.active',
  '.xterm .composition-view',
  '.xterm-decoration-overview-ruler',
  '.xterm-decoration-top',
  '.xterm-dim',
  '.xterm.enable-mouse-events',
  '.xterm:focus',
  '.xterm.focus',
  '.xterm .live-region',
  '.xterm-overline.xterm-underline-1',
  '.xterm-overline.xterm-underline-2',
  '.xterm-overline.xterm-underline-3',
  '.xterm-overline.xterm-underline-4',
  '.xterm-overline.xterm-underline-5',
  '.xterm-overline',
  '.xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer',
  '.xterm-screen .xterm-decoration-container .xterm-decoration',
  '.xterm-strikethrough',
  '.xterm-underline-1',
  '.xterm-underline-2',
  '.xterm-underline-3',
  '.xterm-underline-4',
  '.xterm-underline-5',
  '.xterm .xterm-accessibility:not(.debug)',
  '.xterm .xterm-accessibility-tree > div',
  '.xterm .xterm-accessibility-tree:not(.debug) *::selection',
  '.xterm .xterm-accessibility-tree',
  '.xterm .xterm-cursor-pointer',
  '.xterm.xterm-cursor-pointer',
  '.xterm .xterm-helper-textarea',
  '.xterm .xterm-helpers',
  '.xterm .xterm-message',
  '.xterm .xterm-screen canvas',
  '.xterm .xterm-screen',
  '.xterm .xterm-scrollable-element > .invisible.fade',
  '.xterm .xterm-scrollable-element > .invisible',
  '.xterm .xterm-scrollable-element > .scrollbar > .scra',
  '.xterm .xterm-scrollable-element > .scrollbar',
  '.xterm .xterm-scrollable-element > .shadow.left',
  '.xterm .xterm-scrollable-element > .shadow.top-left-corner',
  '.xterm .xterm-scrollable-element > .shadow.top.left',
  '.xterm .xterm-scrollable-element > .shadow.top',
  '.xterm .xterm-scrollable-element > .shadow',
  '.xterm .xterm-scrollable-element > .visible',
  '.xterm .xterm-viewport',
  '.xterm',
])

const expectedForwardCssSelectors = Object.freeze([
  '.xterm:not(.allow-transparency) .xterm-viewport',
  '.xterm .xterm-scrollable-element > .xterm-invisible.xterm-fade',
  '.xterm .xterm-scrollable-element > .xterm-invisible',
  '.xterm .xterm-scrollable-element > .xterm-scrollbar > .xterm-scra.xterm-arrow-down',
  '.xterm .xterm-scrollable-element > .xterm-scrollbar > .xterm-scra',
  '.xterm .xterm-scrollable-element > .xterm-scrollbar',
  '.xterm .xterm-scrollable-element > .xterm-shadow.xterm-shadow-left',
  '.xterm .xterm-scrollable-element > .xterm-shadow.xterm-shadow-top-left-corner',
  '.xterm .xterm-scrollable-element > .xterm-shadow.xterm-shadow-top.xterm-shadow-left',
  '.xterm .xterm-scrollable-element > .xterm-shadow.xterm-shadow-top',
  '.xterm .xterm-scrollable-element > .xterm-shadow',
  '.xterm .xterm-scrollable-element > .xterm-visible',
])

const expectedRemovedCssSelectors = Object.freeze([
  '.xterm-char-measure-element',
  '.xterm .xterm-scrollable-element > .invisible.fade',
  '.xterm .xterm-scrollable-element > .invisible',
  '.xterm .xterm-scrollable-element > .scrollbar > .scra',
  '.xterm .xterm-scrollable-element > .scrollbar',
  '.xterm .xterm-scrollable-element > .shadow.left',
  '.xterm .xterm-scrollable-element > .shadow.top-left-corner',
  '.xterm .xterm-scrollable-element > .shadow.top.left',
  '.xterm .xterm-scrollable-element > .shadow.top',
  '.xterm .xterm-scrollable-element > .shadow',
  '.xterm .xterm-scrollable-element > .visible',
])

const expectedRuntimeExports = Object.freeze({
  '@xterm/addon-attach': ['AttachAddon'],
  '@xterm/addon-clipboard': ['Base64', 'BrowserClipboardProvider', 'ClipboardAddon'],
  '@xterm/addon-fit': ['FitAddon'],
  '@xterm/addon-image': ['ImageAddon'],
  '@xterm/addon-ligatures': ['LigaturesAddon'],
  '@xterm/addon-progress': ['ProgressAddon'],
  '@xterm/addon-search': ['SearchAddon'],
  '@xterm/addon-serialize': ['HTMLSerializeHandler', 'SerializeAddon'],
  '@xterm/addon-unicode-graphemes': ['UnicodeGraphemesAddon'],
  '@xterm/addon-unicode11': ['Unicode11Addon'],
  '@xterm/addon-web-fonts': ['WebFontsAddon', 'loadFonts'],
  '@xterm/addon-web-links': ['WebLinksAddon'],
  '@xterm/addon-webgl': ['WebglAddon'],
  '@xterm/headless': ['Terminal'],
  '@xterm/xterm': ['Terminal'],
})

const basePackageSymbols = Object.freeze(['main', 'module', 'package', 'types'])
const evergreenBrowsers = Object.freeze(['Chrome', 'Edge', 'Firefox', 'Safari'])

let committedLedger: XtermParityLedger
let committedMarkdown: string
let generatedLedger: XtermParityLedger
let manifest: XtermReferenceManifest
let validationRoot: string

function hasRowKind(row: XtermParityRow, kind: string): boolean {
  return row.id.startsWith(`${kind}:`) || row.id.startsWith(`${kind}/`)
}

function rowsOfKind(ledger: XtermParityLedger, kind: string): readonly XtermParityRow[] {
  return ledger.rows.filter((row) => hasRowKind(row, kind))
}

function rowBySymbol(
  rows: readonly XtermParityRow[],
  packageName: string,
  symbol: string,
): XtermParityRow | undefined {
  return rows.find((row) => row.package === packageName && row.symbol === symbol)
}

function apiCountsByPackage(rows: readonly XtermParityRow[]): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.keys(expectedApiByPackage).map((packageName) => [
      packageName,
      rows.filter((row) => row.package === packageName).length,
    ]),
  )
}

function forwardApiCountsByPackage(
  rows: readonly XtermParityRow[],
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.keys(expectedForwardApiByPackage).map((packageName) => [
      packageName,
      rows.filter((row) => row.package === packageName).length,
    ]),
  )
}

function removedApiCountsByPackage(
  rows: readonly XtermParityRow[],
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.keys(expectedRemovedApiByPackage).map((packageName) => [
      packageName,
      rows.filter((row) => row.package === packageName).length,
    ]),
  )
}

function expectedSymbolsForPackage(packageName: string): readonly string[] {
  const runtimeExports = expectedRuntimeExports as Readonly<Record<string, readonly string[]>>
  const symbols = [...basePackageSymbols, ...(runtimeExports[packageName] ?? [])]
  if (packageName === '@xterm/xterm') symbols.push('style')
  if (packageName === '@xterm/headless') symbols.push('runtimeModule')
  return symbols.sort()
}

function fixtureRow(overrides: Partial<XtermParityRow> = {}): XtermParityRow {
  return {
    area: 'core-lifecycle-options-events',
    behavior: 'Public class Terminal',
    evidence: [],
    id: 'api:xterm-xterm:class:terminal',
    implementationPath: null,
    notes: '',
    ownerPlan: '008',
    package: '@xterm/xterm',
    referenceCommit: releaseCommit,
    referencePath: 'npm:@xterm/xterm@6.0.0/typings/xterm.d.ts',
    symbol: 'Terminal',
    targetStatus: 'missing',
    ...overrides,
  }
}

function fixtureLedger(rows: readonly XtermParityRow[] = [fixtureRow()]): XtermParityLedger {
  return {
    baseline: {
      releaseCommit,
      releaseVersion,
      sourceCommit,
      sourceUrl,
    },
    inventory: {
      api: rows.length,
      css: 0,
      forwardDrift: 0,
      manual: 0,
      packages: 0,
      total: rows.length,
    },
    rows,
    schemaVersion: 1,
  }
}

async function writePlanStatus(
  status: 'DONE' | 'TODO' | 'SUPERSEDED' | 'DEFERRED' | 'RETIRED',
): Promise<void> {
  const markdown = `| Plan | Title | Status |\n| --- | --- | --- |\n| 008 | Terminal facade | ${status} |\n`
  await writeFile(join(validationRoot, 'plans/README.md'), markdown)
}

beforeAll(async () => {
  validationRoot = await mkdtemp(join(tmpdir(), 'ghostty-xterm-parity-'))
  await Promise.all([
    mkdir(join(validationRoot, 'plans')),
    mkdir(join(validationRoot, 'references')),
  ])
  const results = await Promise.all([
    generateXtermParityLedger(),
    readXtermManifest(),
    readFile(join(projectRoot, 'docs/xterm-parity.json'), 'utf8').then(
      (value) => JSON.parse(value) as XtermParityLedger,
    ),
    readFile(join(projectRoot, 'docs/xterm-parity.md'), 'utf8'),
  ])
  generatedLedger = results[0]
  manifest = results[1]
  committedLedger = results[2]
  committedMarkdown = results[3]
  await writeFile(
    join(validationRoot, 'references/xterm-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}, 60_000)

beforeEach(async () => {
  await writePlanStatus('TODO')
})

afterAll(async () => {
  await rm(validationRoot, { force: true, recursive: true })
})

describe('generated xterm parity inventory', () => {
  it('ships the certified released xterm stylesheet byte-for-byte', async () => {
    const [reference, packaged] = await Promise.all([
      readFile(join(projectRoot, 'node_modules/@xterm/xterm/css/xterm.css')),
      readFile(join(projectRoot, 'src/xterm/css/xterm.css')),
    ])

    expect(packaged).toEqual(reference)
  })

  it('pins the exact released and forward-reference baselines', () => {
    expect(generatedLedger.schemaVersion).toBe(1)
    expect(generatedLedger.baseline).toEqual({
      releaseCommit,
      releaseVersion,
      sourceCommit,
      sourceUrl,
    })
    expect(manifest.release).toEqual({ tagCommit: releaseCommit, version: releaseVersion })
    expect(manifest.source).toEqual({ commit: sourceCommit, url: sourceUrl })
  })

  it('inventories all 684 released declaration and member rows exactly', () => {
    const apiRows = rowsOfKind(generatedLedger, 'api')

    expect(generatedLedger.inventory).toEqual({
      api: 684,
      css: 48,
      forwardDrift: 112,
      manual: 13,
      packages: 81,
      total: 938,
    })
    expect(generatedLedger.inventory.api).toBe(684)
    expect(apiRows).toHaveLength(684)
    expect(apiCountsByPackage(apiRows)).toEqual(expectedApiByPackage)
    expect(new Set(apiRows.map((row) => row.id)).size).toBe(apiRows.length)
    expect(apiRows.every((row) => row.referencePath.startsWith('npm:'))).toBe(true)
    expect(
      apiRows.filter(
        (row) =>
          row.package.startsWith('@xterm/addon-') &&
          row.implementationPath === 'src/term/session.ts',
      ),
    ).toEqual([])
  })

  it('covers every package entry, runtime export, browser claim, and CSS selector', () => {
    const manifestPackages = [...manifest.packages, ...manifest.addons]
      .map((entry) => entry.name)
      .sort()
    const expectedPackages = Object.keys(expectedRuntimeExports).sort()
    const packageRows = rowsOfKind(generatedLedger, 'package')
    const runtimeExportRows = packageRows.filter((row) => row.id.includes(':runtime-export:'))
    const metadataRows = packageRows.filter((row) => !row.id.includes(':runtime-export:'))
    const browserRows = rowsOfKind(generatedLedger, 'browser')
    const environmentRows = rowsOfKind(generatedLedger, 'environment')
    const behaviorRows = rowsOfKind(generatedLedger, 'behavior')
    const cssRows = rowsOfKind(generatedLedger, 'css')

    expect(manifestPackages).toEqual(expectedPackages)
    expect(generatedLedger.inventory.packages).toBe(81)
    expect(packageRows).toHaveLength(81)
    expect(metadataRows).toHaveLength(62)
    expect(runtimeExportRows).toHaveLength(19)
    expect([...new Set(packageRows.map((row) => row.package))].sort()).toEqual(expectedPackages)
    for (const packageName of expectedPackages) {
      const symbols = packageRows
        .filter((row) => row.package === packageName)
        .map((row) => row.symbol)
        .sort()
      expect(symbols).toEqual(expectedSymbolsForPackage(packageName))
    }

    expect(
      rowBySymbol(runtimeExportRows, '@xterm/addon-serialize', 'HTMLSerializeHandler'),
    ).toMatchObject({
      behavior: 'The released ESM artifact exports HTMLSerializeHandler.',
      referenceCommit: releaseCommit,
    })
    expect(
      rowBySymbol(
        rowsOfKind(generatedLedger, 'api'),
        '@xterm/addon-serialize',
        'HTMLSerializeHandler',
      ),
    ).toBeUndefined()
    expect(rowBySymbol(metadataRows, '@xterm/xterm', 'style')?.behavior).toBe(
      'style entry css/xterm.css.',
    )
    expect(rowBySymbol(metadataRows, '@xterm/headless', 'runtimeModule')?.behavior).toBe(
      'runtimeModule entry lib-headless/xterm-headless.mjs.',
    )

    expect(browserRows.map((row) => row.symbol).sort()).toEqual(evergreenBrowsers)
    expect(environmentRows.map((row) => row.symbol)).toEqual(['Electron'])
    expect(behaviorRows).toHaveLength(8)
    expect(cssRows.map((row) => row.symbol).sort()).toEqual(
      [...expectedReleasedCssSelectors].sort(),
    )
    expect(generatedLedger.inventory.css).toBe(48)
    expect(generatedLedger.inventory.manual).toBe(13)
    expect(generatedLedger.inventory.total).toBe(938)
  })

  it('keeps released behavior separate from pinned-master forward drift', () => {
    const apiRows = rowsOfKind(generatedLedger, 'api')
    const behaviorRows = rowsOfKind(generatedLedger, 'behavior')
    const forwardApiRows = rowsOfKind(generatedLedger, 'forward')
    const forwardCssRows = rowsOfKind(generatedLedger, 'forward-css')
    const removedApiRows = rowsOfKind(generatedLedger, 'forward-removed')
    const removedCssRows = rowsOfKind(generatedLedger, 'forward-css-removed')
    const addedRows = [...forwardApiRows, ...forwardCssRows]
    const removedRows = [...removedApiRows, ...removedCssRows]
    const forwardRows = [...addedRows, ...removedRows]
    const forwardSymbols = new Set(forwardApiRows.map((row) => row.symbol))

    expect(generatedLedger.inventory.forwardDrift).toBe(112)
    expect(forwardRows).toHaveLength(112)
    expect(forwardApiRows).toHaveLength(74)
    expect(forwardCssRows).toHaveLength(12)
    expect(removedApiRows).toHaveLength(15)
    expect(removedCssRows).toHaveLength(11)
    expect(forwardApiCountsByPackage(forwardApiRows)).toEqual(expectedForwardApiByPackage)
    expect(removedApiCountsByPackage(removedApiRows)).toEqual(expectedRemovedApiByPackage)
    expect(new Set(forwardApiRows.map((row) => row.package))).toEqual(
      new Set(Object.keys(expectedForwardApiByPackage)),
    )
    expect(forwardCssRows.map((row) => row.symbol).sort()).toEqual(
      [...expectedForwardCssSelectors].sort(),
    )
    expect(removedCssRows.map((row) => row.symbol).sort()).toEqual(
      [...expectedRemovedCssSelectors].sort(),
    )
    expect(
      addedRows.every(
        (row) =>
          row.referenceCommit === sourceCommit &&
          row.referencePath.startsWith('references/xterm.js/') &&
          row.targetStatus === 'not-applicable' &&
          row.notes.includes('outside the certified released-package baseline'),
      ),
    ).toBe(true)
    expect(
      removedRows.every(
        (row) =>
          row.referenceCommit === sourceCommit &&
          row.referencePath.startsWith('references/xterm.js/') &&
          row.targetStatus === 'not-applicable' &&
          row.notes.includes('remains a certified'),
      ),
    ).toBe(true)
    expect([...forwardSymbols]).toEqual(
      expect.arrayContaining([
        'Terminal.dimensions',
        'Terminal.onDimensionsChange',
        'Terminal.screenElement',
      ]),
    )
    expect(rowBySymbol(apiRows, '@xterm/xterm', 'Terminal.screenElement')).toBeUndefined()

    const releasedWebglConstructor = rowBySymbol(
      apiRows,
      '@xterm/addon-webgl',
      'WebglAddon.constructor',
    )
    const forwardWebglConstructor = rowBySymbol(
      forwardApiRows,
      '@xterm/addon-webgl@pinned-master',
      'WebglAddon.constructor',
    )
    expect(releasedWebglConstructor?.referenceCommit).toBe(releaseCommit)
    expect(forwardWebglConstructor?.referenceCommit).toBe(sourceCommit)
    expect(forwardWebglConstructor?.behavior).not.toBe(releasedWebglConstructor?.behavior)

    expect(behaviorRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          behavior:
            'open(parent) is synchronous; a second open is a no-op and does not move the terminal.',
          referenceCommit: releaseCommit,
          symbol: 'open lifecycle',
        }),
        expect.objectContaining({
          behavior:
            'Disposal detaches DOM while released element and textarea references remain disconnected objects.',
          referenceCommit: releaseCommit,
          symbol: 'dispose lifecycle',
        }),
      ]),
    )
  })

  it('reproduces the committed JSON and Markdown byte-for-byte', async () => {
    const markdown = renderXtermParityMarkdown(generatedLedger)
    const sortedIds = generatedLedger.rows
      .map((row) => row.id)
      .sort((left, right) => left.localeCompare(right))

    expect(generatedLedger).toEqual(committedLedger)
    expect(generatedLedger.rows.map((row) => row.id)).toEqual(sortedIds)
    expect(renderXtermParityMarkdown(structuredClone(generatedLedger))).toBe(markdown)
    expect(markdown).toBe(committedMarkdown)
    expect(markdown).toContain('IEvent&lt;void&gt;')
    expect(markdown).not.toContain('IEvent<void>')
    await expect(validateXtermParityLedger(generatedLedger)).resolves.toBeUndefined()
  })
})

describe('xterm parity ledger validation', () => {
  it('rejects unsupported schemas, inconsistent inventory counts, and duplicate ids', async () => {
    const wrongSchema = { ...fixtureLedger(), schemaVersion: 2 } as unknown as XtermParityLedger
    const ledger = fixtureLedger()
    const inconsistentTotal = {
      ...ledger,
      inventory: { ...ledger.inventory, total: 2 },
    }
    const inconsistentApi = {
      ...ledger,
      inventory: { ...ledger.inventory, api: 0 },
    }
    const row = fixtureRow()
    const duplicate = fixtureLedger([row, row])

    await expect(validateXtermParityLedger(wrongSchema, validationRoot)).rejects.toThrow(
      'Unsupported parity schema version',
    )
    await expect(validateXtermParityLedger(inconsistentTotal, validationRoot)).rejects.toThrow(
      'Parity inventory total is 2; generated rows contain 1',
    )
    await expect(validateXtermParityLedger(inconsistentApi, validationRoot)).rejects.toThrow(
      'Parity inventory api is 0; generated rows contain 1',
    )
    await expect(validateXtermParityLedger(duplicate, validationRoot)).rejects.toThrow(
      'Duplicate parity row id',
    )
  })

  it('rejects malformed status, ownership, and required row fields', async () => {
    const invalidStatus = fixtureLedger([
      fixtureRow({ targetStatus: 'unknown' as XtermParityRow['targetStatus'] }),
    ])
    const invalidOwner = fixtureLedger([fixtureRow({ ownerPlan: '999' })])
    const emptySymbol = fixtureLedger([fixtureRow({ symbol: '' })])

    await expect(validateXtermParityLedger(invalidStatus, validationRoot)).rejects.toThrow(
      'has invalid status unknown',
    )
    await expect(validateXtermParityLedger(invalidOwner, validationRoot)).rejects.toThrow(
      'has unknown owner plan 999',
    )
    await expect(validateXtermParityLedger(emptySymbol, validationRoot)).rejects.toThrow(
      'has an empty required field',
    )
  })

  it('requires compatible evidence and verifies every evidence path', async () => {
    const noEvidence = fixtureLedger([fixtureRow({ targetStatus: 'compatible' })])
    const missingEvidence = fixtureLedger([
      fixtureRow({ evidence: ['missing-evidence.test.ts'], targetStatus: 'compatible' }),
    ])
    await writeFile(join(validationRoot, 'evidence.test.ts'), 'export {}\n')
    const validEvidence = fixtureLedger([
      fixtureRow({ evidence: ['evidence.test.ts'], targetStatus: 'compatible' }),
    ])

    await expect(validateXtermParityLedger(noEvidence, validationRoot)).rejects.toThrow(
      'has no evidence',
    )
    await expect(validateXtermParityLedger(missingEvidence, validationRoot)).rejects.toThrow(
      'evidence path is missing: missing-evidence.test.ts',
    )
    await expect(validateXtermParityLedger(validEvidence, validationRoot)).resolves.toBeUndefined()
  })

  it('requires reasons for exclusions and rejects unresolved rows owned by DONE plans', async () => {
    const unexplained = fixtureLedger([fixtureRow({ targetStatus: 'not-applicable' })])
    const hiddenRelease = fixtureLedger([
      fixtureRow({ notes: 'Excluded.', targetStatus: 'not-applicable' }),
    ])

    await expect(validateXtermParityLedger(unexplained, validationRoot)).rejects.toThrow(
      'has no reason',
    )
    await expect(validateXtermParityLedger(hiddenRelease, validationRoot)).rejects.toThrow(
      'cannot be not-applicable',
    )

    await writePlanStatus('DONE')
    await expect(validateXtermParityLedger(fixtureLedger(), validationRoot)).rejects.toThrow(
      'DONE Plan 008 still owns missing row',
    )
  })

  it.each(['SUPERSEDED', 'DEFERRED', 'RETIRED'] as const)(
    'preserves unresolved rows owned by a %s plan',
    async (status) => {
      await writePlanStatus(status)
      const ledger = fixtureLedger([
        fixtureRow({ id: 'api:missing', targetStatus: 'missing' }),
        fixtureRow({ id: 'api:partial', targetStatus: 'partial' }),
        fixtureRow({ id: 'api:blocked', targetStatus: 'blocked' }),
      ])

      await expect(validateXtermParityLedger(ledger, validationRoot)).resolves.toBeUndefined()
    },
  )

  it('uses the exported parity error type for validation failures', async () => {
    const invalid = fixtureLedger([fixtureRow({ targetStatus: 'compatible' })])
    await expect(validateXtermParityLedger(invalid, validationRoot)).rejects.toBeInstanceOf(
      XtermParityError,
    )
  })
})
