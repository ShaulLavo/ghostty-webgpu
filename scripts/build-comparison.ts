import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import {
  corpus,
  fixtureNames,
  fixtureText,
  isRollingFixture,
  rollingFixture,
  settings,
  variants,
} from '../bench/comparison-fixtures'
import {
  assetMap,
  checkoutFiles,
  comparisonBuildArguments,
  framedInputHash,
  runtimeCheckoutFiles,
  runtimeSource,
  sha256 as hash,
  sourceInventory,
} from '../bench/comparison-build'
import { comparisonSourceHash } from './comparison-source'

const root = resolve(import.meta.dirname, '..')
const { output, ref } = comparisonBuildArguments(
  process.argv.slice(2),
  join(root, '.artifacts/comparison-bundle'),
)
const require = createRequire(join(root, 'package.json'))
await mkdir(output, { recursive: true })
const benchmarkPatterns = ['bench', 'scripts/comparison*', 'scripts/build-comparison.ts']
const benchmark = await sourceInventory(root, checkoutFiles(root, benchmarkPatterns))
const runtime = await runtimeSource(root, ref)
try {
  const checkoutSourceSha256 = await comparisonSourceHash(root, ref)
  const build = await Bun.build({
    entrypoints: [join(root, 'bench/comparison-entry.ts')],
    target: 'browser',
    format: 'esm',
    // Archive staging paths must not become bundle source comments.
    minify: { whitespace: true, syntax: false, identifiers: false },
    outdir: output,
    naming: 'browser.js',
    external: ['@xterm/xterm', '@xterm/addon-webgl', 'ghostty-web'],
    plugins: runtime.plugins,
  })
  assert(build.success, JSON.stringify(build.logs))
  const logsPath = join(root, 'bench/fixtures/git-history.txt')
  const assets = assetMap([
    ...Object.entries(runtime.assets),
    ...Object.entries({
      'legacy.wasm': join(dirname(require.resolve('ghostty-web')), 'ghostty-vt.wasm'),
      'font.woff2':
        require.resolve('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2'),
      'font-bold.woff2':
        require.resolve('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2'),
      'font-license.txt': join(
        dirname(require.resolve('@fontsource/jetbrains-mono/package.json')),
        'LICENSE',
      ),
      'xterm.css': require.resolve('@xterm/xterm/css/xterm.css'),
      'xterm.mjs': join(dirname(require.resolve('@xterm/xterm')), 'xterm.mjs'),
      'addon-webgl.mjs': join(dirname(require.resolve('@xterm/addon-webgl')), 'addon-webgl.mjs'),
      'ghostty-web.mjs': join(dirname(require.resolve('ghostty-web')), 'ghostty-web.js'),
      '__vite-browser-external-2447137e.js': join(
        dirname(require.resolve('ghostty-web')),
        '__vite-browser-external-2447137e.js',
      ),
      'logs.txt': logsPath,
    }),
  ])
  const hashes: Record<string, string> = {}
  for (const [name, path] of Object.entries(assets)) {
    await mkdir(dirname(join(output, name)), { recursive: true })
    await copyFile(path, join(output, name))
    hashes[name] = hash(await readFile(path))
  }
  for (const name of [
    'comparison-runner.mjs',
    'comparison-browser-temp.mjs',
    'comparison-artifact.mjs',
    'comparison-report.mjs',
    'comparison-compact.mjs',
    'comparison-pixels.mjs',
    'comparison-guards.mjs',
    'comparison-counters.mjs',
    'comparison-rusage.py',
    'comparison-perf.py',
    'comparison-trace.mjs',
    'comparison-attribution.mjs',
    'comparison-options.mjs',
    'comparison-latency.mjs',
    'comparison-render.mjs',
    'comparison-gpu.mjs',
    'comparison-mac.mjs',
    'comparison-diagnostics.mjs',
  ]) {
    await copyFile(join(root, 'scripts', name), join(output, name))
    hashes[name] = hash(await readFile(join(output, name)))
  }
  const logs = await readFile(logsPath, 'utf8')
  const fixtures = fixtureNames.map((name) => {
    const text = corpus(fixtureText(name, logs), settings.corpusBytes)
    const chunks = isRollingFixture(name)
      ? rollingFixture(logs, settings.corpusBytes, settings.chunkBytes, name).chunks
      : [new TextEncoder().encode(corpus(fixtureText(name, logs), settings.chunkBytes))]
    let strategy = 'repeat-unit-v1'
    if (isRollingFixture(name))
      strategy = name === 'rolling-slow' ? 'rolling-complete-lines-v1' : 'rolling-utf8-chunks-v1'
    return {
      name,
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
      stream: {
        strategy,
        reset: 'corpus-start',
        sha256: framedInputHash(chunks),
        hashFormat: 'sha256(decimal-byte-length + NUL + chunk-bytes, per frame in one cycle)',
        framesPerCycle: chunks.length,
        bytesPerCycle: chunks.reduce((total, chunk) => total + chunk.length, 0),
        chunkByteLengths: chunks.map((chunk) => chunk.length),
      },
    }
  })
  const versions = Object.fromEntries(
    [
      '@xterm/xterm',
      '@xterm/addon-webgl',
      'ghostty-web',
      '@fontsource/jetbrains-mono',
      '@discoveryjs/json-ext',
      'playwright',
      'ws',
    ].map((name) => {
      const path = require.resolve(`${name}/package.json`)
      return [
        name,
        JSON.parse(
          execFileSync(
            process.execPath,
            [
              '-e',
              `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)},'utf8'))`,
            ],
            { encoding: 'utf8' },
          ),
        ).version,
      ]
    }),
  )
  versions['ghostty-webgpu'] = runtime.version
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(
    (await sourceInventory(root, checkoutFiles(root, benchmarkPatterns))).sha256,
    benchmark.sha256,
    'Benchmark sources changed during the build; rebuild from stable sources',
  )
  if (!ref)
    assert.equal(
      (await sourceInventory(root, await runtimeCheckoutFiles(root))).sha256,
      runtime.inventory.sha256,
      'Runtime inputs changed during the build; rebuild from stable inputs',
    )
  const manifest = {
    schema: 1,
    builder: { bun: Bun.version, revision: Bun.revision },
    sourceInventoryHashFormat: 'sha256(sorted relative path + NUL + file bytes + NUL, per file)',
    commit,
    dirty: execFileSync('git', ['status', '--porcelain', '--', '.'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    checkoutSourceSha256,
    sourceSha256: hash(`runtime\0${runtime.inventory.sha256}\0benchmark\0${benchmark.sha256}`),
    sourceHashFormat:
      'sha256(runtime + NUL + runtime.sha256 + NUL + benchmark + NUL + benchmark.sha256)',
    runtime: {
      mode: runtime.mode,
      ref,
      commit: runtime.commit,
      dirty: runtime.dirty,
      version: runtime.version,
      sourceSha256: runtime.inventory.sha256,
      files: runtime.inventory.files,
    },
    benchmark: {
      commit,
      sourceSha256: benchmark.sha256,
      files: benchmark.files,
    },
    bundleSha256: hash(await readFile(join(output, 'browser.js'))),
    versions,
    settings,
    variants,
    fixtures,
    assets: hashes,
    logs: {
      kind: 'real Git history log',
      repository: 'ShaulLavo/fregat',
      revision: '5d98d10f4',
      entries: 256,
    },
  }
  await writeFile(
    join(output, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        scripts: {
          smoke: 'node comparison-runner.mjs --smoke',
          compare: 'node comparison-runner.mjs',
        },
        dependencies: {
          playwright: versions.playwright,
          pngjs: '7.0.0',
          ws: versions.ws,
          '@discoveryjs/json-ext': versions['@discoveryjs/json-ext'],
        },
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(
    join(output, 'index.html'),
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css">
<script type="importmap">{"imports":{"@xterm/xterm":"/xterm.mjs","@xterm/addon-webgl":"/addon-webgl.mjs","ghostty-web":"/ghostty-web.mjs"}}</script>
<style>
@font-face{font-family:'Bench Mono';src:url('/font.woff2');font-weight:400}
@font-face{font-family:'Bench Mono';src:url('/font-bold.woff2');font-weight:700}
body{margin:0;background:#000;color:#fff}main{display:grid;grid-template-columns:repeat(4,380px);gap:8px}section{width:380px;height:260px;overflow:hidden}
</style><main></main><script type="module" src="/browser.js"></script>`,
  )
  hashes['index.html'] = hash(await readFile(join(output, 'index.html')))
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
} finally {
  await runtime.dispose()
}
console.log(`Portable comparison bundle: ${output}`)
