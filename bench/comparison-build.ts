import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { BunPlugin } from 'bun'

export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

export function framedInputHash(chunks: readonly Uint8Array[]): string {
  const digest = createHash('sha256')
  for (const chunk of chunks) digest.update(`${chunk.length}\0`).update(chunk)
  return digest.digest('hex')
}

export async function sourceInventory(root: string, paths: readonly string[]) {
  const files: Record<string, string> = {}
  const digest = createHash('sha256')
  for (const path of [...new Set(paths)].sort()) {
    const bytes = await readFile(join(root, path))
    files[path] = sha256(bytes)
    digest.update(path).update('\0').update(bytes).update('\0')
  }
  return { sha256: digest.digest('hex'), files }
}

export function checkoutFiles(root: string, patterns: readonly string[]): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...patterns],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(Boolean)
}

function runtimePlugin(root: string, extractedRoot: string): BunPlugin {
  const runtimeRoot = join(root, 'src') + sep
  return {
    name: 'comparison-runtime-ref',
    setup(build) {
      build.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        if (!path.startsWith('.') && !isAbsolute(path)) return
        const absolute = resolve(importer ? resolve(importer, '..') : root, path)
        if (!absolute.startsWith(runtimeRoot)) return
        const relative = absolute.slice(root.length + 1).replace(/\.js$/, '.ts')
        return { path: join(extractedRoot, relative) }
      })
    },
  }
}

const runtimeAssets = { 'native.wasm': 'ghostty-vt.wasm', 'bridge.wasm': 'bridge.wasm' }
export const runtimePatterns = ['src', ...Object.values(runtimeAssets), 'package.json']

async function runtimeInputs(root: string, paths: readonly string[]) {
  const metadata: { version?: unknown } = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  )
  assert(
    typeof metadata.version === 'string' && metadata.version.length > 0,
    'Runtime package metadata must contain a version',
  )
  return {
    version: metadata.version,
    assets: Object.fromEntries(
      Object.entries(runtimeAssets).map(([name, path]) => [name, join(root, path)]),
    ),
    inventory: await sourceInventory(root, paths),
  }
}

export async function runtimeSource(root: string, ref?: string) {
  root = resolve(root)
  const git = (args: readonly string[], cwd: string = root) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  if (!ref) {
    return {
      mode: 'checkout' as const,
      commit: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain', '--', ...runtimePatterns]),
      ...(await runtimeInputs(root, checkoutFiles(root, runtimePatterns))),
      plugins: [] as BunPlugin[],
      dispose: async () => {},
    }
  }
  assert(!ref.startsWith('-'), 'Runtime ref must name a Git revision')
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`])
  const prefix = git(['rev-parse', '--show-prefix'])
  const inputPaths = runtimePatterns.map((path) => `${prefix}${path}`)
  const repository = git(['rev-parse', '--show-toplevel'])
  const paths = git(['ls-tree', '-r', '--name-only', commit, '--', ...inputPaths], repository)
    .split('\n')
    .filter(Boolean)
    .map((path) => path.slice(prefix.length))
  assert(
    paths.some((path) => path.startsWith('src/')),
    'Runtime ref must contain runtime src',
  )
  const scratchRoot = join(root, '.artifacts')
  await mkdir(scratchRoot, { recursive: true })
  const scratch = await mkdtemp(join(scratchRoot, 'comparison-runtime-'))
  const dispose = () => rm(scratch, { recursive: true, force: true })
  try {
    const archive = execFileSync('git', ['archive', commit, ...inputPaths], {
      cwd: repository,
      maxBuffer: 32 * 1024 * 1024,
    })
    execFileSync('tar', ['-x', '-f', '-', '-C', scratch], { input: archive })
    const extractedRoot = join(scratch, prefix)
    return {
      mode: 'git-ref' as const,
      ref,
      commit,
      dirty: '',
      ...(await runtimeInputs(extractedRoot, paths)),
      plugins: [runtimePlugin(root, extractedRoot)],
      dispose,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

export function comparisonBuildArguments(args: readonly string[], defaultOutput: string) {
  const refIndex = args.indexOf('--runtime-ref')
  const ref = refIndex < 0 ? undefined : args[refIndex + 1]
  assert(refIndex < 0 || (ref && !ref.startsWith('-')), '--runtime-ref needs a Git revision')
  const outputs = args.filter(
    (_, index) => refIndex < 0 || (index !== refIndex && index !== refIndex + 1),
  )
  assert(
    outputs.length <= 1 && outputs.every((arg) => !arg.startsWith('-')),
    'Expected output directory and optional --runtime-ref',
  )
  return { output: resolve(outputs[0] ?? defaultOutput), ref }
}
