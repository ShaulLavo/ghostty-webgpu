import { PNG } from 'pngjs'
import { UnsupportedCapture, type DeviceCrop } from './ios-browser-capture-geometry.ts'

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const retainedTypes = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'pHYs'])
const maxPixels = 32 * 1024 * 1024

type Chunk = { type: string; bytes: Buffer }

export function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunks(source: Buffer): Chunk[] {
  if (source.length > maxPixels * 4 || !source.subarray(0, 8).equals(signature))
    throw new UnsupportedCapture('Invalid or oversized PNG')
  const result: Chunk[] = []
  let offset = 8
  while (offset < source.length) {
    if (offset + 12 > source.length) throw new UnsupportedCapture('Truncated PNG chunk')
    const length = source.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > source.length) throw new UnsupportedCapture('PNG chunk exceeds input')
    const type = source.toString('ascii', offset + 4, offset + 8)
    if (pngCrc(source.subarray(offset + 4, end - 4)) !== source.readUInt32BE(end - 4))
      throw new UnsupportedCapture(`Invalid PNG ${type} CRC`)
    result.push({ type, bytes: source.subarray(offset, end) })
    offset = end
    if (type === 'IEND') break
  }
  if (offset !== source.length || result.at(-1)?.type !== 'IEND')
    throw new UnsupportedCapture('PNG must end at IEND')
  return result
}

export function inspectCapturePng(source: Buffer): {
  width: number
  height: number
  colorType: 2 | 6
  profiles: string[]
  chunks: Chunk[]
} {
  const parsed = chunks(source)
  const header = parsed[0]
  if (header?.type !== 'IHDR' || header.bytes.length !== 25)
    throw new UnsupportedCapture('Missing PNG IHDR')
  const width = header.bytes.readUInt32BE(8)
  const height = header.bytes.readUInt32BE(12)
  const depth = header.bytes[16]
  const colorType = header.bytes[17]
  if (!width || !height || width * height > maxPixels)
    throw new UnsupportedCapture('PNG dimensions exceed the capture bound')
  if (depth !== 8 || (colorType !== 2 && colorType !== 6))
    throw new UnsupportedCapture('Capture requires 8-bit RGB or RGBA PNG')
  if (parsed.some((chunk) => chunk.type === 'tRNS'))
    throw new UnsupportedCapture('Transparent RGB PNG is unsupported')
  const profiles = parsed
    .filter((chunk) => retainedTypes.has(chunk.type))
    .map((chunk) => chunk.type)
  if (new Set(profiles).size !== profiles.length)
    throw new UnsupportedCapture('Duplicate PNG color chunks')
  return { width, height, colorType, profiles, chunks: parsed }
}

export function cropPngLossless(source: Buffer, crop: DeviceCrop): Buffer {
  const info = inspectCapturePng(source)
  if (
    !Object.values(crop).every(Number.isSafeInteger) ||
    crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x + crop.width > info.width ||
    crop.y + crop.height > info.height
  )
    throw new UnsupportedCapture('Crop exceeds PNG bounds')
  const decoded = PNG.sync.read(source)
  const fresh = new PNG({ width: crop.width, height: crop.height })
  const data = fresh.data
  for (let row = 0; row < crop.height; row++) {
    const offset = ((crop.y + row) * info.width + crop.x) * 4
    decoded.data.copy(data, row * crop.width * 4, offset, offset + crop.width * 4)
  }
  const encoded = PNG.sync.write(fresh, {
    colorType: info.colorType,
    inputColorType: 6,
    inputHasAlpha: true,
    bitDepth: 8,
  })
  const outputChunks = chunks(encoded)
  if (outputChunks.some((chunk) => retainedTypes.has(chunk.type)))
    throw new UnsupportedCapture('Encoder emitted duplicate color metadata')
  const header = outputChunks.shift()
  if (!header) throw new UnsupportedCapture('Encoder omitted IHDR')
  const output = Buffer.concat(
    [signature, header.bytes].concat(
      info.chunks.filter((chunk) => retainedTypes.has(chunk.type)).map((chunk) => chunk.bytes),
      outputChunks.map((chunk) => chunk.bytes),
    ),
  )
  if (!PNG.sync.read(output).data.equals(data))
    throw new UnsupportedCapture('PNG crop changed sample bytes')
  return output
}
