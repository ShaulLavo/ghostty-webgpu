import type {
  AtlasGlyph,
  AtlasInsertResult,
  AtlasKind,
  AtlasPageUpload,
  GlyphBitmap,
} from './types.js'

export interface GlyphAtlasOptions {
  maxPagesPerKind?: number
  padding?: number
  pageHeight?: number
  pageWidth?: number
}

interface AtlasPosition {
  x: number
  y: number
}

const defaultPageSize = 2048
const defaultPadding = 1
const defaultMaxPagesPerKind = 1

function bitmapCacheKey(key: string, kind: AtlasKind): string {
  return `${kind}\u0000${key}`
}

function validatePositiveInteger(name: string, value: number): number {
  if (Number.isInteger(value) && value > 0) return value
  throw new RangeError(`${name} must be a positive integer`)
}

function validateBitmap(bitmap: GlyphBitmap): void {
  validatePositiveInteger('glyph width', bitmap.width)
  validatePositiveInteger('glyph height', bitmap.height)
  if (bitmap.pixels.length === bitmap.width * bitmap.height * 4) return
  throw new RangeError('glyph pixels must contain width × height × 4 RGBA bytes')
}

class AtlasPage {
  readonly entries = new Map<string, AtlasGlyph>()
  generation = 1
  lastUsed = 0
  readonly pixels: Uint8Array
  readonly rows = new Set<number>()
  private dirty = false
  private shelfHeight = 0
  private shelfX: number
  private shelfY: number

  constructor(
    readonly id: number,
    readonly kind: AtlasKind,
    readonly width: number,
    readonly height: number,
    private readonly padding: number,
  ) {
    this.pixels = new Uint8Array(width * height * 4)
    this.shelfX = padding
    this.shelfY = padding
  }

  consumeUpload(): AtlasPageUpload | undefined {
    if (!this.dirty) return undefined
    this.dirty = false
    return {
      generation: this.generation,
      height: this.height,
      id: this.id,
      kind: this.kind,
      pixels: this.pixels,
      width: this.width,
    }
  }

  insert(cacheKey: string, key: string, bitmap: GlyphBitmap): AtlasGlyph | undefined {
    const position = this.allocate(bitmap.width, bitmap.height)
    if (!position) return undefined
    const glyph: AtlasGlyph = {
      atlasHeight: this.height,
      atlasWidth: this.width,
      generation: this.generation,
      height: bitmap.height,
      key,
      kind: this.kind,
      pageId: this.id,
      width: bitmap.width,
      x: position.x,
      y: position.y,
    }
    this.blit(position, bitmap)
    this.entries.set(cacheKey, glyph)
    this.dirty = true
    return glyph
  }

  reset(): void {
    this.generation += 1
    this.entries.clear()
    this.pixels.fill(0)
    this.rows.clear()
    this.shelfHeight = 0
    this.shelfX = this.padding
    this.shelfY = this.padding
    this.dirty = true
  }

  private allocate(width: number, height: number): AtlasPosition | undefined {
    if (width + this.padding * 2 > this.width) return undefined
    if (height + this.padding * 2 > this.height) return undefined
    let x = this.shelfX
    let y = this.shelfY
    let shelfHeight = this.shelfHeight
    if (x + width + this.padding > this.width) {
      x = this.padding
      y += shelfHeight + this.padding
      shelfHeight = 0
    }
    if (y + height + this.padding > this.height) return undefined
    this.shelfX = x + width + this.padding
    this.shelfY = y
    this.shelfHeight = Math.max(shelfHeight, height)
    return { x, y }
  }

  private blit(position: AtlasPosition, bitmap: GlyphBitmap): void {
    const sourceStride = bitmap.width * 4
    for (let row = 0; row < bitmap.height; row += 1) {
      const sourceStart = row * sourceStride
      const targetStart = ((position.y + row) * this.width + position.x) * 4
      this.pixels.set(bitmap.pixels.subarray(sourceStart, sourceStart + sourceStride), targetStart)
    }
  }
}

export class GlyphAtlas {
  private readonly cache = new Map<string, { glyph: AtlasGlyph; page: AtlasPage }>()
  private evictionCountValue = 0
  private readonly maxPagesPerKind: number
  private nextPageId = 1
  private readonly padding: number
  private readonly pageHeight: number
  private readonly pages: AtlasPage[] = []
  private readonly pageWidth: number
  private readonly rowReferences = new Map<number, Map<number, number>>()
  private tick = 0

  constructor(options: GlyphAtlasOptions = {}) {
    this.pageWidth = validatePositiveInteger('pageWidth', options.pageWidth ?? defaultPageSize)
    this.pageHeight = validatePositiveInteger('pageHeight', options.pageHeight ?? defaultPageSize)
    this.maxPagesPerKind = validatePositiveInteger(
      'maxPagesPerKind',
      options.maxPagesPerKind ?? defaultMaxPagesPerKind,
    )
    this.padding = options.padding ?? defaultPadding
    if (Number.isInteger(this.padding) && this.padding >= 0) return
    throw new RangeError('padding must be a non-negative integer')
  }

