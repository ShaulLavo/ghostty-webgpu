import { resolve } from 'node:path'

const pin = '7b11f3dca034d8d24369ad3856afe57946d7902a'
const repository = resolve(process.argv[2] ?? '')
const output = resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: generate-glyph-constraints.ts GHOSTTY_REPO OUTPUT')
}

function source(path: string): string {
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

const defaults = {
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

function constraint(literal: string): string {
  const value: Record<string, number | string | null> = { ...defaults }
  for (const match of literal.matchAll(/\.(\w+) = ([^,\n]+)/g)) {
    const key = names[match[1] as keyof typeof names]
    if (!key) throw new Error(`Unknown constraint field ${match[1]}`)
    const raw = match[2]!.trim()
    value[key] = raw.startsWith('.') ? raw.slice(1) : Number(raw)
  }
  return JSON.stringify(value)
}

function numbers(values: readonly number[]): string {
  const lines: string[] = []
  for (let index = 0; index < values.length; index += 24) {
    lines.push(`  ${values.slice(index, index + 24).join(', ')},`)
  }
  return lines.join('\n')
}

const table = source('src/font/nerd_font_tables.zig')
const stage1 = numericArray(table, 'stage1')
const stage2 = numericArray(table, 'stage2')
const constraints = constraintLiterals(stage3Body(table)).map(constraint)
const generated = `// Generated from Ghostty ${pin.slice(0, 7)} src/font/nerd_font_tables.zig. MIT, see THIRD_PARTY_NOTICES.md.
import type { GlyphConstraint } from './glyph-constraints.js'

const stage1 = new Uint16Array([
${numbers(stage1)}
])
const stage2 = new Uint16Array([
${numbers(stage2)}
])
const constraints: readonly (GlyphConstraint | null)[] = [
  null,
  ${constraints.join(',\n  ')},
]

export function nerdFontConstraint(cp: number): GlyphConstraint | undefined {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return undefined
  const page = stage1[cp >> 8] ?? 0
  if (page === 0) return undefined
  const index = stage2[page + (cp & 0xff)] ?? 0
  return constraints[index] ?? undefined
}
`
await Bun.write(output, generated)
const formatted = Bun.spawnSync({
  cmd: ['bunx', 'oxfmt', '--write', output],
  stderr: 'inherit',
  stdout: 'inherit',
})
if (formatted.exitCode !== 0) throw new Error('Unable to format generated constraints')
console.log(`Generated ${constraints.length} constraints from ${pin}`)
