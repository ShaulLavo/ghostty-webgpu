import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { nativeStage } from '../../ios-browser-stages.ts'
import type { CaptureOptions } from './official-screenshot.ts'

const element = { selector: '#source-capture-contract', locator: 'source-capture-contract' }

function capture(expression: string, bindings: Record<string, unknown>): CaptureOptions {
  const options: unknown = new Function(...Object.keys(bindings), `return (${expression})`)(
    ...Object.values(bindings),
  )
  assert(isOptions(options))
  return options
}

function isOptions(options: unknown): options is CaptureOptions {
  if (
    !options ||
    typeof options !== 'object' ||
    !('element' in options) ||
    options.element !== element
  )
    return false
  if (!('scale' in options) || (options.scale !== 'css' && options.scale !== 'device')) return false
  if ('path' in options)
    return (
      typeof options.path === 'string' && Object.keys(options).join(',') === 'element,path,scale'
    )
  return (
    'save' in options &&
    options.save === false &&
    Object.keys(options).join(',') === 'element,save,scale'
  )
}

async function sites(file: string, count: number): Promise<string[]> {
  const source = await readFile(file, 'utf8')
  const calls = Array.from(
    source.matchAll(/await page\.screenshot\((\{[\s\S]*?\})\)/g),
    (match) => match[1]!,
  )
  assert.equal(calls.length, count)
  return calls
}

export async function rasterCaptures(): Promise<{ file: string; options: CaptureOptions }[]> {
  const zwj = nativeStage('canvas-zwj').file
  const pixels = nativeStage('pixels').file
  const constraints = nativeStage('glyph-constraints').file
  const sprites = nativeStage('sprites').file
  const fixture = nativeStage('displayed-pixels-fixture').file
  const [zwjSite] = await sites(zwj, 1)
  const [dprSite, clippedSite] = await sites(pixels, 2)
  const [constraintsSite] = await sites(constraints, 1)
  const [spritesSite] = await sites(sprites, 1)
  const helper = new URL('../../../src/render/webgl/tests/fixture.ts', import.meta.url)
  const [deviceSite] = await sites(helper.pathname, 1)
  assert(zwjSite && dprSite && clippedSite && constraintsSite && spritesSite && deviceSite)
  const rows = ['technologist', 'family'].map((name) => ({
    file: zwj,
    options: capture(zwjSite, { native: { container: element }, name }),
  }))
  const dprs = [1, 2].map((dpr) => ({
    file: pixels,
    options: capture(dprSite, { canvas: element, dpr }),
  }))
  const clipped = ['canvas2d-fill-text', 'canvas2d-pixels'].flatMap((rendererMode) =>
    [0, -1].map((letterSpacing) => ({
      file: pixels,
      options: capture(clippedSite, { canvas: element, rendererMode, letterSpacing }),
    })),
  )
  return rows.concat(
    dprs,
    clipped,
    Array.from({ length: 18 }, (_, index) => ({
      file: constraints,
      options: capture(constraintsSite, { section: element, index }),
    })),
    Array.from({ length: 10 }, (_, index) => ({
      file: sprites,
      options: capture(spritesSite, { section: element, index }),
    })),
    [{ file: fixture, options: capture(deviceSite, { canvas: element }) }],
  )
}
