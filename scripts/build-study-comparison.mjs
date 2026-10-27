import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const output = resolve(process.argv[2])
const wraith = resolve(process.env.WRAITH_SOURCE)
const revision = (root) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
assert.equal(revision(wraith), '115106931ce4934db6bc41f4d7939eb80551d248')
execFileSync('bun', ['scripts/build-comparison.ts', output], { stdio: 'inherit' })
await writeFile(
  join(output, 'wraith-entry.ts'),
  `export { Wraith } from ${JSON.stringify(join(wraith, 'packages/wraith/src/index.ts'))}`,
)
for (const [entry, name] of [
  ['index.ts', 'wraith-sdk.js'],
  ['worker.ts', 'worker.js'],
])
  execFileSync(
    'bun',
    [
      'build',
      entry === 'index.ts'
        ? join(output, 'wraith-entry.ts')
        : join(wraith, 'packages/wraith/src', entry),
      '--target',
      'browser',
      '--external',
      '@wraith-terminal/xterm-base/lib/xterm.mjs',
      '--outfile',
      join(output, name),
    ],
    { stdio: 'inherit' },
  )
await writeFile(
  join(output, 'worker.js'),
  (await readFile(new URL('./study-worker-observer.js', import.meta.url), 'utf8')) +
    '\n' +
    (await readFile(join(output, 'worker.js'), 'utf8')),
)
await copyFile(
  join(wraith, 'packages/wraith/wasm/wraith_engine_bg.wasm'),
  join(output, 'wraith_engine_bg.wasm'),
)
await copyFile(join(wraith, 'LICENSE'), join(output, 'wraith-license.txt'))
execFileSync(
  'uv',
  [
    'run',
    '--cache-dir',
    '/work/cache/uv',
    '--with',
    'fonttools[woff]',
    'python',
    '-c',
    'from fontTools.ttLib import TTFont; import sys; f=TTFont(sys.argv[1]); f.flavor=None; f.save(sys.argv[2])',
    join(output, 'font.woff2'),
    join(output, 'font.ttf'),
  ],
  { stdio: 'inherit' },
)
await rm(join(output, 'wraith-entry.ts'))
if (process.env.NM_SOURCE) {
  const nm = resolve(process.env.NM_SOURCE)
  assert.equal(revision(nm), 'bfbe0e5c82b12d1f7cfde9784877fbf3a2c9ddc9')
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(nm, 'ghostty-vt.wasm')))
      .digest('hex'),
    '53e131008bde7744b9244768918f0f22966eaf35f0c2ef53e5209059bab49f27',
  )
  execFileSync('bun', ['install', '--production', '--ignore-scripts', '--frozen-lockfile'], {
    cwd: nm,
    stdio: 'inherit',
  })
  execFileSync(
    'bun',
    [
      'build',
      join(nm, 'lib/index.ts'),
      '--target',
      'browser',
      '--external',
      '@wraith-terminal/xterm-base/lib/xterm.mjs',
      '--outfile',
      join(output, 'nm-sdk.js'),
    ],
    { stdio: 'inherit' },
  )
  await copyFile(join(nm, 'ghostty-vt.wasm'), join(output, 'nm.wasm'))
}
const files = [
  'browser.js',
  'wraith-sdk.js',
  'worker.js',
  'wraith_engine_bg.wasm',
  'font.ttf',
  'font.woff2',
]
if (process.env.NM_SOURCE) files.push('nm-sdk.js', 'nm.wasm')
const hashes = Object.fromEntries(
  await Promise.all(
    files.map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(join(output, name)))
        .digest('hex'),
    ]),
  ),
)
await writeFile(
  join(output, 'study-provenance.json'),
  JSON.stringify(
    {
      wraith: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wraith, encoding: 'utf8' }).trim(),
      nm: process.env.NM_SOURCE
        ? execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: process.env.NM_SOURCE,
            encoding: 'utf8',
          }).trim()
        : null,
      hashes,
    },
    null,
    2,
  ),
)