  get evictionCount(): number {
    return this.evictionCountValue
  }

  get pageCount(): number {
    return this.pages.length
  }

  beginRow(row: number): void {
    const references = this.rowReferences.get(row)
    if (!references) return
    for (const pageId of references.keys()) this.pageById(pageId)?.rows.delete(row)
    this.rowReferences.delete(row)
  }

  consumeUploads(): readonly AtlasPageUpload[] {
    const uploads: AtlasPageUpload[] = []
    for (const page of this.pages) {
      const upload = page.consumeUpload()
      if (upload) uploads.push(upload)
    }
    return uploads
  }

  getOrInsert(key: string, bitmap: GlyphBitmap, row: number): AtlasInsertResult {
    validateBitmap(bitmap)
    const cacheKey = bitmapCacheKey(key, bitmap.kind)
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.touch(cached.page, row)
      return { glyph: cached.glyph, invalidatedRows: [] }
    }
    const allocation = this.allocatePage(cacheKey, key, bitmap)
    this.cache.set(cacheKey, { glyph: allocation.glyph, page: allocation.page })
    this.touch(allocation.page, row)
    return { glyph: allocation.glyph, invalidatedRows: allocation.invalidatedRows }
  }

  invalidateAll(): readonly number[] {
    const rows = [...this.rowReferences.keys()].sort((left, right) => left - right)
    this.cache.clear()
    this.rowReferences.clear()
    for (const page of this.pages) page.reset()
    return rows
  }

  rowsWithStaleReferences(): readonly number[] {
    const stale: number[] = []
    for (const [row, references] of this.rowReferences) {
      if (!this.referencesAreCurrent(references)) stale.push(row)
    }
    return stale.sort((left, right) => left - right)
  }

  private allocatePage(
    cacheKey: string,
    key: string,
    bitmap: GlyphBitmap,
  ): { glyph: AtlasGlyph; invalidatedRows: readonly number[]; page: AtlasPage } {
    const pages = this.pages.filter((page) => page.kind === bitmap.kind)
    for (const page of pages) {
      const glyph = page.insert(cacheKey, key, bitmap)
      if (glyph) return { glyph, invalidatedRows: [], page }
    }
    if (pages.length < this.maxPagesPerKind) return this.insertIntoNewPage(cacheKey, key, bitmap)
    return this.insertIntoRecycledPage(cacheKey, key, bitmap, pages)
  }

  private createPage(kind: AtlasKind): AtlasPage {
    const page = new AtlasPage(this.nextPageId, kind, this.pageWidth, this.pageHeight, this.padding)
    this.nextPageId += 1
    this.pages.push(page)
    return page
  }

  private insertIntoNewPage(
    cacheKey: string,
    key: string,
    bitmap: GlyphBitmap,
  ): { glyph: AtlasGlyph; invalidatedRows: readonly number[]; page: AtlasPage } {
    const page = this.createPage(bitmap.kind)
    const glyph = page.insert(cacheKey, key, bitmap)
    if (glyph) return { glyph, invalidatedRows: [], page }
    throw new RangeError(`glyph ${bitmap.width}×${bitmap.height} does not fit an empty atlas page`)
  }

  private insertIntoRecycledPage(
    cacheKey: string,
    key: string,
    bitmap: GlyphBitmap,
    pages: readonly AtlasPage[],
  ): { glyph: AtlasGlyph; invalidatedRows: readonly number[]; page: AtlasPage } {
    const page = pages.reduce((oldest, candidate) =>
      candidate.lastUsed < oldest.lastUsed ? candidate : oldest,
    )
    const invalidatedRows = this.recyclePage(page)
    const glyph = page.insert(cacheKey, key, bitmap)
    if (glyph) return { glyph, invalidatedRows, page }
    throw new RangeError(`glyph ${bitmap.width}×${bitmap.height} does not fit an empty atlas page`)
  }

  private pageById(id: number): AtlasPage | undefined {
    return this.pages.find((page) => page.id === id)
  }

  private recyclePage(page: AtlasPage): readonly number[] {
    const rows = [...page.rows].sort((left, right) => left - right)
    for (const cacheKey of page.entries.keys()) this.cache.delete(cacheKey)
    for (const row of rows) this.removePageReference(row, page.id)
    page.reset()
    this.evictionCountValue += 1
    return rows
  }

  private referencesAreCurrent(references: ReadonlyMap<number, number>): boolean {
    for (const [pageId, generation] of references) {
      if (this.pageById(pageId)?.generation !== generation) return false
    }
    return true
  }

  private removePageReference(row: number, pageId: number): void {
    const references = this.rowReferences.get(row)
    if (!references) return
    references.delete(pageId)
    if (references.size > 0) return
    this.rowReferences.delete(row)
  }

  private touch(page: AtlasPage, row: number): void {
    this.tick += 1
    page.lastUsed = this.tick
    page.rows.add(row)
    const references = this.rowReferences.get(row) ?? new Map<number, number>()
    references.set(page.id, page.generation)
    this.rowReferences.set(row, references)
  }
}
