import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { corpus, fixtureNames, fixtureText, settings, variants } from '../bench/comparison-fixtures'

const root = resolve(import.meta.dirname, '..')
const output = resolve(process.argv[2] ?? join(root, '.artifacts/comparison-bundle'))
const require = createRequire(join(root, 'package.json'))
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
await mkdir(output, { recursive: true })
const build = await Bun.build({
  entrypoints: [join(root, 'bench/comparison-entry.ts')],
  target: 'browser',
  format: 'esm',
  outdir: output,
  naming: 'browser.js',
  external: ['@xterm/xterm', '@xterm/addon-webgl', 'ghostty-web'],
})
assert(build.success, JSON.stringify(build.logs))
const assets = {
  'native.wasm': join(root, 'ghostty-vt.wasm'),
  'bridge.wasm': join(root, 'bridge.wasm'),
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
  'logs.txt': join(root, 'bench/fixtures/git-history.txt'),
}
const hashes: Record<string, string> = {}
for (const [name, path] of Object.entries(assets)) {
  await copyFile(path, join(output, name))
  hashes[name] = hash(await readFile(path))
}
for (const name of [
  'comparison-runner.mjs',
  'comparison-report.mjs',
  'comparison-pixels.mjs',
  'comparison-guards.mjs',
  'comparison-trace.mjs',
  'comparison-attribution.mjs',
  'comparison-options.mjs',
]) {
  await copyFile(join(root, 'scripts', name), join(output, name))
  hashes[name] = hash(await readFile(join(output, name)))
}
const logs = await readFile(assets['logs.txt'], 'utf8')
const fixtures = fixtureNames.map((name) => {
  const text = corpus(fixtureText(name, logs), settings.corpusBytes)
  return { name, bytes: Buffer.byteLength(text), sha256: hash(text) }
})
const versions = Object.fromEntries(
  [
    '@xterm/xterm',
    '@xterm/addon-webgl',
    'ghostty-web',
    '@fontsource/jetbrains-mono',
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
versions['ghostty-webgpu'] = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const sourceFiles = execFileSync(
  'git',
  [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    'src',
    'bench',
    'scripts/comparison*',
    'scripts/build-comparison.ts',
  ],
  { cwd: root, encoding: 'utf8' },
)
  .trim()
  .split('\n')
const sourceHash = createHash('sha256')
for (const path of sourceFiles) {
  sourceHash.update(path)
  sourceHash.update(await readFile(join(root, path)))
}
const manifest = {
  schema: 1,
  commit,
  dirty: execFileSync('git', ['status', '--porcelain', '--', '.'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  sourceSha256: sourceHash.digest('hex'),
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
      dependencies: { playwright: versions.playwright, pngjs: '7.0.0', ws: versions.ws },
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
console.log(`Portable comparison bundle: ${output}`)
