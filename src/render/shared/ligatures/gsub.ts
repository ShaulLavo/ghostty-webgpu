import type { FontTables } from './font-tables.js'

/** Half-open code point offsets that must be drawn as one shaped string. */
export type LigatureRange = readonly [start: number, end: number]

interface Glyph {
  id: number
  start: number
  end: number
}

interface Application {
  /** Glyphs consumed at the matched position after substitution. */
  advance: number
  changed: boolean
  contextStart: number
  contextEnd: number
}

type Subtable = (glyphs: Glyph[], index: number) => Application | undefined

interface Lookup {
  readonly reverse: boolean
  /** Glyphs at which any subtable can match; other positions skip the lookup. */
  readonly starts: ReadonlySet<number>
  readonly subtables: readonly Subtable[]
}

// Features a browser applies by default to horizontal Latin text and that can join glyphs.
const joiningFeatures = new Set(['calt', 'clig', 'liga', 'rlig'])
const maxNestedDepth = 8

type Coverage = ReadonlyMap<number, number>
type ClassDef = (glyph: number) => number

function readCoverage(view: DataView, offset: number): Coverage {
  const map = new Map<number, number>()
  const format = view.getUint16(offset)
  const count = view.getUint16(offset + 2)
  if (format === 1) {
    for (let index = 0; index < count; index += 1)
      map.set(view.getUint16(offset + 4 + index * 2), index)
    return map
  }
  for (let range = 0; range < count; range += 1) {
    const record = offset + 4 + range * 6
    const first = view.getUint16(record)
    const last = view.getUint16(record + 2)
    const base = view.getUint16(record + 4)
    for (let glyph = first; glyph <= last; glyph += 1) map.set(glyph, base + glyph - first)
  }
  return map
}

function readClassDef(view: DataView, offset: number): ClassDef {
  const map = new Map<number, number>()
  const format = view.getUint16(offset)
  if (format === 1) {
    const first = view.getUint16(offset + 2)
    const count = view.getUint16(offset + 4)
    for (let index = 0; index < count; index += 1)
      map.set(first + index, view.getUint16(offset + 6 + index * 2))
    return (glyph) => map.get(glyph) ?? 0
  }
  const count = view.getUint16(offset + 2)
  for (let range = 0; range < count; range += 1) {
    const record = offset + 4 + range * 6
    const value = view.getUint16(record + 4)
    for (let glyph = view.getUint16(record); glyph <= view.getUint16(record + 2); glyph += 1)
      map.set(glyph, value)
  }
  return (glyph) => map.get(glyph) ?? 0
}

function readUint16s(view: DataView, offset: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => view.getUint16(offset + index * 2))
}

interface SequenceRecord {
  readonly sequence: number
  readonly lookup: number
}

function readRecords(view: DataView, offset: number, count: number): SequenceRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    sequence: view.getUint16(offset + index * 4),
    lookup: view.getUint16(offset + index * 4 + 2),
  }))
}

type Matcher = (glyph: number) => boolean
// The first input glyph already matched the subtable coverage.
const coveredGlyph: Matcher = () => true

interface ContextRule {
  readonly backtrack: readonly Matcher[]
  readonly input: readonly Matcher[]
  readonly lookahead: readonly Matcher[]
  readonly records: readonly SequenceRecord[]
}

class GsubTable {
  private readonly lookups: (Lookup | undefined)[] = []
  private readonly lookupOffsets: number[]
  readonly active: readonly number[]

  constructor(private readonly view: DataView) {
    const lookupList = view.getUint16(8)
    const count = view.getUint16(lookupList)
    this.lookupOffsets = readUint16s(view, lookupList + 2, count).map((value) => lookupList + value)
    this.active = this.activeLookups()
  }

