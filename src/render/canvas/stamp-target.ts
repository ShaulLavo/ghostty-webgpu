import { createGhosttyError } from '../../core/error.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { CanvasGlyphRasterizer } from '../atlas/canvas-rasterizer.js'
import type { GlyphBitmap, GlyphRasterizationInput } from '../atlas/types.js'
import { ComposeKernel } from './kernel.js'
import type { Canvas2dContext } from './painter.js'
import type { PaintTarget } from './paint-target.js'
import { PixelFrame } from './pixel-frame.js'
import type { PixelMetrics, PixelTarget } from './pixel-target.js'
import { StampCache, type ResidentStamp } from './stamp-cache.js'

type Point = readonly [number, number]
type Rect = readonly [number, number, number, number]
type Brush = string | CanvasGradient | CanvasPattern
interface State {
  fillStyle: Brush
  strokeStyle: Brush
  globalAlpha: number
  lineWidth: number
  dash: readonly number[]
  clip: Rect
}

function intersect(left: Rect, right: Rect): Rect {
  const x = Math.max(left[0], right[0])
  const y = Math.max(left[1], right[1])
  return [
    x,
    y,
    Math.max(0, Math.min(left[0] + left[2], right[0] + right[2]) - x),
    Math.max(0, Math.min(left[1] + left[3], right[1] + right[3]) - y),
  ]
}

function packed(brush: Brush): number {
  if (typeof brush !== 'string')
    throw createGhosttyError('canvas.brush', 'Canvas pixel brushes require RGB colors')
  const rgb = /^rgb\(([\d.]+), ([\d.]+), ([\d.]+)\)$/.exec(brush)
  if (!rgb) throw createGhosttyError('canvas.brush', 'Canvas pixel brush has invalid RGB channels')
  const [r, g, b] = rgb.slice(1).map((channel) => Math.round(Number(channel)))
  return (r! | (g! << 8) | (b! << 16) | (255 << 24)) >>> 0
}

/** Interprets only the operation set emitted by CanvasRowPainter. */
export class StampTarget implements PixelTarget, PaintTarget {
  readonly context = this
  readonly cache: StampCache
  readonly frame: PixelFrame
  metrics: PixelMetrics = {
    bufferMoves: 0,
    movedRows: 0,
    rasterReadbackBytes: 0,
    rowCopyBytes: 0,
    uploadedRegions: 0,
    uploadedPixelBytes: 0,
  }
  font = ''
  textAlign: CanvasTextAlign = 'center'
  textBaseline: CanvasTextBaseline = 'alphabetic'
  private state: State = {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    dash: [],
    clip: [0, 0, 0, 0],
  }
  private readonly stack: State[] = []
  private points: Point[] = []
  private rectangle: Rect = [0, 0, 0, 0]
  private offset = 0
  private width = 0
  private height = 0
  private rowHeight = 0
  private generation = 0
  private fitted?: TerminalFittedFont
  private fontIdentity = ''
  private presenting = false
  private disposed = false

  constructor(
    private readonly kernel: ComposeKernel,
    output: Canvas2dContext,
  ) {
    this.cache = new StampCache(kernel)
    this.frame = new PixelFrame(kernel.memory, output)
  }

  get fillStyle(): Brush {
    return this.state.fillStyle
  }
  set fillStyle(value: Brush) {
    this.state.fillStyle = value
  }
  get strokeStyle(): Brush {
    return this.state.strokeStyle
  }
  set strokeStyle(value: Brush) {
    this.state.strokeStyle = value
  }
  get globalAlpha(): number {
    return this.state.globalAlpha
  }
  set globalAlpha(value: number) {
    this.state.globalAlpha = value
  }
  get lineWidth(): number {
    return this.state.lineWidth
  }
  set lineWidth(value: number) {
    this.state.lineWidth = value
  }

  setFont(font: TerminalFittedFont): void {
    this.requireWritable()
    this.fitted = font
    this.fontIdentity = JSON.stringify(font)
    this.cache.clear()
  }

  invalidate(): void {
    this.requireWritable()
    this.cache.clear()
    this.frame.invalidate()
  }

