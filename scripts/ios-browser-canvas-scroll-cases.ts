import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const canvasScrollFile = fileURLToPath(
  new URL('../src/render/canvas/scroll.browser.test.ts', import.meta.url),
)

export const canvasScrollCases = [
  {
    file: canvasScrollFile,
    fullName:
      'Canvas scroll reuse on native snapshots > self-copies one-row scrolling and paints only the exposed row (unicode=false)',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:214:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName:
      'Canvas scroll reuse on native snapshots > self-copies one-row scrolling and paints only the exposed row (unicode=true)',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:214:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName:
      'Canvas scroll reuse on native snapshots > handles multi-row/reverse scroll, changed prompts, rewrites, and stationary frames',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:251:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName:
      'Canvas scroll reuse on native snapshots > removes the transported old cursor and preserves cursor styles, movement, and blink',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:274:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName:
      'Canvas scroll reuse on native snapshots > preserves styled native rows and selection screen coordinates',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:297:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName:
      'Canvas scroll reuse on native snapshots > reuses viewport shifts and resets for resize, font/DPR, theme, atlas, clear, and alternate buffer',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:323:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName: 'invalidates a partially changed image after a copy failure',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:366:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName: 'invalidates a partially changed image after a paint failure',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:366:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName: 'keeps partial damage reads, native revision, and acknowledgement semantics',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:404:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName: 'reuses native rows on an OffscreenCanvas (fill-text)',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:425:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName: 'reuses native rows on an OffscreenCanvas (pixels)',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:425:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName:
      'verifies equal-looking rows across alternate buffers and repeated clear/reset transitions',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:477:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName:
      'Canvas pixel presentation on current native snapshots > presents every styled/grapheme/primitive frame with exact transparent pixels',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:496:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName:
      'Canvas pixel presentation on current native snapshots > transports retained pixels and keeps font/DPR/theme/resize/reset coverage exact',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:546:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: canvasScrollFile,
    fullName:
      'refills moved pixel rows after a raster readback failure without acknowledging damage',
    sourceKey: 'src/render/canvas/scroll.browser.test.ts:592:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