  private activeLookups(): number[] {
    const view = this.view
    const scripts = view.getUint16(4)
    const features = view.getUint16(6)
    const langSys = this.defaultLangSys(scripts)
    if (langSys === undefined) return []
    const required = view.getUint16(langSys + 2)
    const featureCount = view.getUint16(langSys + 4)
    const indices = readUint16s(view, langSys + 6, featureCount)
    if (required !== 0xffff) indices.push(required)
    const lookups = new Set<number>()
    for (const featureIndex of indices) {
      const record = features + 2 + featureIndex * 6
      const name = String.fromCharCode(...readBytes(view, record, 4))
      if (!joiningFeatures.has(name)) continue
      const feature = features + view.getUint16(record + 4)
      const lookupCount = view.getUint16(feature + 2)
      for (const lookup of readUint16s(view, feature + 4, lookupCount)) lookups.add(lookup)
    }
    return Array.from(lookups).sort((left, right) => left - right)
  }

  private defaultLangSys(scripts: number): number | undefined {
    const view = this.view
    const count = view.getUint16(scripts)
    const records = Array.from({ length: count }, (_, index) => ({
      name: String.fromCharCode(...readBytes(view, scripts + 2 + index * 6, 4)),
      offset: scripts + view.getUint16(scripts + 2 + index * 6 + 4),
    }))
    const script =
      records.find((record) => record.name === 'DFLT') ??
      records.find((record) => record.name === 'latn') ??
      records[0]
    if (!script) return undefined
    const offset = view.getUint16(script.offset)
    return offset === 0 ? undefined : script.offset + offset
  }

  lookup(index: number): Lookup | undefined {
    if (index in this.lookups) return this.lookups[index]
    const offset = this.lookupOffsets[index]
    const lookup = offset === undefined ? undefined : this.readLookup(offset)
    this.lookups[index] = lookup
    return lookup
  }

  private readLookup(offset: number): Lookup {
    const view = this.view
    const lookupType = view.getUint16(offset)
    const count = view.getUint16(offset + 4)
    const subtables: Subtable[] = []
    const starts = new Set<number>()
    let type = lookupType
    for (const relative of readUint16s(view, offset + 6, count)) {
      let subtable = offset + relative
      if (lookupType === 7) {
        type = view.getUint16(subtable + 2)
        subtable += view.getUint32(subtable + 4)
      }
      const parsed = this.readSubtable(type, subtable)
      if (!parsed) continue
      subtables.push(parsed)
      for (const glyph of this.firstCoverage(type, subtable).keys()) starts.add(glyph)
    }
    return { reverse: type === 8, starts, subtables }
  }

  private firstCoverage(type: number, offset: number): Coverage {
    const view = this.view
    const format = view.getUint16(offset)
    if (type === 5 && format === 3) return readCoverage(view, offset + view.getUint16(offset + 6))
    if (type !== 6 || format !== 3) return readCoverage(view, offset + view.getUint16(offset + 2))
    const backtrack = view.getUint16(offset + 2)
    return readCoverage(view, offset + view.getUint16(offset + 6 + backtrack * 2))
  }

  private readSubtable(type: number, offset: number): Subtable | undefined {
    const format = this.view.getUint16(offset)
    if (type === 1) return this.single(offset, format)
    if (type === 2) return this.multiple(offset)
    if (type === 4) return this.ligature(offset)
    if (type === 5 || type === 6) return this.context(type === 6, offset, format)
    if (type === 8) return this.reverseChain(offset)
    return undefined
  }

  private single(offset: number, format: number): Subtable {
    const view = this.view
    const coverage = readCoverage(view, offset + view.getUint16(offset + 2))
    const delta = format === 1 ? view.getInt16(offset + 4) : 0
    const substitutes =
      format === 2 ? readUint16s(view, offset + 6, view.getUint16(offset + 4)) : []
    return (glyphs, index) => {
      const glyph = glyphs[index]!
      const covered = coverage.get(glyph.id)
      if (covered === undefined) return undefined
      const next = format === 1 ? (glyph.id + delta) & 0xffff : substitutes[covered]
      if (next === undefined) return undefined
      const changed = next !== glyph.id
      glyph.id = next
      return { advance: 1, changed, contextStart: glyph.start, contextEnd: glyph.end }
    }
  }

