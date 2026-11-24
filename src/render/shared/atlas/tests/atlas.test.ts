import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { GhosttyRuntime } from '../../../../core/runtime.js'
import { canonicalRendererTheme, mergeRendererTheme } from '../../config.js'
import { GlyphAtlas } from '../atlas.js'
import type { AtlasKind, AtlasPageUpload, GlyphBitmap, GlyphRasterizer } from '../types.js'
import { buildZigFrame } from '../zig-glyphs.js'

function bitmap(kind: AtlasKind, marker: number, width = 2, height = width): GlyphBitmap {
  return {
    height,
    kind,
    offsetX: 0,
    offsetY: 0,
    pixels: new Uint8Array(width * height * (kind === 'grayscale' ? 1 : 4)).fill(marker),
    width,
  }
}

function transferBytes(upload: AtlasPageUpload): number {
  const bytesPerPixel = upload.kind === 'grayscale' ? 1 : 4
  return upload.extent.width * upload.extent.height * bytesPerPixel
}

async function frameOwner(atlas: GlyphAtlas) {
  const runtime = await GhosttyRuntime.create()
  const terminal = runtime.createTerminal({ columns: 4, rows: 2 })
  const state = runtime.createRenderState(terminal)
  const builder = state.createFrameBuilder(4, 2)
  const owner = {}
  atlas.attachOwner(owner)
  onTestFinished(() => {
    atlas.detachOwner(owner)
    builder.dispose()
    runtime.dispose()
  })
  const options = {
    cellWidth: 4,
    cellHeight: 4,
    theme: canonicalRendererTheme(mergeRendererTheme(undefined)),
    full: false,
    overlayRows: new Set<number>(),
  }
  const rasterizer: GlyphRasterizer = {
    rasterize: ({ text }) => bitmap('grayscale', text.charCodeAt(0), 4),
  }
  return {
    builder,
    owner,
    render(text?: string) {
      if (text !== undefined) terminal.write('\r\x1b[2K' + text)
      state.update()
      expect(buildZigFrame(builder, atlas, rasterizer, options, owner)).toBe(0)
      state.acknowledge()
    },
  }
}

