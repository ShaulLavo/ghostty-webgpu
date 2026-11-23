import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { expect, it } from 'vitest'

const distDir = fileURLToPath(new URL('../../dist/', import.meta.url))
const workerDir = resolve(distDir, 'worker')

function staticClosure(entry: string): string[] {
  const pending = new Set([resolve(workerDir, entry)])
  for (const file of pending) {
    const source = readFileSync(file, 'utf8')
    const { errors, module } = parseSync(file, source)
    expect(errors, file).toEqual([])
    const imports = module.staticImports.map(({ moduleRequest }) => moduleRequest.value)
    const reexports = module.staticExports.flatMap(({ entries }) =>
      entries.map(({ moduleRequest }) => moduleRequest?.value),
    )
    for (const specifier of reexports.concat(imports)) {
      if (!specifier?.startsWith('.')) continue
      pending.add(resolve(dirname(file), specifier))
    }
  }
  return Array.from(pending)
}

function dynamicChunkFiles(entry: string): string[] {
  const file = resolve(workerDir, entry)
  const source = readFileSync(file, 'utf8')
  const { errors, module } = parseSync(file, source)
  expect(errors, file).toEqual([])
  const chunks = new Set<string>()
  for (const entryImport of module.dynamicImports) {
    const raw = source.slice(entryImport.moduleRequest.start, entryImport.moduleRequest.end)
    if (!raw.startsWith('"./') && !raw.startsWith("'./")) continue
    chunks.add(resolve(dirname(file), raw.slice(1, -1)))
  }
  return Array.from(chunks)
}

it('splits WebGPU and WebGL renderers out of the static worker entry bundle', () => {
  const staticFiles = staticClosure('entry.js')
  const staticSource = staticFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
  const domFitSource = readFileSync(resolve(distDir, 'dom/fit.js'), 'utf8')

  // Guard minification-surviving browser globals so accidental DOM fit imports fail.
  expect(domFitSource).toContain('ResizeObserver')
  expect(domFitSource).toContain('getComputedStyle')
  expect(staticSource).not.toContain('ResizeObserver')
  expect(staticSource).not.toContain('getComputedStyle')
  expect(staticSource).not.toContain('dppx')
  expect(staticSource).not.toContain('#version 300 es')
  expect(staticSource).not.toContain('getPreferredCanvasFormat')
  expect(staticSource).not.toContain('createRenderPipeline')

  const staticSet = new Set(staticFiles)
  const lazyChunks = dynamicChunkFiles('entry.js').filter((file) => !staticSet.has(file))
  const webgpuChunks = lazyChunks.filter((file) => {
    const source = readFileSync(file, 'utf8')
    return source.includes('getPreferredCanvasFormat') && source.includes('createRenderPipeline')
  })
  const webglChunks = lazyChunks.filter((file) =>
    readFileSync(file, 'utf8').includes('#version 300 es'),
  )

  expect(webgpuChunks).toHaveLength(1)
  expect(webglChunks).toHaveLength(1)
  expect(webgpuChunks[0]).not.toBe(webglChunks[0])
  expect(readFileSync(webgpuChunks[0]!, 'utf8')).not.toContain('#version 300 es')
  expect(readFileSync(webglChunks[0]!, 'utf8')).not.toContain('createRenderPipeline')
})