  private multiple(offset: number): Subtable {
    const view = this.view
    const coverage = readCoverage(view, offset + view.getUint16(offset + 2))
    const sequences = readUint16s(view, offset + 6, view.getUint16(offset + 4)).map((relative) =>
      readUint16s(view, offset + relative + 2, view.getUint16(offset + relative)),
    )
    return (glyphs, index) => {
      const glyph = glyphs[index]!
      const covered = coverage.get(glyph.id)
      const sequence = covered === undefined ? undefined : sequences[covered]
      if (!sequence || sequence.length === 0) return undefined
      const replacement = sequence.map((id) => ({ id, start: glyph.start, end: glyph.end }))
      glyphs.splice(index, 1, ...replacement)
      return {
        advance: replacement.length,
        changed: true,
        contextStart: glyph.start,
        contextEnd: glyph.end,
      }
    }
  }

  private ligature(offset: number): Subtable {
    const view = this.view
    const coverage = readCoverage(view, offset + view.getUint16(offset + 2))
    const sets = readUint16s(view, offset + 6, view.getUint16(offset + 4)).map((relative) => {
      const set = offset + relative
      return readUint16s(view, set + 2, view.getUint16(set)).map((ligature) => {
        const record = set + ligature
        const components = view.getUint16(record + 2)
        return {
          glyph: view.getUint16(record),
          components: readUint16s(view, record + 4, components - 1),
        }
      })
    })
    return (glyphs, index) => {
      const covered = coverage.get(glyphs[index]!.id)
      const set = covered === undefined ? undefined : sets[covered]
      if (!set) return undefined
      for (const candidate of set) {
        const length = candidate.components.length + 1
        if (index + length > glyphs.length) continue
        const matches = candidate.components.every(
          (component, position) => glyphs[index + 1 + position]!.id === component,
        )
        if (!matches) continue
        const start = glyphs[index]!.start
        const end = glyphs[index + length - 1]!.end
        glyphs.splice(index, length, { id: candidate.glyph, start, end })
        return { advance: 1, changed: true, contextStart: start, contextEnd: end }
      }
      return undefined
    }
  }

  private context(chained: boolean, offset: number, format: number): Subtable | undefined {
    const rules = chained ? this.chainedRules(offset, format) : this.contextRules(offset, format)
    if (!rules) return undefined
    return (glyphs, index) => {
      const candidates = rules.candidates(glyphs[index]!.id)
      for (const rule of candidates) {
        const applied = this.applyRule(rule, glyphs, index)
        if (applied) return applied
      }
      return undefined
    }
  }

  private applyRule(rule: ContextRule, glyphs: Glyph[], index: number): Application | undefined {
    const first = index - rule.backtrack.length
    const last = index + rule.input.length + rule.lookahead.length
    if (first < 0 || last > glyphs.length) return undefined
    for (const [position, matcher] of rule.backtrack.entries()) {
      if (!matcher(glyphs[index - 1 - position]!.id)) return undefined
    }
    for (const [position, matcher] of rule.input.entries()) {
      if (!matcher(glyphs[index + position]!.id)) return undefined
    }
    for (const [position, matcher] of rule.lookahead.entries()) {
      if (!matcher(glyphs[index + rule.input.length + position]!.id)) return undefined
    }
    const contextStart = glyphs[first]!.start
    const contextEnd = glyphs[last - 1]!.end
    const before = glyphs.length
    let changed = false
    for (const record of rule.records) {
      const position = index + record.sequence
      if (position >= glyphs.length) continue
      const nested = this.applyNested(record.lookup, glyphs, position, 0)
      changed = changed || nested
    }
    const advance = Math.max(1, rule.input.length + glyphs.length - before)
    return { advance, changed, contextStart, contextEnd }
  }

