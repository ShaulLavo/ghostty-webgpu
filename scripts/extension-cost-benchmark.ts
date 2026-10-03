import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(packageRoot, '..')
const output = process.argv[2]
assert(output, 'Usage: bun scripts/extension-cost-benchmark.ts <new-evidence-directory> [--check]')
const mode = process.argv[3]
assert(mode === undefined || mode === '--check', 'The optional argument must be --check')
const directory = resolve(output)
await mkdir(directory)
const entry = join(packageRoot, 'bench/extension-cost-entry.ts')
const build = await Bun.build({
  entrypoints: [entry],
  target: 'node',
  format: 'esm',
  minify: false,
  sourcemap: 'external',
  outdir: directory,
  naming: 'frozen-entry.mjs',
})
assert(build.success, build.logs.map(String).join('\n'))
for (const artifact of ['ghostty-vt.wasm', 'bridge.wasm']) {
  await copyFile(join(packageRoot, artifact), join(directory, artifact))
}
await copyFile(fileURLToPath(import.meta.url), join(directory, 'runner.ts'))
const files = [
  'frozen-entry.mjs',
  'frozen-entry.mjs.map',
  'ghostty-vt.wasm',
  'bridge.wasm',
  'runner.ts',
]
const hashes = Object.fromEntries(
  await Promise.all(
    files.map(async (name) => [
      name,
      createHash('sha256')
        .update(await readFile(join(directory, name)))
        .digest('hex'),
    ]),
  ),
)
const git = (...args: string[]) =>
  execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim()
await writeFile(
  join(directory, 'source-diff.patch'),
  execFileSync('git', ['-C', checkout, 'diff', 'HEAD', '--binary']),
)
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      head: git('rev-parse', 'HEAD'),
      status: git('status', '--short'),
      node: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
      bun: Bun.version,
      scope: 'manager-only native Node checkpoint; no public activation, browser or paint endpoint',
      files: hashes,
    },
    null,
    2,
  ),
)
const args = ['--expose-gc', join(directory, 'frozen-entry.mjs'), directory]
if (mode) args.push(mode)
const child = spawn('node', args, { stdio: 'inherit' })
const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
  child.once('exit', (code, signal) => done({ code, signal }))
})
await writeFile(
  join(directory, 'exit.json'),
  JSON.stringify({ endedAt: new Date().toISOString(), ...exit }, null, 2),
)
assert.equal(exit.code, 0, 'The frozen benchmark failed; preserve its directory')