describe('GlyphAtlas', () => {
  it('caches identical glyphs while grayscale and color use separate layer sequences', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageHeight: 8, pageWidth: 8 })
    const first = atlas.getOrInsert('A', bitmap('grayscale', 1), 0)
    const cached = atlas.getOrInsert('A', bitmap('grayscale', 2), 1)
    const color = atlas.getOrInsert('A', bitmap('color', 3), 2)

    expect(cached.glyph).toEqual(first.glyph)
    expect(first.glyph.layer).toBe(0)
    expect(color.glyph.layer).toBe(0)
    expect(color.glyph.kind).toBe('color')
    expect(atlas.pageCount).toBe(2)
    expect(atlas.cacheHitCount).toBe(1)
    expect(atlas.cacheMissCount).toBe(2)
  })

  it('allocates three fixed layers before recycling', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 3, padding: 0, pageHeight: 4, pageWidth: 4 })
    const layers = ['A', 'B', 'C'].map(
      (key, row) => atlas.getOrInsert(key, bitmap('grayscale', row + 1, 4), row).glyph.layer,
    )

    expect(layers).toEqual([0, 1, 2])
    expect(atlas.pageCount).toBe(3)
    expect(atlas.evictionCount).toBe(0)
  })

  it('reports exact odd-width grayscale and color dirty regions without packed copies', () => {
    const atlas = new GlyphAtlas({ padding: 0, pageHeight: 7, pageWidth: 9 })
    atlas.getOrInsert('gray', bitmap('grayscale', 7, 3, 2), 0)
    atlas.getOrInsert('color', bitmap('color', 9, 5, 2), 1)
    const [grayscale, color] = atlas.consumeUploads()

    expect(grayscale).toMatchObject({
      bytesPerRow: 9,
      dataOffset: 0,
      extent: { height: 2, width: 3 },
      kind: 'grayscale',
      layer: 0,
      origin: { x: 0, y: 0 },
    })
    expect(grayscale?.pixels.byteLength).toBe(63)
    expect(transferBytes(grayscale!)).toBe(6)
    expect(color).toMatchObject({
      bytesPerRow: 36,
      dataOffset: 0,
      extent: { height: 2, width: 5 },
      kind: 'color',
      layer: 0,
      origin: { x: 0, y: 0 },
    })
    expect(color?.pixels.byteLength).toBe(252)
    expect(transferBytes(color!)).toBe(40)
    expect(atlas.consumeUploads()).toEqual([])
  })

  it('coalesces adjacent and distant insertions into one bounded region per dirty layer', () => {
    const adjacent = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    adjacent.getOrInsert('A', bitmap('grayscale', 1), 0)
    adjacent.getOrInsert('B', bitmap('grayscale', 2), 0)
    expect(adjacent.consumeUploads()[0]).toMatchObject({
      extent: { height: 2, width: 4 },
      origin: { x: 0, y: 0 },
    })

    const distant = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    distant.getOrInsert('A', bitmap('grayscale', 1), 0)
    distant.getOrInsert('row-fill', bitmap('grayscale', 2, 6, 2), 0)
    distant.getOrInsert('next-row', bitmap('grayscale', 3), 0)
    expect(distant.consumeUploads()[0]).toMatchObject({
      extent: { height: 4, width: 8 },
      origin: { x: 0, y: 0 },
    })
  })

  it('does not dirty a layer on cache hit', () => {
    const atlas = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    atlas.getOrInsert('A', bitmap('grayscale', 1), 0)
    atlas.consumeUploads()
    atlas.getOrInsert('A', bitmap('grayscale', 2), 1)

    expect(atlas.consumeUploads()).toEqual([])
  })

  it('increments a recycled layer generation, invalidates references, and uploads only the new glyph', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageHeight: 4, pageWidth: 4 })
    const first = atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 2)
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 5)
    atlas.consumeUploads()
    const recycled = atlas.getOrInsert('B', bitmap('grayscale', 2, 2), 8)
    const upload = atlas.consumeUploads()[0]

    expect(recycled.glyph.layer).toBe(first.glyph.layer)
    expect(recycled.glyph.generation).toBe(first.glyph.generation + 1)
    expect(recycled.invalidatedRows).toEqual([2, 5])
    expect(upload).toMatchObject({
      extent: { height: 2, width: 2 },
      layer: 0,
      origin: { x: 0, y: 0 },
    })
    expect(atlas.evictionCount).toBe(1)
    expect(atlas.rowsWithStaleReferences()).toEqual([])
  })

  it('recycles the deterministic least-recently-used layer at capacity', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 2, padding: 0, pageHeight: 4, pageWidth: 4 })
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 1)
    atlas.getOrInsert('B', bitmap('grayscale', 2, 4), 2)
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 3)
    const recycled = atlas.getOrInsert('C', bitmap('grayscale', 3, 4), 4)

    expect(recycled.glyph.layer).toBe(1)
    expect(recycled.invalidatedRows).toEqual([2])
  })

  it('does not invalidate a row after its old layer references are released', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageHeight: 4, pageWidth: 4 })
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 1)
    atlas.getOrInsert('A', bitmap('grayscale', 1, 4), 2)
    atlas.beginRow(1)
    const recycled = atlas.getOrInsert('B', bitmap('grayscale', 2, 4), 3)

    expect(recycled.invalidatedRows).toEqual([2])
  })

  it('survives repeated CJK and emoji eviction without stale row generations', () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageHeight: 4, pageWidth: 4 })
    const glyphs = ['界', '語', '文', '字', '🙂', '🚀', '🧭', '🫠']
    for (let index = 0; index < 128; index += 1) {
      const text = glyphs[index % glyphs.length]!
      const kind = index % 2 === 0 ? 'grayscale' : 'color'
      const row = index % 12
      atlas.beginRow(row)
      atlas.getOrInsert(text + '-' + index, bitmap(kind, index, 4), row)
      expect(atlas.rowsWithStaleReferences()).toEqual([])
    }

    expect(atlas.evictionCount).toBeGreaterThan(100)
  })

  it('globally invalidates referenced rows without re-uploading cleared layers', () => {
    const atlas = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    atlas.getOrInsert('A', bitmap('grayscale', 1), 3)
    atlas.getOrInsert('🙂', bitmap('color', 2), 7)
    atlas.consumeUploads()

    expect(atlas.invalidateAll()).toEqual([3, 7])
    expect(atlas.rowsWithStaleReferences()).toEqual([])
    expect(atlas.consumeUploads()).toEqual([])
  })

  it('clears the padded box around a glyph inserted into a reset layer', () => {
    const atlas = new GlyphAtlas({ padding: 1, pageHeight: 8, pageWidth: 8 })
    atlas.getOrInsert('wide', bitmap('grayscale', 9, 6, 2), 0)
    atlas.consumeUploads()
    atlas.invalidateAll()
    const narrow = atlas.getOrInsert('narrow', bitmap('grayscale', 7, 2, 2), 0)
    const upload = atlas.consumeUploads()[0]!

    expect(upload).toMatchObject({ extent: { height: 4, width: 4 }, origin: { x: 0, y: 0 } })
    // The old wide glyph's pixels right of the new glyph's padding stay unreferenced.
    const page = upload.pixels
    const row = (y: number) => Array.from(page.subarray(y * 8, y * 8 + 8))
    expect(row(0)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(row(1)).toEqual([0, 7, 7, 0, 9, 9, 9, 0])
    expect(row(3)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(narrow.glyph).toMatchObject({ x: 1, y: 1, width: 2, height: 2 })
  })

  it('marks every live layer for restoration without changing glyph generations', () => {
    const atlas = new GlyphAtlas({ padding: 0, pageHeight: 8, pageWidth: 8 })
    const glyph = atlas.getOrInsert('A', bitmap('grayscale', 1), 3).glyph
    atlas.consumeUploads()

    atlas.markAllForUpload()
    const upload = atlas.consumeUploads()[0]
    const cached = atlas.getOrInsert('A', bitmap('grayscale', 2), 3).glyph

    expect(upload).toMatchObject({ extent: { height: 8, width: 8 }, layer: 0 })
    expect(cached.generation).toBe(glyph.generation)
  })
})