  applyNested(lookupIndex: number, glyphs: Glyph[], position: number, depth: number): boolean {
    if (depth > maxNestedDepth) return false
    const lookup = this.lookup(lookupIndex)
    if (!lookup) return false
    for (const subtable of lookup.subtables) {
      const applied = subtable(glyphs, position)
      if (applied) return applied.changed
    }
    return false
  }

  private contextRules(offset: number, format: number): RuleIndex | undefined {
    const view = this.view
    if (format === 3) {
      const count = view.getUint16(offset + 2)
      const records = view.getUint16(offset + 4)
      const coverages = readUint16s(view, offset + 6, count).map((value) =>
        readCoverage(view, offset + value),
      )
      const rule: ContextRule = {
        backtrack: [],
        input: coverages.map((coverage) => (glyph: number) => coverage.has(glyph)),
        lookahead: [],
        records: readRecords(view, offset + 6 + count * 2, records),
      }
      const firstCoverage = coverages[0]
      return { candidates: (glyph) => (firstCoverage?.has(glyph) ? [rule] : []) }
    }
    const coverage = readCoverage(view, offset + view.getUint16(offset + 2))
    const classDef =
      format === 2 ? readClassDef(view, offset + view.getUint16(offset + 4)) : undefined
    const setsOffset = offset + (format === 2 ? 6 : 4)
    const sets = readUint16s(view, setsOffset + 2, view.getUint16(setsOffset)).map((relative) =>
      relative === 0 ? [] : this.contextRuleSet(offset + relative, classDef),
    )
    return {
      candidates: (glyph) => {
        const covered = coverage.get(glyph)
        if (covered === undefined) return []
        return sets[classDef ? classDef(glyph) : covered] ?? []
      },
    }
  }

  private contextRuleSet(offset: number, classDef: ClassDef | undefined): ContextRule[] {
    const view = this.view
    return readUint16s(view, offset + 2, view.getUint16(offset)).map((relative) => {
      const rule = offset + relative
      const glyphCount = view.getUint16(rule)
      const recordCount = view.getUint16(rule + 2)
      const values = readUint16s(view, rule + 4, glyphCount - 1)
      return {
        backtrack: [],
        input: [coveredGlyph].concat(values.map((value) => valueMatcher(value, classDef))),
        lookahead: [],
        records: readRecords(view, rule + 4 + (glyphCount - 1) * 2, recordCount),
      }
    })
  }

  private chainedRules(offset: number, format: number): RuleIndex | undefined {
    const view = this.view
    if (format === 3) return this.chainedCoverageRule(offset)
    const coverage = readCoverage(view, offset + view.getUint16(offset + 2))
    const classes =
      format === 2
        ? [4, 6, 8].map((field) => readClassDef(view, offset + view.getUint16(offset + field)))
        : undefined
    const setsOffset = offset + (format === 2 ? 10 : 4)
    const sets = readUint16s(view, setsOffset + 2, view.getUint16(setsOffset)).map((relative) =>
      relative === 0 ? [] : this.chainedRuleSet(offset + relative, classes),
    )
    return {
      candidates: (glyph) => {
        const covered = coverage.get(glyph)
        if (covered === undefined) return []
        return sets[classes ? classes[1]!(glyph) : covered] ?? []
      },
    }
  }

  private chainedRuleSet(offset: number, classes: ClassDef[] | undefined): ContextRule[] {
    const view = this.view
    return readUint16s(view, offset + 2, view.getUint16(offset)).map((relative) => {
      let cursor = offset + relative
      const backtrackCount = view.getUint16(cursor)
      const backtrack = readUint16s(view, cursor + 2, backtrackCount)
      cursor += 2 + backtrackCount * 2
      const inputCount = view.getUint16(cursor)
      const input = readUint16s(view, cursor + 2, inputCount - 1)
      cursor += 2 + (inputCount - 1) * 2
      const lookaheadCount = view.getUint16(cursor)
      const lookahead = readUint16s(view, cursor + 2, lookaheadCount)
      cursor += 2 + lookaheadCount * 2
      return {
        backtrack: backtrack.map((value) => valueMatcher(value, classes?.[0])),
        input: [coveredGlyph].concat(input.map((value) => valueMatcher(value, classes?.[1]))),
        lookahead: lookahead.map((value) => valueMatcher(value, classes?.[2])),
        records: readRecords(view, cursor + 2, view.getUint16(cursor)),
      }
    })
  }

