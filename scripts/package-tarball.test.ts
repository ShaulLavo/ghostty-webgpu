import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

let root: string
const helper = join(import.meta.dirname, 'package-smoke.ts')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ghostty-pack-stage-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('default packing runs prepack once and resolves only family catalog ranges in an isolated production stage', async () => {
  const source = join(root, 'family')
  const workspace = join(root, 'work')
  await mkdir(source)
  await mkdir(workspace)
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ workspaces: { packages: ['family'], catalog: { '@fixture/core': '0.0.2' } } }),
  )
  const manifest = {
    name: 'ghostty-pack-fixture',
    version: '0.0.1',
    type: 'module',
    repository: { type: 'git', url: 'https://example.invalid/source.git' },
    files: ['dist', 'LICENSE', 'native/tool', 'native/absent'],
    exports: { '.': './dist/index.js' },
    workspaces: {
      packages: [],
      catalog: { '@fixture/core': 'https://example.invalid/frozen-core.tgz' },
    },
    dependencies: { '@fixture/core': 'catalog:', unchanged: '1.2.3' },
    scripts: { prepack: 'bun prepack.ts' },
  }
  const original = JSON.stringify(manifest, null, 2) + '\n'
  await writeFile(join(source, 'package.json'), original)
  await writeFile(join(source, 'LICENSE'), 'fixture license')
  await mkdir(join(source, 'native'))
  await writeFile(join(source, 'native/tool'), 'fixture executable')
  await chmod(join(source, 'native/tool'), 0o755)
  await writeFile(join(source, 'private-workload'), 'excluded')
  await writeFile(
    join(source, 'prepack.ts'),
    `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const count=existsSync('prepack-count')?Number(readFileSync('prepack-count','utf8')):0;
writeFileSync('prepack-count',String(count+1));mkdirSync('dist',{recursive:true});writeFileSync('dist/index.js','export const answer=42');`,
  )
  const script = `import { createTarball } from ${JSON.stringify(helper)}; console.log(await createTarball(${JSON.stringify(workspace)},${JSON.stringify(source)}));`
  const result = spawnSync('bun', ['--eval', script], {
    cwd: source,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      npm_config_omit: 'dev',
      NPM_CONFIG_OMIT: 'dev',
      npm_config_cache: join(root, 'npm-cache'),
      NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    },
  })
  expect(result.status, result.stderr).toBe(0)
  expect(await readFile(join(source, 'prepack-count'), 'utf8')).toBe('1')
  expect(await readFile(join(source, 'package.json'), 'utf8')).toBe(original)
  const tarball = result.stdout.trim()
  const unpacked = join(root, 'unpacked')
  await mkdir(unpacked)
  const extraction = spawnSync('tar', ['-xzf', tarball, '-C', unpacked], { encoding: 'utf8' })
  expect(extraction.status, extraction.stderr).toBe(0)
  const packed = JSON.parse(await readFile(join(unpacked, 'package/package.json'), 'utf8'))
  expect(packed).toEqual({
    ...manifest,
    dependencies: {
      ...manifest.dependencies,
      '@fixture/core': manifest.workspaces.catalog['@fixture/core'],
    },
  })
  expect(await readFile(join(unpacked, 'package/dist/index.js'), 'utf8')).toBe(
    'export const answer=42',
  )
  expect((await stat(join(unpacked, 'package/native/tool'))).mode & 0o777).toBe(0o755)
  expect(spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).stdout).not.toContain(
    'private-workload',
  )
}, 20_000)
