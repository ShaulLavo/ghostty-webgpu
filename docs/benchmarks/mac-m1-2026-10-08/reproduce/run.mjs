import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { resolve, join } from 'node:path'

const { values } = parseArgs({
  options: {
    case: { type: 'string' },
    output: { type: 'string' },
    browser: { type: 'string' },
    port: { type: 'string' },
    'prepare-only': { type: 'boolean', default: false },
  },
})
assert(
  values.case && values.output && values.port,
  'Supply --case, --output and a free loopback --port',
)
assert(/^[a-z-]+$/.test(values.case), 'Use a case name from scores.json')
const port = Number(values.port)
assert(Number.isSafeInteger(port) && port > 0 && port < 65536)
if (!values['prepare-only']) {
  assert.equal(process.platform, 'darwin', 'Energy acquisition requires macOS RUSAGE_INFO_V6')
  assert(values.browser, 'Supply --browser with the Chrome 154.0.8037.93 executable')
}
const root = import.meta.dirname
const readJson = async (path) => JSON.parse(await readFile(path))
const result = await readJson(join(root, '..', `${values.case}.json`))
const assets = await readJson(join(root, 'assets.json'))
const capsule = assets.capsules[result.capsule]
assert(capsule, 'Frozen capsule unavailable')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const output = resolve(values.output)
await mkdir(output, { recursive: false })
const packet = join(output, 'packet')
await mkdir(packet)
for (const archive of ['common.tgz', capsule.browserArchive]) {
  const path = join(root, 'assets', archive)
  assert.equal(sha(await readFile(path)), assets.archives[archive])
  execFileSync('tar', ['-xzf', path, '-C', packet], { stdio: 'inherit' })
}
const files = {}
for (const [name, digest] of Object.entries({
  ...assets.common,
  'browser.js': capsule.browserSha256,
})) {
  assert.equal(sha(await readFile(join(packet, name))), digest)
  files[`packet/${name}`] = digest
}
const protocol = { ...result.protocol, port }
await writeFile(join(output, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n')
await writeFile(
  join(output, 'bundle.json'),
  JSON.stringify(
    { runtimeCommit: capsule.runtimeCommit, bundleSha256: capsule.browserSha256 },
    null,
    2,
  ) + '\n',
)
await writeFile(join(output, 'seal.json'), JSON.stringify({ files }, null, 2) + '\n')
await writeFile(
  join(output, 'recipe.json'),
  JSON.stringify(
    {
      browserVersion: result.browserVersion,
      browserExecutable: values.browser,
      browserLaunchArguments: result.browserLaunchArguments,
    },
    null,
    2,
  ) + '\n',
)
const driverRoot = join(root, result.capsule)
const measurementSource = {}
for (const name of await readdir(driverRoot))
  measurementSource[name] = sha(await readFile(join(driverRoot, name)))
await writeFile(
  join(output, 'publication-adapter.json'),
  JSON.stringify(
    {
      originalIndexSha256: result.originalIndexSha256,
      originalProtocolSha256: result.protocolSha256,
      originalManifestSha256: capsule.originalManifestSha256,
      originalSealSha256: capsule.originalSealSha256,
      driverOriginalSha256: capsule.driverOriginalSha256,
      measurementSource,
      changes: [
        'Caller-supplied browser executable, output directory and free loopback port',
        'Playwright resolved from the pinned local tool package',
        'Python reader resolved beside measurement source',
        'Private acquisition paths omitted from public protocol',
        'Seal verifies only the packaged runtime assets; new run records adapter and measurement-source hashes',
      ],
    },
    null,
    2,
  ) + '\n',
)
console.log(`Prepared frozen ${result.capsule} for ${values.case} in ${output}`)
if (!values['prepare-only']) {
  const run = spawnSync(
    process.execPath,
    [join(driverRoot, 'driver.mjs'), output, join(output, 'protocol.json')],
    { stdio: 'inherit' },
  )
  assert.equal(run.signal, null, 'Measurement process interrupted')
  process.exitCode = run.status ?? 1
}
