import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const instrumentation = fileURLToPath(
  new URL('../../../../scripts/ghostty-extension-allocations.ts', import.meta.url),
)
const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0

const entry = `
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Terminal } from ${JSON.stringify(join(packageRoot, 'src/dom/terminal.ts'))}
const owned = globalThis
const keys = new Set()
let counts
let watch = false
let scope
const originalGet = WeakMap.prototype.get
const originalSet = WeakMap.prototype.set
WeakMap.prototype.get = function(key) {
  if (watch && keys.has(key)) counts.lookups++
  return originalGet.call(this, key)
}
WeakMap.prototype.set = function(key, value) {
  if (watch && keys.has(key)) counts.insertions++
  return originalSet.call(this, key, value)
}
function reset() {
  counts = { lookups: 0, insertions: 0, attachments: 0, publications: 0,
    extensionReads: 0, contributionReads: 0, traversal: 0 }
  owned.__extensionOwned = Object.create(null)
}
function capture() { return { counts: { ...counts }, factories: { ...owned.__extensionOwned } } }
function extension(installed) {
  const contributions = new Proxy({}, {
    get(target, key, receiver) {
      if (watch) {
        if (key === 'api') counts.publications++
        if (installed) counts.contributionReads++
      }
      return Reflect.get(target, key, receiver)
    },
    ownKeys(target) {
      if (watch && installed) counts.contributionReads++
      return Reflect.ownKeys(target)
    },
  })
  const value = new Proxy({
    name: 'inert',
    setup(current) {
      scope = current
      if (watch) counts.attachments++
      if (installed) {
        for (const key of ['previous', 'next']) {
          let linked = current[key]
          Object.defineProperty(current, key, {
            configurable: true,
            get() { if (watch) counts.traversal++; return linked },
            set(value) { linked = value },
          })
        }
      }
      return contributions
    },
  }, {
    get(target, key, receiver) {
      if (watch && installed) counts.extensionReads++
      return Reflect.get(target, key, receiver)
    },
    ownKeys(target) {
      if (watch && installed) counts.extensionReads++
      return Reflect.ownKeys(target)
    },
  })
  keys.add(value)
  return value
}
const rows = []
try {
  for (const inert of [0, 1, 100, 1000]) {
    const values = Array.from({ length: inert }, () => extension(true))
    reset(); watch = true
    const terminal = await Terminal.create({ extensions: values, runtime: {
      kind: 'owned', options: {
        wasm: pathToFileURL(process.argv[3]), bridge: pathToFileURL(process.argv[4]),
      },
    } })
    watch = false
    const creation = capture()
    try {
      assert.equal(terminal.lifecycle, 'created')
      const seed = terminal.use(extension(false)); seed.dispose()
      reset()
      for (let index = 0; index < 32; index++) {
        const target = extension(false)
        watch = true
        const handle = terminal.use(target)
        watch = false
        assert.equal(handle, scope)
        assert.equal(handle.disposed, false)
        handle.dispose()
        assert.equal(handle.disposed, true)
      }
      rows.push({ inert, creation, freshUse: capture() })
    } finally { watch = false; terminal.dispose() }
  }
} finally {
  WeakMap.prototype.get = originalGet
  WeakMap.prototype.set = originalSet
}
await writeFile(process.argv[2], JSON.stringify(rows))
`

const build = `
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { instrumentAllocations } from ${JSON.stringify(instrumentation)}
const root = process.argv[2]
let source = await readFile(${JSON.stringify(join(packageRoot, 'src/extensions/manager.ts'))}, 'utf8')
if (process.argv[3] === 'scan') {
  const boundary = '      const contributions = extension.setup(attachment)'
  assert.equal(source.split(boundary).length, 2)
  source = source.replace(boundary, boundary + '\\n      for (let owner = attachment.previous; owner; owner = owner.previous) { void ({ owner }) }')
}
const instrumented = instrumentAllocations(source)
const result = await Bun.build({
  entrypoints: [join(root, 'entry.ts')], outdir: root, naming: 'entry.mjs',
  target: 'node', format: 'esm', plugins: [{ name: 'manager-factory-counters', setup(builder) {
    builder.onLoad({ filter: /\\/extensions\\/manager\\.ts$/ }, () => ({ contents: instrumented.source, loader: 'ts' }))
  } }],
})
assert(result.success, result.logs.map(String).join('\\n'))
`

