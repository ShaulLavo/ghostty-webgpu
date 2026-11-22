import { resolve } from 'node:path'

const pin = '7b11f3dca034d8d24369ad3856afe57946d7902a'

const names = {
  align_horizontal: 'alignHorizontal',
  align_vertical: 'alignVertical',
  height: 'height',
  max_constraint_width: 'maxConstraintWidth',
  max_xy_ratio: 'maxXyRatio',
  pad_bottom: 'padBottom',
  pad_left: 'padLeft',
  pad_right: 'padRight',
  pad_top: 'padTop',
  relative_height: 'relativeHeight',
  relative_width: 'relativeWidth',
  relative_x: 'relativeX',
  relative_y: 'relativeY',
  size: 'size',
} as const

interface ConstraintRecord {
  alignHorizontal: string
  alignVertical: string
  height: string
  maxConstraintWidth: number
  maxXyRatio: number | null
  padBottom: number
  padLeft: number
  padRight: number
  padTop: number
  relativeHeight: number
  relativeWidth: number
  relativeX: number
  relativeY: number
  size: string
}

const defaults: ConstraintRecord = {
  alignHorizontal: 'none',
  alignVertical: 'none',
  height: 'cell',
  maxConstraintWidth: 2,
  maxXyRatio: null,
  padBottom: 0,
  padLeft: 0,
  padRight: 0,
  padTop: 0,
  relativeHeight: 1,
  relativeWidth: 1,
  relativeX: 0,
  relativeY: 0,
  size: 'none',
}

const rowDefaults: readonly (number | null)[] = [1, 0, 1, 0, null, 0, 0, 0, 0]

function source(repository: string, path: string): string {
  const result = Bun.spawnSync({
    cmd: ['git', '-C', repository, 'show', `${pin}:${path}`],
    stderr: 'inherit',
    stdout: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(`Unable to read pinned ${path}`)
  return result.stdout.toString()
}

function numericArray(text: string, name: string): number[] {
  const match = text.match(new RegExp(`pub const ${name}: \\[\\d+\\]u16 = \\.\\{([^}]*)\\}`))
  if (!match?.[1]) throw new Error(`Unable to parse ${name}`)
  return match[1]
    .split(',')
    .filter(Boolean)
    .map((value) => Number(value.trim()))
}

function stage3Body(text: string): string {
  const declaration = text.indexOf('pub const stage3')
  const start = text.indexOf('= .{', declaration)
  if (declaration < 0 || start < 0) throw new Error('Unable to locate stage3')
  let depth = 0
  for (let index = start + 3; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    if (text[index] === '}') depth -= 1
    if (depth === 0) return text.slice(start + 4, index)
  }
  throw new Error('Unterminated stage3')
}

function constraintLiterals(body: string): string[] {
  const result: string[] = []
  let depth = 0
  let start = -1
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '{' && body[index] !== '}') continue
    if (body[index] === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    depth -= 1
    if (depth === 0 && start >= 0) result.push(body.slice(start, index + 1))
  }
  return result
}

function parseConstraint(literal: string): ConstraintRecord {
  const value: Record<string, number | string | null> = { ...defaults }
  for (const match of literal.matchAll(/\.(\w+) = ([^,\n]+)/g)) {
    const key = names[match[1] as keyof typeof names]
    if (!key) throw new Error(`Unknown constraint field ${match[1]}`)
    const raw = match[2]!.trim()
    value[key] = raw.startsWith('.') ? raw.slice(1) : Number(raw)
  }
  return value as unknown as ConstraintRecord
}

function codepointBounds(
  stage1: readonly number[],
  stage2: readonly number[],
): { minCp: number; maxCp: number } {
  let minCp = 0x110000
  let maxCp = -1
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    const page = stage1[cp >>> 8] ?? 0
    if (page === 0) continue
    if ((stage2[page + (cp & 0xff)] ?? 0) === 0) continue
    if (cp < minCp) minCp = cp
    maxCp = cp
  }
  if (maxCp < 0) throw new Error('Constraint table contains no codepoints')
  return { minCp, maxCp }
}

function encodePageOffsets(stage1: readonly number[]): [number, number][] {
  const offsets: [number, number][] = []
  for (const [page, value] of stage1.entries()) {
    if (value === 0) continue
    if ((value & 0xff) !== 0) {
      throw new Error(`Stage1 offset ${value} at page ${page} is not 256-aligned`)
    }
    offsets.push([page, value >>> 8])
  }
  return offsets
}

function encodeRuns(stage2: readonly number[]): number[] {
  const runs: number[] = []
  for (let index = 0; index < stage2.length;) {
    const value = stage2[index]!
    let length = 1
    while (index + length < stage2.length && stage2[index + length] === value) length += 1
    runs.push(length, value)
    index += length
  }
  return runs
}

function encodeConstraints(records: readonly ConstraintRecord[]): {
  styles: (string | number)[][]
  rows: (number | null)[][]
} {
  const styleIndex = new Map<string, number>()
  const styles: (string | number)[][] = []
  const rows: (number | null)[][] = []
  for (const record of records) {
    const style = [
      record.alignHorizontal,
      record.alignVertical,
      record.height,
      record.maxConstraintWidth,
      record.size,
    ]
    const key = JSON.stringify(style)
    let id = styleIndex.get(key)
    if (id === undefined) {
      id = styles.length
      styleIndex.set(key, id)
      styles.push(style)
    }
    const fields: (number | null)[] = [
      record.relativeHeight,
      record.relativeY,
      record.relativeWidth,
      record.relativeX,
      record.maxXyRatio,
      record.padBottom,
      record.padLeft,
      record.padRight,
      record.padTop,
    ]
    let end = fields.length
    while (end > 0 && fields[end - 1] === rowDefaults[end - 1]) end -= 1
    rows.push(([id] as (number | null)[]).concat(fields.slice(0, end)))
  }
  return { styles, rows }
}

