import { afterEach, expect, it, vi } from 'vitest'
import type { TerminalFittedFont } from '../../term/types.js'
import { fittedFont } from '../webgl/tests/fixture.js'
import { acquireSharedAtlas, releaseSharedAtlas } from './atlas-registry.js'
import type { SharedGlyphAtlas } from './shared-atlas.js'

const owners: { owner: object; shared: SharedGlyphAtlas }[] = []
const faces: FontFace[] = []

afterEach(() => {
  for (const { shared, owner } of owners) releaseSharedAtlas(shared, owner)
  owners.length = 0
  for (const face of faces) document.fonts.delete(face)
  faces.length = 0
  vi.restoreAllMocks()
})

function acquire(font: TerminalFittedFont = fittedFont()) {
  const owner = {}
  const shared = acquireSharedAtlas(font, owner, document.createElement('canvas'))
  const lease = { owner, shared }
  owners.push(lease)
  return lease
}

function raster(shared: SharedGlyphAtlas) {
  return shared.rasterizer.rasterize({
    text: 'A',
    cellSpan: 1,
    italic: false,
    weight: 'normal',
    foreground: { r: 255, g: 255, b: 255 },
  })
}

async function face(family: string, name = 'before.woff2'): Promise<FontFace> {
  const url = new URL(`../../dom/tests/fixtures/font-resource/${name}`, import.meta.url).href
  const font = await new FontFace(family, `url(${url})`).load()
  faces.push(font)
  return font
}

it('reuses equal descriptors, keeps peers alive and removes listeners on the last release', () => {
  const add = vi.spyOn(document.fonts, 'addEventListener')
  const remove = vi.spyOn(document.fonts, 'removeEventListener')
  const first = acquire()
  const peer = acquire()
  expect(first.shared).toBe(peer.shared)
  expect(add.mock.calls.map(([name]) => name)).toEqual(['loading', 'loadingdone', 'loadingerror'])
  releaseSharedAtlas(first.shared, first.owner)
  releaseSharedAtlas(first.shared, first.owner)
  expect(peer.shared.ownerCount).toBe(1)
  expect(remove).not.toHaveBeenCalled()
  releaseSharedAtlas(peer.shared, peer.owner)
  expect(remove.mock.calls.map(([name]) => name)).toEqual([
    'loading',
    'loadingdone',
    'loadingerror',
  ])
  expect(acquire().shared).not.toBe(peer.shared)
})

it('isolates all fitted font fields and DPR while ignoring property insertion order', () => {
  const font = fittedFont()
  const first = acquire(font).shared
  const variants = [
    { ...font, pixelRatio: 1.25 },
    { ...font, deviceBaseline: font.deviceBaseline + 1 },
    { ...font, charLeft: font.charLeft + 1 },
    { ...font, charTop: font.charTop + 1 },
    { ...font, deviceCellWidth: font.deviceCellWidth + 1 },
    { ...font, deviceCellHeight: font.deviceCellHeight + 1 },
    { ...font, deviceCharWidth: font.deviceCharWidth + 1 },
    { ...font, deviceCharHeight: font.deviceCharHeight + 1 },
    { ...font, cssCellWidth: font.cssCellWidth + 0.5 },
    { ...font, cssCellHeight: font.cssCellHeight + 0.5 },
    { ...font, settings: { ...font.settings, family: 'serif, monospace' } },
    { ...font, settings: { ...font.settings, size: 15 } },
    { ...font, settings: { ...font.settings, weight: 300 } },
    { ...font, settings: { ...font.settings, boldWeight: 900 } },
    { ...font, settings: { ...font.settings, letterSpacing: 1 } },
    { ...font, settings: { ...font.settings, lineHeight: 1.5 } },
  ]
  for (const variant of variants) expect(acquire(variant).shared).not.toBe(first)
  const { weight, ...settings } = font.settings
  const reordered = { ...font, settings: { weight, ...settings } }
  expect(acquire(reordered).shared).toBe(first)
})

it.each(['loading', 'loadingdone', 'loadingerror'])(
  'retires acquisitions on %s without mutating a live peer atlas',
  (event) => {
    const first = acquire()
    const bitmap = raster(first.shared)
    document.fonts.dispatchEvent(new Event(event))
    const fresh = acquire()
    expect(fresh.shared).not.toBe(first.shared)
    expect(raster(first.shared)).toBe(bitmap)
    expect(raster(fresh.shared)).toEqual(bitmap)
  },
)

it('detects preloaded same-metric resource replacement before a new owner joins', async () => {
  const family = 'SharedAtlasResource'
  const before = await face(family)
  const after = await face(family, 'replacement.woff2')
  document.fonts.add(before)
  const font = { ...fittedFont(), settings: { ...fittedFont().settings, family } }
  const first = acquire(font)
  const bitmap = raster(first.shared)
  document.fonts.delete(before)
  document.fonts.add(after)
  const fresh = acquire(font)
  expect(fresh.shared).not.toBe(first.shared)
  expect(raster(fresh.shared)?.pixels).not.toEqual(bitmap?.pixels)
  expect(raster(first.shared)).toBe(bitmap)
})

it.for([
  ['ascentOverride', '80%'],
  ['descentOverride', '20%'],
  ['lineGapOverride', '10%'],
  ['display', 'swap'],
  ['sizeAdjust', '90%'],
] as const)(
  'isolates acquisition after a FontFace %s mutation',
  async ([descriptor, value], { skip }) => {
    const resource = await face('SharedAtlasDescriptors')
    if (!(descriptor in resource)) skip(`${descriptor} is unavailable`)
    document.fonts.add(resource)
    const first = acquire()
    expect(Reflect.set(resource, descriptor, value)).toBe(true)
    expect(acquire().shared).not.toBe(first.shared)
  },
)
