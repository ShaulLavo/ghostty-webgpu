import { ArtifactBuildError } from './ghostty-source.js'

const EXPORT_SECTION = 7
const decoder = new TextDecoder()

function readLeb(bytes: Uint8Array, start: number): [value: number, next: number] {
  let value = 0
  let scale = 1
  let position = start
  for (;;) {
    const byte = bytes[position++]
    if (byte === undefined) throw new ArtifactBuildError('Truncated wasm LEB128 value')
    value += (byte & 0x7f) * scale
    if ((byte & 0x80) === 0) return [value, position]
    scale *= 128
  }
}

function writeLeb(value: number): number[] {
  const bytes: number[] = []
  let rest = value
  do {
    const low = rest % 128
    rest = Math.floor(rest / 128)
    bytes.push(rest > 0 ? low | 0x80 : low)
  } while (rest > 0)
  return bytes
}

function keptEntries(bytes: Uint8Array, start: number, keep: ReadonlySet<string>) {
  let [count, position] = readLeb(bytes, start)
  const entries: Uint8Array[] = []
  const names: string[] = []
  for (; count > 0; count--) {
    const entryStart = position
    const [length, nameStart] = readLeb(bytes, position)
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + length))
    // One kind byte, then the LEB128 index.
    position = readLeb(bytes, nameStart + length + 1)[1]
    if (!keep.has(name)) continue
    entries.push(bytes.subarray(entryStart, position))
    names.push(name)
  }
  return { entries, names }
}

/** Returns the module with only the named exports; the optimizer then drops what nothing reaches. */
export function trimWasmExports(bytes: Uint8Array, keep: ReadonlySet<string>): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)]
  let kept: string[] = []
  let position = 8
  while (position < bytes.length) {
    const id = bytes[position]!
    const [length, start] = readLeb(bytes, position + 1)
    const end = start + length
    if (id !== EXPORT_SECTION) {
      parts.push(bytes.subarray(position, end))
      position = end
      continue
    }
    const { entries, names } = keptEntries(bytes, start, keep)
    const count: Uint8Array[] = [Uint8Array.from(writeLeb(entries.length))]
    const body = count.concat(entries)
    const bodyLength = body.reduce((total, part) => total + part.length, 0)
    parts.push(Uint8Array.from([EXPORT_SECTION].concat(writeLeb(bodyLength))))
    for (const part of body) parts.push(part)
    kept = names
    position = end
  }
  const missing = Array.from(keep).filter((name) => !kept.includes(name))
  if (missing.length > 0) {
    throw new ArtifactBuildError(`libghostty-vt is missing exports: ${missing.join(', ')}`)
  }
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