type Snapshot = {
  counts: Record<string, number>
  factories: Record<string, number>
}
type Row = { inert: number; creation: Snapshot; freshUse: Snapshot }

function factoryTotal(snapshot: Snapshot): number {
  return Object.values(snapshot.factories).reduce((sum, value) => sum + value, 0)
}

function verifyWork(rows: readonly Row[]) {
  const baseline = rows.find((row) => row.inert === 0)!
  const single = rows.find((row) => row.inert === 1)!
  expect(rows.map((row) => row.inert)).toEqual([0, 1, 100, 1000])
  expect(factoryTotal(baseline.freshUse)).toBe(32 * 3)
  const sites = new Set(rows.flatMap((row) => Object.keys(row.creation.factories)))
  const activation = new Map<string, number>()
  for (const site of sites) {
    const perExtension = (baseline.freshUse.factories[site] ?? 0) / 32
    const fixed =
      (single.creation.factories[site] ?? 0) -
      (baseline.creation.factories[site] ?? 0) -
      perExtension
    expect(fixed, site).toBeGreaterThanOrEqual(0)
    activation.set(site, fixed)
  }
  expect([...activation.values()].reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0)
  for (const row of rows) {
    expect(row.creation.counts).toEqual({
      lookups: row.inert,
      insertions: row.inert,
      attachments: row.inert,
      publications: row.inert,
      extensionReads: row.inert,
      contributionReads: row.inert * 6,
      traversal: 0,
    })
    expect(row.freshUse.counts).toEqual({
      lookups: 32,
      insertions: 32,
      attachments: 32,
      publications: 32,
      extensionReads: 0,
      contributionReads: 0,
      traversal: 0,
    })
    expect(row.freshUse.factories).toEqual(baseline.freshUse.factories)
    for (const site of sites) {
      const expected =
        (baseline.creation.factories[site] ?? 0) +
        (row.inert > 0 ? activation.get(site)! : 0) +
        (row.inert * (baseline.freshUse.factories[site] ?? 0)) / 32
      expect(row.creation.factories[site] ?? 0, site).toBe(expected)
    }
  }
}

it.skipIf(!bunAvailable || !existsSync(instrumentation))(
  'keeps public fresh-use work constant and creation factories affine (requires Bun and Fregat instrumentation)',
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'extension-work-'))
    try {
      await writeFile(join(scratch, 'entry.ts'), entry)
      await writeFile(join(scratch, 'build.ts'), build)
      for (const mutation of ['baseline', 'scan']) {
        const built = spawnSync('bun', [join(scratch, 'build.ts'), scratch, mutation], {
          cwd: packageRoot,
          encoding: 'utf8',
          timeout: 20_000,
        })
        expect(built.error, built.stderr).toBeUndefined()
        expect(built.status, built.stdout + built.stderr).toBe(0)
        const report = join(scratch, 'counts.json')
        const run = spawnSync(
          process.execPath,
          [
            join(scratch, 'entry.mjs'),
            report,
            join(packageRoot, 'ghostty-vt.wasm'),
            join(packageRoot, 'bridge.wasm'),
          ],
          { cwd: packageRoot, encoding: 'utf8', timeout: 20_000 },
        )
        expect(run.error, run.stderr).toBeUndefined()
        expect(run.status, run.stdout + run.stderr).toBe(0)
        const rows = JSON.parse(await readFile(report, 'utf8')) as Row[]
        if (mutation === 'baseline') {
          verifyWork(rows)
          continue
        }
        const zero = factoryTotal(rows[0]!.creation)
        const slope = factoryTotal(rows[0]!.freshUse) / 32
        const activation = factoryTotal(rows[1]!.creation) - zero - slope
        for (const inert of [100, 1000]) {
          const row = rows.find((row) => row.inert === inert)!
          expect(row.creation.counts.traversal).toBe((inert * (inert + 1)) / 2)
          expect(factoryTotal(row.creation) - zero - activation - inert * slope).toBe(
            (inert * (inert - 1)) / 2,
          )
        }
        expect(() => verifyWork(rows)).toThrow()
      }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  },
  60_000,
)
