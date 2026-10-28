export interface FontTables {
  readonly cmap?: DataView
  readonly gsub?: DataView
}

const wantedTables = new Set(['cmap', 'GSUB'])
// WOFF2 known-table indices from the specification, in order.
const woff2KnownTags = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca',
  'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea',
  'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL',
  'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
] // prettier-ignore

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

function slice(view: DataView, offset: number, length: number): DataView {
  if (offset + length > view.byteLength) throw new RangeError('font table exceeds the font file')
  return new DataView(view.buffer, view.byteOffset + offset, length)
}

async function decompress(bytes: Uint8Array, format: CompressionFormat): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// Collection table offsets are relative to the file, not to the face header.
function sfntTables(view: DataView, header = 0): FontTables {
  const count = view.getUint16(header + 4)
  const tables: { cmap?: DataView; gsub?: DataView } = {}
  for (let index = 0; index < count; index += 1) {
    const record = header + 12 + index * 16
    const name = tag(view, record)
    if (!wantedTables.has(name)) continue
    const table = slice(view, view.getUint32(record + 8), view.getUint32(record + 12))
    if (name === 'cmap') tables.cmap = table
    if (name === 'GSUB') tables.gsub = table
  }
  return tables
}

async function woffTables(view: DataView): Promise<FontTables> {
  const count = view.getUint16(12)
  const tables: { cmap?: DataView; gsub?: DataView } = {}
  for (let index = 0; index < count; index += 1) {
    const record = 44 + index * 20
    const name = tag(view, record)
    if (!wantedTables.has(name)) continue
    const offset = view.getUint32(record + 4)
    const compressed = view.getUint32(record + 8)
    const length = view.getUint32(record + 12)
    const source = slice(view, offset, compressed)
    const bytes =
      compressed < length
        ? await decompress(new Uint8Array(source.buffer, source.byteOffset, compressed), 'deflate')
        : new Uint8Array(source.buffer, source.byteOffset, compressed)
    const table = new DataView(bytes.buffer, bytes.byteOffset, length)
    if (name === 'cmap') tables.cmap = table
    if (name === 'GSUB') tables.gsub = table
  }
  return tables
}

function base128(view: DataView, cursor: { offset: number }): number {
  let value = 0
  for (let index = 0; index < 5; index += 1) {
    const byte = view.getUint8(cursor.offset)
    cursor.offset += 1
    value = value * 128 + (byte & 127)
    if ((byte & 128) === 0) return value
  }
  throw new RangeError('invalid WOFF2 UIntBase128')
}

async function woff2Tables(view: DataView): Promise<FontTables> {
  const count = view.getUint16(12)
  const compressedLength = view.getUint32(20)
  const cursor = { offset: 48 }
  const entries: { name: string; offset: number; length: number }[] = []
  let streamOffset = 0
  for (let index = 0; index < count; index += 1) {
    const flags = view.getUint8(cursor.offset)
    cursor.offset += 1
    const known = flags & 63
    const name = known === 63 ? tag(view, cursor.offset) : (woff2KnownTags[known] ?? '')
    if (known === 63) cursor.offset += 4
    const length = base128(view, cursor)
    const version = (flags >> 6) & 3
    const glyphTable = name === 'glyf' || name === 'loca'
    const transformed = glyphTable ? version === 0 : version !== 0
    const stored = transformed ? base128(view, cursor) : length
    entries.push({ name, offset: streamOffset, length })
    streamOffset += stored
  }
  if (!entries.some((entry) => wantedTables.has(entry.name))) return {}
  const source = slice(view, cursor.offset, compressedLength)
  const stream = await decompress(
    new Uint8Array(source.buffer, source.byteOffset, compressedLength),
    'brotli' as CompressionFormat,
  )
  const decoded = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const tables: { cmap?: DataView; gsub?: DataView } = {}
  for (const entry of entries) {
    if (entry.name === 'cmap') tables.cmap = slice(decoded, entry.offset, entry.length)
    if (entry.name === 'GSUB') tables.gsub = slice(decoded, entry.offset, entry.length)
  }
  return tables
}

/** Reads cmap and GSUB from TrueType, OpenType, the first face of a collection, WOFF or WOFF2. */
export async function readFontTables(bytes: Uint8Array): Promise<FontTables> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < 12) throw new RangeError('font file is too short')
  const signature = tag(view, 0)
  if (signature === 'wOFF') return woffTables(view)
  if (signature === 'wOF2') return woff2Tables(view)
  if (signature === 'ttcf') return sfntTables(view, view.getUint32(12))
  if (signature === 'OTTO' || signature === 'true' || view.getUint32(0) === 0x00010000)
    return sfntTables(view)
  throw new RangeError('unsupported font format')
}
