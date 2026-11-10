import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const canvasThemeCacheFile = fileURLToPath(
  new URL('../src/render/canvas/theme-cache.browser.test.ts', import.meta.url),
)

export const canvasThemeCacheCases = [
  {
    file: canvasThemeCacheFile,
    fullName:
      'repaints cursor-only appearance changes while retaining warm glyph stamps in 17 public terminals',
    sourceKey: 'src/render/canvas/theme-cache.browser.test.ts:17:0',
    timeoutMs: 20000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

export const canvasZwjFile = fileURLToPath(
  new URL('../src/render/canvas/zwj.browser.test.ts', import.meta.url),
)

export const canvasZwjCases = [
  {
    file: canvasZwjFile,
    fullName: 'preserves native technologist owners in legacy and mode-2027 cells',
    sourceKey: 'src/render/canvas/zwj.browser.test.ts:162:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasZwjFile,
    fullName: 'preserves native family owners in legacy and mode-2027 cells',
    sourceKey: 'src/render/canvas/zwj.browser.test.ts:162:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasZwjFile,
    fullName: 'keeps bold italic faint native owners over a uniform brush',
    sourceKey: 'src/render/canvas/zwj.browser.test.ts:248:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasZwjFile,
    fullName: 'keeps components separate across a font boundary',
    sourceKey: 'src/render/canvas/zwj.browser.test.ts:259:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasZwjFile,
    fullName: 'keeps components separate across a foreground boundary',
    sourceKey: 'src/render/canvas/zwj.browser.test.ts:259:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasZwjFile,
    fullName: 'keeps components separate across a background boundary',
    sourceKey: 'src/render/canvas/zwj.browser.test.ts:259:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasZwjFile,
    fullName: 'keeps components separate across a decoration boundary',
    sourceKey: 'src/render/canvas/zwj.browser.test.ts:259:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasZwjFile,
    fullName: 'retains whole and partial selections, cursor overlays and row damage',
    sourceKey: 'src/render/canvas/zwj.browser.test.ts:298:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasZwjFile,
    fullName: 'keeps wrapped ZWJ components in their native rows and clips at the right edge',
    sourceKey: 'src/render/canvas/zwj.browser.test.ts:372:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasZwjFile,
    fullName: 'keeps invisible components and unrelated ZWJ text separate',
    sourceKey: 'src/render/canvas/zwj.browser.test.ts:385:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

export const pixelsFile = fileURLToPath(
  new URL('../src/render/pixels/pixels.browser.test.ts', import.meta.url),
)

export const pixelsCases = [
  {
    file: pixelsFile,
    fullName: 'composes real native owners at DPR 1 with warm zero browser raster work',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:30:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName: 'composes real native owners at DPR 2 with warm zero browser raster work',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:30:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName:
      'keeps default fillText free of compose downloads and explicit pixels on the same native state',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:103:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName: 'loads the compositor from the renderer asset override',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:132:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName: 'forwards the public terminal compositor asset and renders through it',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:150:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName: 'loads the scalar compositor in Chromium when SIMD validation fails',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:170:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName:
      'matches a fresh packed repaint after scroll, cursor, theme, DPR and atlas invalidation',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:181:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName: 'retains native scheduled damage when a pixel submission fails',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:243:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName: 'rebuilds pixels and native font state after Canvas restoration events',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:272:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName:
      'rejects framebuffer reallocation during synchronous presentation and disposes its alias',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:298:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName:
      'settles a clipped family owner in a tiny canvas2d-fill-text viewport with letter spacing 0',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:317:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName:
      'settles a clipped family owner in a tiny canvas2d-fill-text viewport with letter spacing -1',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:317:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName:
      'settles a clipped family owner in a tiny canvas2d-pixels viewport with letter spacing 0',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:317:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName:
      'settles a clipped family owner in a tiny canvas2d-pixels viewport with letter spacing -1',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:317:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName: 'keeps brush colors independent of alpha and restored drawing state',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:390:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName: 'defers invalid brush errors until a draw and retries every failed draw',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:432:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: pixelsFile,
    fullName:
      'keeps packed glyph variants distinct and clears font-scoped stamps across memory growth',
    sourceKey: 'src/render/pixels/pixels.browser.test.ts:467:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

export const glyphConstraintsFile = fileURLToPath(
  new URL('../src/render/shared/atlas/glyph-constraints.browser.test.ts', import.meta.url),
)

export const glyphConstraintsCases = [
  {
    file: glyphConstraintsFile,
    fullName: 'keeps neighbor widths in the rasterizer cache identity',
    sourceKey: 'src/render/shared/atlas/glyph-constraints.browser.test.ts:62:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: glyphConstraintsFile,
    fullName: 'stretches a Nerd Font powerline glyph to its available cell',
    sourceKey: 'src/render/shared/atlas/glyph-constraints.browser.test.ts:72:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: glyphConstraintsFile,
    fullName: 'leaves ordinary text unchanged by symbol constraint context',
    sourceKey: 'src/render/shared/atlas/glyph-constraints.browser.test.ts:210:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: glyphConstraintsFile,
    fullName: 'matches native FreeType glyph constraint contact sheets',
    sourceKey: 'src/render/shared/atlas/glyph-constraints.browser.test.ts:219:0',
    timeoutMs: 60000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

export const spritesFile = fileURLToPath(
  new URL('../src/render/shared/atlas/sprites.browser.test.ts', import.meta.url),
)

export const spritesCases = [
  {
    file: spritesFile,
    fullName: 'fills block cells without seams at 9x18 DPR 1',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:67:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName: 'fills block cells without seams at 9x18 DPR 1.25',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:67:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName: 'fills block cells without seams at 9x18 DPR 2',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:67:2',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName: 'fills block cells without seams at 13x27 DPR 1',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:67:3',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName: 'fills block cells without seams at 13x27 DPR 1.25',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:67:4',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName: 'fills block cells without seams at 13x27 DPR 2',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:67:5',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName: 'fills block cells without seams at 18x36 DPR 1',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:67:6',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName: 'fills block cells without seams at 18x36 DPR 1.25',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:67:7',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName: 'fills block cells without seams at 18x36 DPR 2',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:67:8',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName: 'matches native Ghostty sprite contact sheets within one device pixel',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:251:0',
    timeoutMs: 60000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName: 'keeps sprite geometry independent of font family, bold and italic',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:307:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: spritesFile,
    fullName:
      'keeps thickness-dependent sprites on the font path when post metrics are unavailable',
    sourceKey: 'src/render/shared/atlas/sprites.browser.test.ts:326:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

export const displayedPixelsFixtureFile = fileURLToPath(
  new URL('../src/render/webgl/tests/fixture.browser.test.ts', import.meta.url),
)

export const displayedPixelsFixtureCases = [
  {
    file: displayedPixelsFixtureFile,
    fullName: 'maps a fractional padded screenshot into the canvas backing-pixel grid',
    sourceKey: 'src/render/webgl/tests/fixture.browser.test.ts:4:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