  resize(width: number, height: number, rowHeight: number): void {
    this.requireWritable()
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      !Number.isSafeInteger(rowHeight) ||
      width <= 0 ||
      height <= 0 ||
      rowHeight <= 0 ||
      height % rowHeight !== 0
    )
      throw createGhosttyError('canvas.frame', 'Canvas pixels require integer device geometry')
    this.frame.dispose()
    this.cache.resize(width, height)
    if (this.offset) this.kernel.release(this.offset)
    this.offset = 0
    this.width = width
    this.height = height
    this.rowHeight = rowHeight
    this.state.clip = [0, 0, width, height]
    this.offset = this.kernel.allocate(width * height * 4)
    this.generation += 1
    this.kernel.check(
      this.kernel.exports.compose_clear(this.offset, width, height, 0, 0, width, height),
    )
    this.frame.bind({ offset: this.offset, width, height, generation: this.generation }, rowHeight)
  }

  beginRow(_y: number): void {
    this.requireWritable()
  }
  finishRow(y: number): void {
    this.frame.markRow(y)
  }

  copyRows(offset: number): void {
    this.requireWritable()
    const rows = this.height / this.rowHeight
    if (!Number.isSafeInteger(offset) || Math.abs(offset) >= rows)
      throw createGhosttyError('canvas.frame', 'Canvas row transport exceeds the framebuffer')
    const source = Math.max(0, -offset) * this.rowHeight
    const target = Math.max(0, offset) * this.rowHeight
    this.kernel.check(
      this.kernel.exports.compose_move(
        this.offset,
        this.width,
        this.height,
        source,
        target,
        (rows - Math.abs(offset)) * this.rowHeight,
      ),
    )
    this.frame.markTransportedRows(offset)
    this.metrics.bufferMoves += 1
    this.metrics.movedRows += rows - Math.abs(offset)
  }

  present(): void {
    this.requireWritable()
    this.presenting = true
    const regions = this.frame.metrics.uploadedRegions
    const bytes = this.frame.metrics.uploadedPixelBytes
    try {
      this.frame.present()
    } finally {
      this.metrics.uploadedRegions += this.frame.metrics.uploadedRegions - regions
      this.metrics.uploadedPixelBytes += this.frame.metrics.uploadedPixelBytes - bytes
      this.presenting = false
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.requireWritable()
    this.frame.dispose()
    this.cache.dispose()
    if (this.offset) this.kernel.release(this.offset)
    this.offset = 0
    this.disposed = true
  }

  save(): void {
    this.stack.push({ ...this.state })
  }
  restore(): void {
    const saved = this.stack.pop()
    if (saved) this.state = saved
  }
  beginPath(): void {
    this.points = []
    this.rectangle = [0, 0, 0, 0]
  }
  rect(x: number, y: number, width: number, height: number): void {
    this.rectangle = [x, y, width, height]
  }
  clip(): void {
    this.state.clip = intersect(this.state.clip, this.rectangle)
  }
  moveTo(x: number, y: number): void {
    this.points.push([x, y])
  }
  lineTo(x: number, y: number): void {
    this.points.push([x, y])
  }
  setLineDash(segments: number[]): void {
    this.state.dash = segments.slice()
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.requireWritable()
    const bounds = intersect(this.state.clip, [x, y, width, height])
    this.kernel.check(
      this.kernel.exports.compose_clear(this.offset, this.width, this.height, ...bounds),
    )
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.requireWritable()
    if (![x, y, width, height].every(Number.isInteger)) {
      this.primitive([x, y, width, height], 'fill')
      return
    }
    const bounds = intersect(this.state.clip, [x, y, width, height])
    this.kernel.check(
      this.kernel.exports.compose_fill(
        this.offset,
        this.width,
        this.height,
        ...bounds,
        packed(this.fillStyle),
        this.opacity(),
      ),
    )
  }

  fillText(): void {
    throw createGhosttyError('canvas.glyph', 'Canvas pixels require native glyph ownership')
  }

  glyph(input: GlyphRasterizationInput, x: number, y: number): void {
    this.requireWritable()
    const font = this.fitted
    if (!font) throw createGhosttyError('canvas.glyph', 'Canvas glyph font is unavailable')
    const key = JSON.stringify(['glyph', this.fontIdentity, input])
    // The shared rasterizer's own JS cache dies with the miss, leaving viewport-bounded resident stamps.
    const stamp = this.cache.get(
      key,
      () => new CanvasGlyphRasterizer({ font }).rasterize(input),
      this.stampClip(x, y),
    )
    if (stamp) this.compose(stamp, x, y, packed(this.fillStyle))
  }

  stroke(): void {
    if (this.points.length === 0) return
    const xs = this.points.map((point) => point[0])
    const ys = this.points.map((point) => point[1])
    this.primitive(
      [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
      ],
      'path',
    )
  }

  strokeRect(x: number, y: number, width: number, height: number): void {
    this.primitive([x, y, width, height], 'outline')
  }

  private primitive(bounds: Rect, kind: 'fill' | 'path' | 'outline'): void {
    this.requireWritable()
    const padding = kind === 'fill' ? 0 : this.lineWidth / 2 + 1
    const left = Math.floor(bounds[0] - padding)
    const top = Math.floor(bounds[1] - padding)
    const width = Math.ceil(bounds[0] + bounds[2] + padding) - left
    const height = Math.ceil(bounds[1] + bounds[3] + padding) - top
    if (width <= 0 || height <= 0) return
    const relative = this.points.map(([x, y]) => [x - left, y - top])
    const shape = [bounds[0] - left, bounds[1] - top, bounds[2], bounds[3]] as const
    const key = JSON.stringify([
      'primitive',
      kind,
      width,
      height,
      shape,
      relative,
      this.lineWidth,
      this.state.dash,
    ])
    const stamp = this.cache.get(
      key,
      () => this.rasterPrimitive(kind, shape, relative, width, height),
      this.stampClip(left, top),
    )
    if (stamp)
      this.compose(stamp, left, top, packed(kind === 'fill' ? this.fillStyle : this.strokeStyle))
  }

  private rasterPrimitive(
    kind: 'fill' | 'path' | 'outline',
    shape: Rect,
    points: readonly (readonly number[])[],
    width: number,
    height: number,
  ): GlyphBitmap {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context)
      throw createGhosttyError('canvas.stamp', 'Canvas path rasterization is unavailable')
    context.fillStyle = '#ffffff'
    context.strokeStyle = '#ffffff'
    context.lineWidth = this.lineWidth
    context.setLineDash([...this.state.dash])
    if (kind === 'fill') context.fillRect(...shape)
    if (kind === 'outline') context.strokeRect(...shape)
    if (kind === 'path') {
      context.beginPath()
      points.forEach(([x, y], index) => {
        if (index === 0) context.moveTo(x!, y!)
        if (index > 0) context.lineTo(x!, y!)
      })
      context.stroke()
    }
    const image = context.getImageData(0, 0, width, height)
    this.metrics.rasterReadbackBytes += image.data.byteLength
    const pixels = new Uint8Array(width * height)
    for (let i = 0; i < pixels.length; i++) pixels[i] = image.data[i * 4 + 3]!
    return { width, height, offsetX: 0, offsetY: 0, kind: 'grayscale', pixels }
  }

  private stampClip(x: number, y: number): Rect {
    const [left, top, width, height] = intersect(this.state.clip, [0, 0, this.width, this.height])
    return [left - x, top - y, width, height]
  }

  private compose(stamp: ResidentStamp, x: number, y: number, tint: number): void {
    const kind = stamp.encoding === 'a8' ? 1 : 4
    this.kernel.check(
      this.kernel.exports.compose_stamp(
        this.offset,
        this.width,
        this.height,
        stamp.offset,
        stamp.width,
        stamp.height,
        stamp.width * kind,
        kind,
        x + stamp.left,
        y + stamp.top,
        ...this.state.clip,
        tint,
        this.opacity(),
      ),
    )
  }

  private opacity(): number {
    return Math.round(this.globalAlpha * 65535)
  }

  private requireWritable(): void {
    if (this.disposed || this.presenting)
      throw createGhosttyError(
        'canvas.frame',
        'Canvas pixels are unavailable during presentation or disposal',
      )
  }
}
