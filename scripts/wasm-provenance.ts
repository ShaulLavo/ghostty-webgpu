import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GHOSTTY_SOURCE_REPOSITORY, GHOSTTY_SOURCE_REVISION } from '../src/core/version.js'
import { ArtifactBuildError } from './ghostty-source.js'

export const WASM_BUILD_INPUTS = [
  'scripts/build-wasm.ts',
  'scripts/bridge.zig',
  'scripts/snapshot.zig',
  'scripts/glyph-index.zig',
  'scripts/ghostty-source.ts',
  'scripts/wasm-provenance.ts',
  'src/core/version.ts',
] as const

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function output(command: string[], cwd: string): Promise<Uint8Array> {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'inherit' })
  const bytes = new Uint8Array(await new Response(process.stdout).arrayBuffer())
  if ((await process.exited) === 0) return bytes
  throw new ArtifactBuildError(`Unable to record ${command[0]} build provenance`)
}

export async function recordWasmProvenance(source: string, zig: string): Promise<void> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const decoder = new TextDecoder()
  const version = decoder.decode(await output([zig, 'version'], root)).trim()
  const environment = decoder.decode(await output([zig, 'env'], root))
  const executable = environment.match(/\.zig_exe\s*=\s*("(?:[^"\\]|\\.)*")/)
  if (!executable?.[1]) throw new ArtifactBuildError('Zig environment is missing zig_exe')
  const tree = decoder.decode(await output(['git', 'rev-parse', 'HEAD^{tree}'], source)).trim()
  const gitArchive = await output(['git', 'archive', '--format=tar', 'HEAD'], source)
  const url = `https://codeload.github.com/ghostty-org/ghostty/tar.gz/${GHOSTTY_SOURCE_REVISION}`
  const response = await fetch(url)
  if (!response.ok)
    throw new ArtifactBuildError(`Official source archive returned ${response.status}`)
  const archive = new Uint8Array(await response.arrayBuffer())
  const inputs = Object.fromEntries(
    await Promise.all(
      WASM_BUILD_INPUTS.map(async (path) => [path, sha256(await readFile(join(root, path)))]),
    ),
  )
  const artifacts = Object.fromEntries(
    await Promise.all(
      ['ghostty-vt.wasm', 'bridge.wasm'].map(async (path) => {
        const bytes = await readFile(join(root, path))
        const module = await WebAssembly.compile(bytes)
        const names = WebAssembly.Module.customSections(module, 'name')
        return [
          path,
          {
            bytes: bytes.length,
            sha256: sha256(bytes),
            nameSectionSha256: names.map((section) => sha256(new Uint8Array(section))),
          },
        ]
      }),
    ),
  )
  await writeFile(
    join(root, 'ghostty-vt.provenance.json'),
    JSON.stringify(
      {
        schema: 1,
        source: {
          repository: GHOSTTY_SOURCE_REPOSITORY,
          revision: GHOSTTY_SOURCE_REVISION,
          tree,
          gitArchiveSha256: sha256(gitArchive),
          officialArchive: { url, bytes: archive.length, sha256: sha256(archive) },
          patched: false,
        },
        compiler: {
          version,
          executableSha256: sha256(await readFile(JSON.parse(executable[1]) as string)),
        },
        recipe: {
          terminal: [
            'zig',
            'build',
            '-Demit-lib-vt=true',
            '-Dtarget=wasm32-freestanding',
            '-Doptimize=ReleaseSmall',
          ],
          bridge: [
            'zig',
            'build-exe',
            'scripts/bridge.zig',
            '-target',
            'wasm32-freestanding',
            '-fno-entry',
            '-rdynamic',
            '--import-memory',
            '--export=__stack_pointer',
            '--stack',
            '65536',
            '-I',
            '<official-source>/include',
            '-O',
            'ReleaseSmall',
          ],
          inputs,
        },
        artifacts,
      },
      null,
      2,
    ) + '\n',
  )
}
