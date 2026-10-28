import type { TerminalFittedFont } from '../../../term/types.js'
import { readFontTables } from './font-tables.js'
import { createGsubShaper, type LigatureRange } from './gsub.js'

export type { LigatureRange } from './gsub.js'

/** Finds joined ranges in one style-uniform segment of single-code-point cells. */
export interface LigatureFinder {
  find(codepoints: readonly number[]): readonly LigatureRange[]
}

export type LigatureFontSource = string | URL | ArrayBuffer | ArrayBufferView

const noRanges: readonly LigatureRange[] = Object.freeze([])
const maxCachedSegments = 4_096

class CachedFinder implements LigatureFinder {
  private readonly cache = new Map<string, readonly LigatureRange[]>()

  constructor(private readonly compute: (codepoints: readonly number[]) => LigatureRange[]) {}

  find(codepoints: readonly number[]): readonly LigatureRange[] {
    if (codepoints.length < 2) return noRanges
    const key = String.fromCodePoint(...codepoints)
    const cached = this.cache.get(key)
    if (cached) return cached
    if (this.cache.size >= maxCachedSegments) this.cache.clear()
    const ranges = this.compute(codepoints)
    const result = ranges.length === 0 ? noRanges : ranges
    this.cache.set(key, result)
    return result
  }
}

async function sourceBytes(source: LigatureFontSource): Promise<Uint8Array> {
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (ArrayBuffer.isView(source))
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  const response = await fetch(source)
  if (!response.ok) throw new Error(`Unable to load the ligature font: HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Reads the primary font's GSUB joining features; a font without them finds no ranges. */
export async function loadGsubLigatureFinder(source: LigatureFontSource): Promise<LigatureFinder> {
  const shaper = createGsubShaper(await readFontTables(await sourceBytes(source)))
  if (!shaper) return new CachedFinder(() => [])
  return new CachedFinder((codepoints) => shaper.ranges(codepoints))
}

// Common programming ligatures; each is confirmed against the browser's own shaping before use.
const probeTokens = Array.from(
  new Set(
    (
      '<!-- <==> <=> <== ==> === !== =/= <-> --> <-- >>= <<= >>> <<< ||= ::= ... ..< ' +
      '-> <- => <= >= == != >> << && || |> <| :: := =: .. ?. ?? ?: !! ++ -- ** */ /* // ' +
      '/= /> </ <> ~> <~ ~~ -< >- |= &= ^= ## #{ #[ #( %% <$ $> <* *> <+ +> =~ !~ ;; __'
    ).split(' '),
  ),
).sort((left, right) => right.length - left.length)

type ProbeContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function probeCanvas(): OffscreenCanvas | HTMLCanvasElement | undefined {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1)
  if (typeof document === 'undefined') return undefined
  return document.createElement('canvas')
}

function probeContext(): ProbeContext | undefined {
  const context = probeCanvas()?.getContext('2d', { willReadFrequently: true })
  return (context ?? undefined) as ProbeContext | undefined
}

function drawProbe(
  context: ProbeContext,
  token: string,
  joined: boolean,
  size: number,
): Uint8ClampedArray {
  const { width, height } = context.canvas
  context.clearRect(0, 0, width, height)
  const baseline = Math.ceil(size * 1.5)
  if (joined) {
    context.fillText(token, size, baseline)
    return context.getImageData(0, 0, width, height).data
  }
  let x = size
  for (const character of token) {
    context.fillText(character, x, baseline)
    x += context.measureText(character).width
  }
  return context.getImageData(0, 0, width, height).data
}

function shapesTogether(context: ProbeContext, token: string, size: number): boolean {
  const joined = drawProbe(context, token, true, size)
  const separate = drawProbe(context, token, false, size)
  for (let index = 3; index < joined.length; index += 4) {
    if (Math.abs(joined[index]! - separate[index]!) > 64) return true
  }
  return false
}

/**
 * Fallback without font bytes: a fixed list of programming ligatures, each kept only when the
 * browser draws it differently from its separate characters in the regular face.
 */
export function createProbeLigatureFinder(font: TerminalFittedFont): LigatureFinder {
  const context = probeContext()
  if (!context) return new CachedFinder(() => [])
  const size = Math.max(8, Math.round(font.settings.size * 2))
  context.canvas.width = size * 8
  context.canvas.height = size * 3
  context.font = `${font.settings.weight} ${size}px ${font.settings.family}`
  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'
  context.fillStyle = '#ffffff'
  const verdicts = new Map<string, boolean>()
  const joins = (token: string) => {
    let verdict = verdicts.get(token)
    if (verdict === undefined) {
      verdict = shapesTogether(context, token, size)
      verdicts.set(token, verdict)
    }
    return verdict
  }
  return new CachedFinder((codepoints) => {
    // One code unit per code point keeps string offsets equal to cell offsets.
    const text = codepoints
      .map((point) => (point < 128 ? String.fromCharCode(point) : '\u0000'))
      .join('')
    const ranges: [number, number][] = []
    for (let index = 0; index < text.length;) {
      const token = probeTokens.find(
        (candidate) => text.startsWith(candidate, index) && joins(candidate),
      )
      if (!token) {
        index += 1
        continue
      }
      ranges.push([index, index + token.length])
      index += token.length
    }
    return ranges
  })
}

/** `true` joins with the font's own tables when the host knows its bytes, else the probe list. */
export type TerminalLigatures = boolean | { readonly font: LigatureFontSource }

export async function resolveLigatureFinder(
  option: TerminalLigatures | undefined,
  font: TerminalFittedFont,
  knownSource?: LigatureFontSource,
): Promise<LigatureFinder | undefined> {
  if (!option) return undefined
  if (option !== true) return loadGsubLigatureFinder(option.font)
  if (knownSource === undefined) return createProbeLigatureFinder(font)
  // An engine without WOFF2 decompression still joins through the probe list.
  return loadGsubLigatureFinder(knownSource).catch(() => createProbeLigatureFinder(font))
}