  private chainedCoverageRule(offset: number): RuleIndex {
    const view = this.view
    let cursor = offset + 2
    const lists: Coverage[][] = []
    for (let list = 0; list < 3; list += 1) {
      const count = view.getUint16(cursor)
      lists.push(
        readUint16s(view, cursor + 2, count).map((value) => readCoverage(view, offset + value)),
      )
      cursor += 2 + count * 2
    }
    const [backtrack, input, lookahead] = lists as [Coverage[], Coverage[], Coverage[]]
    const matcher = (coverage: Coverage) => (glyph: number) => coverage.has(glyph)
    const rule: ContextRule = {
      backtrack: backtrack.map(matcher),
      input: input.map(matcher),
      lookahead: lookahead.map(matcher),
      records: readRecords(view, cursor + 2, view.getUint16(cursor)),
    }
    const first = input[0]
    return { candidates: (glyph) => (first?.has(glyph) ? [rule] : []) }
  }

  private reverseChain(offset: number): Subtable {
    const view = this.view
    const coverage = readCoverage(view, offset + view.getUint16(offset + 2))
    let cursor = offset + 4
    const lists: Coverage[][] = []
    for (let list = 0; list < 2; list += 1) {
      const count = view.getUint16(cursor)
      lists.push(
        readUint16s(view, cursor + 2, count).map((value) => readCoverage(view, offset + value)),
      )
      cursor += 2 + count * 2
    }
    const [backtrack, lookahead] = lists as [Coverage[], Coverage[]]
    const substitutes = readUint16s(view, cursor + 2, view.getUint16(cursor))
    return (glyphs, index) => {
      const glyph = glyphs[index]!
      const covered = coverage.get(glyph.id)
      if (covered === undefined) return undefined
      const first = index - backtrack.length
      const last = index + 1 + lookahead.length
      if (first < 0 || last > glyphs.length) return undefined
      if (!backtrack.every((list, position) => list.has(glyphs[index - 1 - position]!.id)))
        return undefined
      if (!lookahead.every((list, position) => list.has(glyphs[index + 1 + position]!.id)))
        return undefined
      const next = substitutes[covered]
      if (next === undefined) return undefined
      const changed = next !== glyph.id
      glyph.id = next
      return {
        advance: 1,
        changed,
        contextStart: glyphs[first]!.start,
        contextEnd: glyphs[last - 1]!.end,
      }
    }
  }
}

interface RuleIndex {
  candidates(glyph: number): readonly ContextRule[]
}

function valueMatcher(value: number, classDef: ClassDef | undefined): Matcher {
  if (classDef) return (glyph) => classDef(glyph) === value
  return (glyph) => glyph === value
}

function readBytes(view: DataView, offset: number, length: number): number[] {
  return Array.from({ length }, (_, index) => view.getUint8(offset + index))
}

function readCmap(view: DataView): (codepoint: number) => number {
  const count = view.getUint16(2)
  const subtables = Array.from({ length: count }, (_, index) => ({
    platform: view.getUint16(4 + index * 8),
    encoding: view.getUint16(6 + index * 8),
    offset: view.getUint32(8 + index * 8),
  }))
  const formatOf = (offset: number) => view.getUint16(offset)
  const full = subtables.find((table) => formatOf(table.offset) === 12)
  if (full) return cmapFormat12(view, full.offset)
  const unicode = subtables.find(
    (table) => formatOf(table.offset) === 4 && (table.platform === 0 || table.platform === 3),
  )
  if (unicode) return cmapFormat4(view, unicode.offset)
  return () => 0
}