function formatNumberList(values: readonly number[]): string {
  const lines: string[] = []
  for (let index = 0; index < values.length; index += 24) {
    lines.push(`    ${values.slice(index, index + 24).join(', ')},`)
  }
  return lines.join('\n')
}

export function renderCompactConstraintsModule(
  stage1: readonly number[],
  stage2: readonly number[],
  records: readonly ConstraintRecord[],
): string {
  const { minCp, maxCp } = codepointBounds(stage1, stage2)
  const offsets = encodePageOffsets(stage1)
  const runs = encodeRuns(stage2)
  const { styles, rows } = encodeConstraints(records)
  const offsetLines = offsets.map(([page, offset]) => `    [${page}, ${offset}],`).join('\n')
  const styleLines = styles
    .map((style, index) => `    ${index}: ${JSON.stringify(style)},`)
    .join('\n')
  const rowLines = rows.map((row) => `    ${JSON.stringify(row)},`).join('\n')
  return `// Data from Ghostty ${pin.slice(0, 7)} src/font/nerd_font_tables.zig. MIT, see THIRD_PARTY_NOTICES.md.
import type { GlyphConstraint } from './glyph-constraints.js'

const minCp = 0x${minCp.toString(16)}
const maxCp = 0x${maxCp.toString(16)}

interface ConstraintTables {
  pages: Uint16Array
  indices: Uint16Array
  constraints: readonly (GlyphConstraint | undefined)[]
}

let tables: ConstraintTables | undefined

export function nerdFontConstraint(cp: number): GlyphConstraint | undefined {
  if (cp < minCp || cp > maxCp || !Number.isInteger(cp)) return undefined
  const { pages, indices, constraints } = (tables ??= {
    pages: decodePages(),
    indices: decodeIndices(),
    constraints: decodeConstraints(),
  })
  // Missing pages point to the all-zero first page. Index zero means no constraint.
  const page = pages[cp >>> 8] ?? 0
  return constraints[indices[page + (cp & 0xff)] ?? 0]
}

function decodePages(): Uint16Array {
  const offsets: readonly [page: number, offsetInPages: number][] = [
${offsetLines}
  ]
  const pages = new Uint16Array((maxCp >>> 8) + 1)
  for (const [page, offsetInPages] of offsets) {
    pages[page] = offsetInPages << 8
  }
  return pages
}

function decodeIndices(): Uint16Array {
  // Each pair is a run length followed by its constraint index.
  const runs = [
${formatNumberList(runs)}
  ]
  const indices = new Uint16Array(${stage2.length})
  let offset = 0
  for (let i = 0; i < runs.length; i += 2) {
    const end = offset + runs[i]!
    indices.fill(runs[i + 1]!, offset, end)
    offset = end
  }
  return indices
}

type ConstraintStyle = [
  alignHorizontal: GlyphConstraint['alignHorizontal'],
  alignVertical: GlyphConstraint['alignVertical'],
  height: GlyphConstraint['height'],
  maxConstraintWidth: GlyphConstraint['maxConstraintWidth'],
  size: GlyphConstraint['size'],
]

function decodeConstraints(): (GlyphConstraint | undefined)[] {
  const styles = {
${styleLines}
  } satisfies Record<number, ConstraintStyle>

  type EncodedConstraint = [
    style: keyof typeof styles,
    relativeHeight?: number,
    relativeY?: number,
    relativeWidth?: number,
    relativeX?: number,
    maxXyRatio?: number | null,
    padBottom?: number,
    padLeft?: number,
    padRight?: number,
    padTop?: number,
  ]

  const rows: readonly EncodedConstraint[] = [
${rowLines}
  ]
  const constraints: (GlyphConstraint | undefined)[] = [undefined]
  for (const [
    style,
    relativeHeight = 1,
    relativeY = 0,
    relativeWidth = 1,
    relativeX = 0,
    maxXyRatio = null,
    padBottom = 0,
    padLeft = 0,
    padRight = 0,
    padTop = 0,
  ] of rows) {
    const [alignHorizontal, alignVertical, height, maxConstraintWidth, size] = styles[style]
    constraints.push({
      alignHorizontal,
      alignVertical,
      height,
      maxConstraintWidth,
      maxXyRatio,
      padBottom,
      padLeft,
      padRight,
      padTop,
      relativeHeight,
      relativeWidth,
      relativeX,
      relativeY,
      size,
    })
  }
  return constraints
}
`
}

if (import.meta.main) {
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error('Usage: generate-glyph-constraints.ts GHOSTTY_REPO OUTPUT')
  }
  const repository = resolve(process.argv[2])
  const output = resolve(process.argv[3])
  const table = source(repository, 'src/font/nerd_font_tables.zig')
  const stage1 = numericArray(table, 'stage1')
  const stage2 = numericArray(table, 'stage2')
  const records = constraintLiterals(stage3Body(table)).map(parseConstraint)
  const generated = renderCompactConstraintsModule(stage1, stage2, records)
  await Bun.write(output, generated)
  const formatted = Bun.spawnSync({
    cmd: ['bunx', 'oxfmt', '--write', output],
    stderr: 'inherit',
    stdout: 'inherit',
  })
  if (formatted.exitCode !== 0) throw new Error('Unable to format generated constraints')
  console.log(`Generated ${records.length} constraints from ${pin}`)
}