it('compacts a fragmented page while retaining its pinned glyphs and the other page', () => {
  const atlas = new GlyphAtlas({ maxLayersPerKind: 2, padding: 0, pageWidth: 8, pageHeight: 4 })
  const entries = Array.from(
    'ABCD',
    (key, index) => atlas.getOrInsert(key, bitmap('grayscale', index + 1, 4), 0).glyph,
  )
  atlas.consumeUploads()
  atlas.beginFrame()
  for (const glyph of entries.slice(0, 3)) expect(atlas.touchGlyph(glyph, 0)).toBe(true)
  const result = atlas.tryGetOrInsert('E', bitmap('grayscale', 5, 4), 0)
  atlas.endFrame()
  expect(result?.glyph.layer).toBe(1)
  expect(atlas.touchGlyph(entries[0]!, 0)).toBe(true)
  expect(atlas.touchGlyph(entries[2]!, 0)).toBe(false)
  const compacted = atlas.getOrInsert('C', bitmap('grayscale', 3, 4), 0).glyph
  expect(compacted.generation).toBe(2)
  expect(atlas.touchGlyph(compacted, 0)).toBe(true)
  expect(atlas.evictionCount).toBe(1)
  const uploads = atlas.consumeUploads()
  expect(uploads).toHaveLength(1)
  expect(uploads[0]?.layer).toBe(1)
  expect(uploads[0]?.pixels.slice(0, 8)).toEqual(Uint8Array.from([3, 3, 3, 3, 5, 5, 5, 5]))
})