function cmapFormat12(view: DataView, offset: number): (codepoint: number) => number {
  const groups = view.getUint32(offset + 12)
  return (codepoint) => {
    let low = 0
    let high = groups - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const record = offset + 16 + middle * 12
      if (codepoint < view.getUint32(record)) high = middle - 1
      else if (codepoint > view.getUint32(record + 4)) low = middle + 1
      else return view.getUint32(record + 8) + codepoint - view.getUint32(record)
    }
    return 0
  }
}

function cmapFormat4(view: DataView, offset: number): (codepoint: number) => number {
  const segments = view.getUint16(offset + 6) / 2
  const ends = offset + 14
  const starts = ends + segments * 2 + 2
  const deltas = starts + segments * 2
  const rangeOffsets = deltas + segments * 2
  return (codepoint) => {
    if (codepoint > 0xffff) return 0
    for (let segment = 0; segment < segments; segment += 1) {
      if (codepoint > view.getUint16(ends + segment * 2)) continue
      const start = view.getUint16(starts + segment * 2)
      if (codepoint < start) return 0
      const delta = view.getInt16(deltas + segment * 2)
      const rangeOffset = view.getUint16(rangeOffsets + segment * 2)
      if (rangeOffset === 0) return (codepoint + delta) & 0xffff
      const glyphOffset = rangeOffsets + segment * 2 + rangeOffset + (codepoint - start) * 2
      const glyph = view.getUint16(glyphOffset)
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff
    }
    return 0
  }
}

function mergeRange(ranges: [number, number][], start: number, end: number): void {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!
    if (end <= range[0] || start >= range[1]) continue
    ranges.splice(index, 1)
    mergeRange(ranges, Math.min(start, range[0]), Math.max(end, range[1]))
    return
  }
  ranges.push([start, end])
}

export interface GsubShaper {
  /** Ranges of at least two code points that the font's joining features substitute together. */
  ranges(codepoints: readonly number[]): LigatureRange[]
}

export function createGsubShaper(tables: FontTables): GsubShaper | undefined {
  if (!tables.cmap || !tables.gsub) return undefined
  const glyphOf = readCmap(tables.cmap)
  const gsub = new GsubTable(tables.gsub)
  const active = gsub.active
  if (active.length === 0) return undefined
  return {
    ranges(codepoints) {
      const glyphs = codepoints.map((codepoint, index) => ({
        id: glyphOf(codepoint),
        start: index,
        end: index + 1,
      }))
      const ranges: [number, number][] = []
      for (const lookupIndex of active) {
        const lookup = gsub.lookup(lookupIndex)
        if (lookup) applyLookup(lookup, glyphs, ranges)
      }
      return ranges
        .filter(([start, end]) => end - start > 1)
        .sort((left, right) => left[0] - right[0])
    },
  }
}

function applyLookup(lookup: Lookup, glyphs: Glyph[], ranges: [number, number][]): void {
  if (!glyphs.some((glyph) => lookup.starts.has(glyph.id))) return
  if (lookup.reverse) {
    for (let index = glyphs.length - 1; index >= 0; index -= 1) {
      if (!lookup.starts.has(glyphs[index]!.id)) continue
      const applied = firstApplication(lookup, glyphs, index)
      if (applied?.changed) mergeRange(ranges, applied.contextStart, applied.contextEnd)
    }
    return
  }
  for (let index = 0; index < glyphs.length;) {
    if (!lookup.starts.has(glyphs[index]!.id)) {
      index += 1
      continue
    }
    const applied = firstApplication(lookup, glyphs, index)
    if (applied?.changed) mergeRange(ranges, applied.contextStart, applied.contextEnd)
    index += applied ? applied.advance : 1
  }
}

function firstApplication(lookup: Lookup, glyphs: Glyph[], index: number): Application | undefined {
  for (const subtable of lookup.subtables) {
    const applied = subtable(glyphs, index)
    if (applied) return applied
  }
  return undefined
}
