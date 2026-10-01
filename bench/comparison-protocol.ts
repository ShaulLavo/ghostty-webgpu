export type InputChunk = string | Uint8Array

export function inputChunks(
  bytes: Uint8Array,
  path: 'bytes' | 'string',
  size: number,
): InputChunk[] {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError('Chunk size must be positive')
  const result: InputChunk[] = []
  const decoder = new TextDecoder()
  for (let offset = 0; offset < bytes.length; offset += size) {
    const part = bytes.subarray(offset, offset + size)
    const chunk = path === 'bytes' ? part : decoder.decode(part, { stream: true })
    if (chunk.length > 0) result.push(chunk)
  }
  if (path === 'string') {
    const tail = decoder.decode()
    if (tail.length > 0) result.push(tail)
  }
  return result
}

export function synchronousWrite(write: (data: InputChunk) => void) {
  return async (data: InputChunk): Promise<void> => {
    write(data)
  }
}

export function parseChunks(
  write: (data: InputChunk) => unknown,
  chunks: readonly InputChunk[],
): void {
  for (let index = 0; index < chunks.length; index++) {
    try {
      if (write(chunks[index]!) !== undefined)
        throw new Error('Synchronous parser returned async work')
    } catch (cause) {
      throw new Error(`Parser write chunk ${index} failed: ${String(cause)}`, { cause })
    }
  }
}

export async function pacedBurst(
  write: () => Promise<void>,
  frame: () => Promise<number>,
  steps: number,
): Promise<number[]> {
  const intervals: number[] = []
  let previous = await frame()
  for (let index = 0; index < steps; index++) {
    await write()
    const time = await frame()
    intervals.push(time - previous)
    previous = time
  }
  return intervals
}

export interface ParserCell {
  text: string
  bold: boolean
  underline: boolean
  rgb?: readonly [number, number, number]
}

export interface ParserScreen {
  lines: readonly string[]
  cursor: { x: number; y: number }
  cells: readonly (readonly ParserCell[])[]
}

interface Probe {
  x: number
  y: number
  bold?: boolean
  underline?: boolean
  rgb?: readonly [number, number, number]
  hue?: 'red' | 'green'
}

export interface ExpectedScreen {
  lines: readonly string[]
  cursor: { x: number; y: number }
  probes: readonly Probe[]
}

export function expectedScreen(
  name: string,
  unit: string,
  repetitions: number,
  columns: number,
  rows: number,
): ExpectedScreen {
  const lines: string[] = Array.from({ length: rows }, () => '')
  const probes: Probe[] = []
  if (name === 'cursor') {
    lines[0] = 'status: redraw'
    lines[2] = ' value'
    lines[5] = 'progress 42%'
    probes.push({ x: 1, y: 2, hue: 'green', bold: false, underline: false })
    return { lines, cursor: { x: 0, y: 0 }, probes }
  }
  let unitLines: string[]
  if (name === 'sgr') unitLines = ['red truecolor style']
  else if (name === 'logs') {
    unitLines = unit
      .split('\r\n')
      .slice(0, -1)
      .flatMap((line) => {
        const segments: string[] = []
        for (let offset = 0; offset < line.length; offset += columns)
          segments.push(line.slice(offset, offset + columns))
        return segments.length > 0 ? segments : ['']
      })
  } else unitLines = unit.split('\r\n').slice(0, -1)
  const completed = unitLines.length * repetitions
  const visible = Math.min(completed, rows - 1)
  for (let row = 0; row < visible; row++)
    lines[row] = unitLines[(completed - visible + row) % unitLines.length]!
  if (name === 'sgr') {
    for (let y = 0; y < visible; y++) {
      probes.push(
        { x: 0, y, hue: 'red', bold: false, underline: false },
        { x: 4, y, rgb: [50, 180, 240], bold: false, underline: false },
        { x: 14, y, bold: true, underline: true },
        { x: 3, y, bold: false, underline: false },
      )
    }
  }
  probes.push({ x: 0, y: visible, bold: false, underline: false })
  return { lines, cursor: { x: 0, y: visible }, probes }
}

export function qualifyScreen(actual: ParserScreen, expected: ExpectedScreen) {
  const normalize = (text: string) => text.normalize('NFC').replace(/ +$/, '')
  if (actual.lines.length !== expected.lines.length)
    throw new Error('Parser viewport row count differs from the fixture oracle')
  for (let y = 0; y < expected.lines.length; y++) {
    if (normalize(actual.lines[y]!) !== normalize(expected.lines[y]!))
      throw new Error(
        `Parser text mismatch at row ${y}: ${JSON.stringify(actual.lines[y])}; expected ${JSON.stringify(expected.lines[y])}`,
      )
  }
  if (actual.cursor.x !== expected.cursor.x || actual.cursor.y !== expected.cursor.y)
    throw new Error(
      `Parser cursor mismatch: ${JSON.stringify(actual.cursor)}; expected ${JSON.stringify(expected.cursor)}`,
    )
  const probes = expected.probes.map((probe) => {
    const cell = actual.cells[probe.y]?.[probe.x]
    if (!cell) throw new Error('Parser attribute probe cell is missing')
    if (probe.bold !== undefined && cell.bold !== probe.bold)
      throw new Error('Parser bold attribute mismatch')
    if (probe.underline !== undefined && cell.underline !== probe.underline)
      throw new Error('Parser underline attribute mismatch')
    if (probe.rgb && probe.rgb.some((component, index) => component !== cell.rgb?.[index]))
      throw new Error('Parser truecolor attribute mismatch')
    const dominant = probe.hue === 'red' ? 0 : 1
    if (
      probe.hue &&
      (!cell.rgb ||
        cell.rgb[dominant]! <= cell.rgb[1 - dominant]! ||
        cell.rgb[dominant]! <= cell.rgb[2]!)
    )
      throw new Error('Parser indexed-color attribute mismatch')
    return { ...probe, actual: cell }
  })
  return { qualified: true, lines: actual.lines, cursor: actual.cursor, probes }
}
