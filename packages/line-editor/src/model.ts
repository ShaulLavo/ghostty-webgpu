import { History } from './history.js'

export type Motion = 'left' | 'right' | 'start' | 'end' | 'word-left' | 'word-right'
export type Kill = 'word' | 'start' | 'end'
export interface EditSnapshot {
  readonly text: string
  readonly cursor: number
  readonly revision: number
  readonly search: { readonly query: string; readonly matched: boolean } | undefined
}
interface Navigation {
  entries: readonly string[]
  index: number
  draft: string
}
interface Search extends Navigation {
  query: string
  matched: boolean
  original: { text: string; cursor: number }
}

const wordCharacter = /[\p{L}\p{N}\p{M}_]/u
let segmenter: Intl.Segmenter | undefined

function isAscii(text: string): boolean {
  return !/[\r\u0080-\uffff]/.test(text)
}

function cleanInput(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

function boundaries(text: string): number[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return Array.from(segmenter.segment(text), (segment) => segment.index).concat(text.length)
}

export class EditModel {
  private text = ''
  // Null means ASCII. Undefined means the current text has not been classified.
  private graphemePoints: readonly number[] | null | undefined = null
  private cursor = 0
  private revision = 0
  private searching: Search | undefined
  private navigation: Navigation | undefined
  private killed = ''
  private lastKill = false
  readonly history: History

  constructor(history = new History()) {
    this.history = history
  }

  get snapshot(): EditSnapshot {
    const search = this.searching
    return {
      text: this.text,
      cursor: this.cursor,
      revision: this.revision,
      search: search ? { query: search.query, matched: search.matched } : undefined,
    }
  }

  reset(): void {
    this.text = ''
    this.graphemePoints = null
    this.cursor = 0
    this.searching = undefined
    this.lastKill = false
    this.navigation = undefined
    this.revision++
  }

  replace(from: number, to: number, text: string): void {
    const points = this.graphemes()
    const length = this.text.length
    const start =
      points?.findLast((point) => point <= from) ??
      Math.floor(Math.min(length, from > 0 ? from : 0))
    const end =
      points?.find((point) => point >= to) ?? Math.ceil(Math.max(0, to < length ? to : length))
    const clean = cleanInput(text)
    const next = this.text.slice(0, start) + clean + this.text.slice(end)
    if (next !== this.text) {
      this.text = next
      this.graphemePoints = points === null && isAscii(clean) ? null : undefined
    }
    const target = start + clean.length
    this.cursor = this.graphemes()?.find((point) => point >= target) ?? target
    this.lastKill = false
    this.revision++
  }

  insert(text: string): void {
    if (!this.searching) {
      this.replace(this.cursor, this.cursor, text)
      return
    }
    this.searching.query += cleanInput(text)
    this.updateSearch()
  }

  move(motion: Motion): void {
    this.acceptSearch()
    this.cursor = this.destination(motion)
    this.lastKill = false
    this.revision++
  }

  delete(direction: 'backward' | 'forward'): void {
    if (this.searching) {
      const query = this.searching.query
      this.searching.query = isAscii(query)
        ? query.slice(0, -1)
        : query.slice(0, boundaries(query).at(-2) ?? 0)
      this.updateSearch()
      return
    }
    const from = direction === 'backward' ? this.destination('left') : this.cursor
    const to = direction === 'forward' ? this.destination('right') : this.cursor
    this.replace(from, to, '')
  }

  kill(kind: Kill): void {
    this.acceptSearch()
    const before = kind === 'word' ? this.unixWordLeft() : this.destination('start')
    const from = kind === 'end' ? this.cursor : before
    const lineEnd = this.destination('end')
    const end = lineEnd === this.cursor ? Math.min(this.text.length, lineEnd + 1) : lineEnd
    const to = kind === 'end' ? end : this.cursor
    const killed = this.text.slice(from, to)
    if (!killed) return
    if (!this.lastKill) this.killed = killed
    if (this.lastKill && kind === 'end') this.killed += killed
    if (this.lastKill && kind !== 'end') this.killed = killed + this.killed
    this.replace(from, to, '')
    this.lastKill = true
  }

  yank(): void {
    this.insert(this.killed)
  }

  recall(direction: 'previous' | 'next'): void {
    this.acceptSearch()
    if (!this.navigation && direction === 'next') return
    if (!this.navigation) {
      const entries = this.history.entries
      this.navigation = { entries, index: entries.length, draft: this.text }
    }
    const navigation = this.navigation
    if (direction === 'previous') navigation.index = Math.max(0, navigation.index - 1)
    if (direction === 'next')
      navigation.index = Math.min(navigation.entries.length, navigation.index + 1)
    const text = navigation.entries[navigation.index] ?? navigation.draft
    if (navigation.index === navigation.entries.length) this.navigation = undefined
    this.replace(0, this.text.length, text)
  }

  search(): void {
    if (!this.searching) {
      const entries = this.navigation?.entries ?? this.history.entries
      this.searching = {
        entries,
        draft: this.navigation?.draft ?? this.text,
        query: '',
        index: this.navigation?.index ?? entries.length,
        matched: true,
        original: { text: this.text, cursor: this.cursor },
      }
    }
    this.updateSearch(this.searching.index)
  }

  acceptSearch(): void {
    const search = this.searching
    if (!search) return
    if (search.index < search.entries.length)
      this.navigation = { entries: search.entries, index: search.index, draft: search.draft }
    this.searching = undefined
    this.revision++
  }

  cancelSearch(): void {
    if (!this.searching) return
    const { original } = this.searching
    this.text = original.text
    this.graphemePoints = undefined
    this.cursor = original.cursor
    this.searching = undefined
    this.revision++
  }

  private updateSearch(before?: number): void {
    const search = this.searching!
    const end = before ?? search.index + 1
    const index = search.entries.findLastIndex(
      (text, index) => index < end && text.includes(search.query),
    )
    search.matched = index >= 0
    if (index >= 0) {
      search.index = index
      this.replace(0, this.text.length, search.entries[index]!)
    }
    this.lastKill = false
    this.revision++
  }

  private destination(motion: Motion): number {
    if (motion === 'start') return this.text.slice(0, this.cursor).lastIndexOf('\n') + 1
    if (motion === 'end') {
      const end = this.text.indexOf('\n', this.cursor)
      return end < 0 ? this.text.length : end
    }
    const points = this.graphemes()
    if (motion === 'left')
      return points?.findLast((point) => point < this.cursor) ?? Math.max(0, this.cursor - 1)
    if (motion === 'right')
      return (
        points?.find((point) => point > this.cursor) ?? Math.min(this.text.length, this.cursor + 1)
      )
    const index = points?.indexOf(this.cursor) ?? this.cursor
    if (motion === 'word-left') return this.wordLeft(points, index)
    return this.wordRight(points, index)
  }

  private unixWordLeft(): number {
    const points = this.graphemes()
    let next = points?.indexOf(this.cursor) ?? this.cursor
    while (next > 0 && /\s/u.test(this.graphemeAt(points, next - 1))) next--
    while (next > 0 && !/\s/u.test(this.graphemeAt(points, next - 1))) next--
    return points ? (points[next] ?? 0) : next
  }

  private wordLeft(points: readonly number[] | null, index: number): number {
    let next = index
    while (next > 0 && !wordCharacter.test(this.graphemeAt(points, next - 1))) next--
    while (next > 0 && wordCharacter.test(this.graphemeAt(points, next - 1))) next--
    return points ? (points[next] ?? 0) : next
  }

  private wordRight(points: readonly number[] | null, index: number): number {
    const end = points ? points.length - 1 : this.text.length
    let next = index
    while (next < end && !wordCharacter.test(this.graphemeAt(points, next))) next++
    while (next < end && wordCharacter.test(this.graphemeAt(points, next))) next++
    return points ? (points[next] ?? this.text.length) : next
  }

  private graphemes(): readonly number[] | null {
    if (this.graphemePoints === undefined)
      this.graphemePoints = isAscii(this.text) ? null : boundaries(this.text)
    return this.graphemePoints
  }

  private graphemeAt(points: readonly number[] | null, index: number): string {
    if (!points) return this.text.charAt(index)
    return this.text.slice(points[index], points[index + 1])
  }
}