it('keeps a peer owner visible page and delivers every eviction to every owner', () => {
  const atlas = new GlyphAtlas({
    maxLayersPerKind: 2,
    padding: 0,
    pageHeight: 4,
    pageWidth: 4,
  })
  const peer = {}
  const owner = {}
  atlas.attachOwner(peer)
  atlas.attachOwner(owner)

  atlas.beginFrame(peer)
  const visible = atlas.tryGetOrInsert('peer', bitmap('grayscale', 1, 4), -1)!
  atlas.endFrame()
  atlas.beginFrame(owner)
  atlas.tryGetOrInsert('first', bitmap('grayscale', 2, 4), -1)
  atlas.endFrame()
  atlas.beginFrame(owner)
  const recycled = atlas.tryGetOrInsert('second', bitmap('grayscale', 3, 4), -1)!
  atlas.endFrame()

  expect(recycled.glyph.layer).not.toBe(visible.glyph.layer)
  expect(atlas.consumeEvictedPages(peer)).toEqual([
    { kind: 'grayscale', layer: recycled.glyph.layer, generation: 2 },
  ])
  expect(atlas.consumeEvictedPages(owner)).toHaveLength(1)
  expect(atlas.consumeEvictedPages(owner)).toEqual([])
  atlas.beginFrame(owner)
  atlas.tryGetOrInsert('second', bitmap('grayscale', 3, 4), -1)
  expect(atlas.tryGetOrInsert('third', bitmap('grayscale', 4, 4), -1)).toBeUndefined()
  atlas.endFrame()
})

it('records cache and page metrics for each owner independently', () => {
  const atlas = new GlyphAtlas({ padding: 0, pageHeight: 4, pageWidth: 4 })
  const first = {}
  const second = {}
  atlas.attachOwner(first)
  atlas.attachOwner(second)

  atlas.beginFrame(first)
  atlas.getOrInsert('A', bitmap('grayscale', 1, 4), -1)
  atlas.getOrInsert('A', bitmap('grayscale', 2, 4), -1)
  atlas.endFrame()
  atlas.beginFrame(second)
  atlas.getOrInsert('A', bitmap('grayscale', 2, 4), -1)
  atlas.endFrame()

  expect(atlas.metrics(first)).toEqual({ cacheHits: 1, cacheMisses: 1, evictions: 0, pages: 1 })
  expect(atlas.metrics(second)).toEqual({ cacheHits: 1, cacheMisses: 0, evictions: 0, pages: 1 })
})

it('refuses compaction of a peer-pinned page and releases its pins when the peer detaches', () => {
  const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageWidth: 8, pageHeight: 4 })
  const peer = {}
  const owner = {}
  atlas.attachOwner(peer)
  atlas.attachOwner(owner)
  const glyph = atlas.getOrInsert('A', bitmap('grayscale', 1, 4), -1).glyph
  atlas.getOrInsert('B', bitmap('grayscale', 2, 4), -1)
  atlas.beginFrame(peer)
  atlas.touchGlyph(glyph, -1)
  atlas.endFrame()
  atlas.beginFrame(owner)
  atlas.touchGlyph(glyph, -1)
  expect(atlas.hasReclaimableSpace).toBe(false)
  expect(atlas.tryGetOrInsert('C', bitmap('grayscale', 3, 4), -1)).toBeUndefined()
  atlas.endFrame()
  atlas.detachOwner(peer)
  atlas.beginFrame(owner)
  atlas.touchGlyph(glyph, -1)
  expect(atlas.hasReclaimableSpace).toBe(true)
  expect(atlas.tryGetOrInsert('C', bitmap('grayscale', 3, 4), -1)).toBeDefined()
  atlas.endFrame()
})

it('fits the union of two owners after growing the cap without eviction or repeated misses', () => {
  const atlas = new GlyphAtlas({ maxLayersPerKind: 2, padding: 0, pageWidth: 4, pageHeight: 4 })
  const first = {}
  const peer = {}
  atlas.attachOwner(first)
  atlas.attachOwner(peer)
  atlas.growCapacity(4)
  for (let frame = 0; frame < 4; frame += 1) {
    for (const [owner, keys] of [
      [first, 'AB'],
      [peer, 'CD'],
    ] as const) {
      atlas.beginFrame(owner)
      Array.from(keys, (key) => atlas.getOrInsert(key, bitmap('grayscale', 1, 4), -1))
      atlas.endFrame()
    }
  }
  expect(atlas.pageCount).toBe(4)
  expect(atlas.metrics(first)).toEqual({ cacheHits: 6, cacheMisses: 2, evictions: 0, pages: 2 })
  expect(atlas.metrics(peer)).toEqual({ cacheHits: 6, cacheMisses: 2, evictions: 0, pages: 2 })
  expect(atlas.consumeEvictedPages(first)).toEqual([])
  expect(atlas.consumeEvictedPages(peer)).toEqual([])
})

describe('deferred owner pins', () => {
  it('scans only on demand and reports pages from the latest retained frame', async () => {
    const atlas = new GlyphAtlas({ padding: 0, pageWidth: 4, pageHeight: 4 })
    const frame = await frameOwner(atlas)
    frame.render('AB')
    expect(atlas.metrics(frame.owner)).toEqual({
      cacheHits: 0,
      cacheMisses: 2,
      evictions: 0,
      pages: 2,
    })

    const glyphData = vi.spyOn(frame.builder, 'glyphData', 'get')
    frame.render()
    frame.render('A')
    expect(glyphData).not.toHaveBeenCalled()
    expect(atlas.metrics({}).pages).toBe(0)
    atlas.beginFrame({}, false)
    atlas.endFrame()
    expect(glyphData).not.toHaveBeenCalled()
    expect(atlas.metrics(frame.owner)).toEqual({
      cacheHits: 0,
      cacheMisses: 2,
      evictions: 0,
      pages: 1,
    })
    expect(atlas.metrics(frame.owner).pages).toBe(1)
    expect(glyphData).toHaveBeenCalledTimes(1)
  })

  it('refreshes every peer before choosing an eviction on a glyph miss', async () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 3, padding: 0, pageWidth: 4, pageHeight: 4 })
    const first = await frameOwner(atlas)
    const second = await frameOwner(atlas)
    const active = await frameOwner(atlas)
    first.render('AB')
    first.render('A')
    expect(atlas.metrics(first.owner).pages).toBe(1)
    second.render('C')
    const firstData = vi.spyOn(first.builder, 'glyphData', 'get')
    const secondData = vi.spyOn(second.builder, 'glyphData', 'get')
    first.render('B')
    second.render()

    active.render('D')

    expect(firstData).toHaveBeenCalledTimes(1)
    expect(secondData).toHaveBeenCalledTimes(1)
    expect(atlas.consumeEvictedPages(first.owner)).toEqual([
      { kind: 'grayscale', layer: 0, generation: 2 },
    ])
    expect(atlas.metrics(first.owner).pages).toBe(1)
    expect(atlas.metrics(second.owner).pages).toBe(1)
    expect(atlas.metrics(active.owner)).toEqual({
      cacheHits: 0,
      cacheMisses: 1,
      evictions: 1,
      pages: 1,
    })
  })

  it('replaces an active owner’s deferred refresh when it enters the glyph miss path', async () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 2, padding: 0, pageWidth: 4, pageHeight: 4 })
    const frame = await frameOwner(atlas)
    frame.render('A')
    frame.render()
    const glyphData = vi.spyOn(frame.builder, 'glyphData', 'get')
    frame.render('AB')
    expect(atlas.metrics(frame.owner).pages).toBe(2)
    expect(glyphData).toHaveBeenCalledTimes(1)
  })

  it.each(['metrics', 'peer frame'])('skips a disposed builder on a %s flush', async (observer) => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageWidth: 4, pageHeight: 4 })
    const frame = await frameOwner(atlas)
    frame.render('A')
    frame.render()
    const glyphData = vi.spyOn(frame.builder, 'glyphData', 'get')
    frame.builder.dispose()

    if (observer === 'metrics') expect(atlas.metrics(frame.owner).pages).toBe(0)
    const peer = await frameOwner(atlas)
    peer.render('B')
    expect(atlas.metrics(frame.owner).pages).toBe(0)
    expect(atlas.metrics(peer.owner).evictions).toBe(1)
    expect(glyphData).not.toHaveBeenCalled()
  })

  it('drops the pending refresher when the owner detaches', async () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageWidth: 4, pageHeight: 4 })
    const frame = await frameOwner(atlas)
    frame.render('A')
    frame.render()
    const glyphData = vi.spyOn(frame.builder, 'glyphData', 'get')
    atlas.detachOwner(frame.owner)

    const peer = await frameOwner(atlas)
    peer.render('B')
    expect(atlas.metrics(frame.owner).pages).toBe(0)
    expect(atlas.metrics(peer.owner).evictions).toBe(1)
    expect(glyphData).not.toHaveBeenCalled()
  })

  it('preserves the active frame when a peer’s metrics flush its deferred pins', async () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 2, padding: 0, pageWidth: 4, pageHeight: 4 })
    const peer = await frameOwner(atlas)
    peer.render('A')
    peer.render()
    const owner = {}
    atlas.beginFrame(owner, false)
    atlas.getOrInsert('active', bitmap('grayscale', 2, 4), 0)
    expect(atlas.metrics(peer.owner).pages).toBe(1)
    atlas.getOrInsert('active', bitmap('grayscale', 2, 4), 0)
    atlas.endFrame()

    expect(atlas.metrics(owner)).toEqual({
      cacheHits: 1,
      cacheMisses: 1,
      evictions: 0,
      pages: 1,
    })
  })

  it('flushes deferred peers before checking reclaimable space or recycling outside a frame', async () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageWidth: 4, pageHeight: 4 })
    const frame = await frameOwner(atlas)
    frame.render('A')
    frame.render('')
    expect(atlas.metrics(frame.owner).pages).toBe(0)
    // Re-drawing cached A defers owner pins while the stored pin map is still empty.
    frame.render('A')

    expect(atlas.hasReclaimableSpace).toBe(false)
    expect(atlas.tryGetOrInsert('unframed-b', bitmap('grayscale', 4, 4), 0)).toBeUndefined()
    expect(atlas.metrics(frame.owner).pages).toBe(1)

    // Repeat when another owner begins a frame without collecting peer pins upfront.
    frame.render('')
    expect(atlas.metrics(frame.owner).pages).toBe(0)
    frame.render('A')
    const peer = {}
    atlas.beginFrame(peer, false)
    try {
      expect(atlas.hasReclaimableSpace).toBe(false)
      expect(atlas.tryGetOrInsert('peer-b', bitmap('grayscale', 4, 4), 0)).toBeUndefined()
    } finally {
      atlas.endFrame()
    }
    expect(atlas.metrics(frame.owner).pages).toBe(1)
  })

  it('skips a pending refresher cleanly when its owning render state is disposed', async () => {
    const atlas = new GlyphAtlas({ maxLayersPerKind: 1, padding: 0, pageWidth: 4, pageHeight: 4 })
    const runtime = await GhosttyRuntime.create()
    try {
      const terminal = runtime.createTerminal({ columns: 4, rows: 1 })
      const state = runtime.createRenderState(terminal)
      const builder = state.createFrameBuilder(4, 1)
      const owner = {}
      atlas.attachOwner(owner)
      const rasterizer = {
        rasterize: () => bitmap('grayscale', 4, 4),
      }
      const options = {
        cellWidth: 4,
        cellHeight: 4,
        theme: canonicalRendererTheme(mergeRendererTheme(undefined)),
        full: false,
        overlayRows: new Set<number>(),
      }
      terminal.write('A')
      state.update()
      expect(buildZigFrame(builder, atlas, rasterizer, options, owner)).toBe(0)
      state.acknowledge()
      terminal.write('\rA')
      state.update()
      expect(buildZigFrame(builder, atlas, rasterizer, options, owner)).toBe(0)
      state.acknowledge()

      // Disposing only the render state leaves builder.isDisposed false while ensureOwnerActive throws.
      state.dispose()

      const peer = await frameOwner(atlas)
      expect(() => peer.render('B')).not.toThrow()
      expect(atlas.metrics(owner).pages).toBe(0)
      expect(atlas.metrics(peer.owner).evictions).toBe(1)
      terminal.dispose()
    } finally {
      runtime.dispose()
    }
  })
})
