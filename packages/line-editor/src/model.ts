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
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function boundaries(text: string): number[] {
  return Array.from(segmenter.segment(text), (segment) => segment.index).concat(text.length)
}

export class EditModel {
  private text = ''
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
    this.cursor = 0
    this.searching = undefined
    this.lastKill = false
    this.navigation = undefined
    this.revision++
  }

  replace(from: number, to: number, text: string): void {
    const points = boundaries(this.text)
    const start = points.findLast((point) => point <= from) ?? 0
    const end = points.find((point) => point >= to) ?? this.text.length
    const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    this.text = this.text.slice(0, start) + clean + this.text.slice(end)
    this.cursor =
      boundaries(this.text).find((point) => point >= start + clean.length) ?? this.text.length
    this.lastKill = false
    this.revision++
  }

  insert(text: string): void {
    const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    if (!this.searching) {
      this.replace(this.cursor, this.cursor, clean)
      return
    }
    this.searching.query += clean
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
      this.searching.query = query.slice(0, boundaries(query).at(-2) ?? 0)
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
    const points = boundaries(this.text)
    if (motion === 'start') return this.text.slice(0, this.cursor).lastIndexOf('\n') + 1
    if (motion === 'end') {
      const end = this.text.indexOf('\n', this.cursor)
      return end < 0 ? this.text.length : end
    }
    if (motion === 'left') return points.findLast((point) => point < this.cursor) ?? 0
    if (motion === 'right') return points.find((point) => point > this.cursor) ?? this.text.length
    const index = points.indexOf(this.cursor)
    if (motion === 'word-left') return this.wordLeft(points, index)
    return this.wordRight(points, index)
  }

  private unixWordLeft(): number {
    const points = boundaries(this.text)
    const index = points.indexOf(this.cursor)
    let next = index
    while (next > 0 && /\s/u.test(this.text.slice(points[next - 1], points[next]))) next--
    while (next > 0 && !/\s/u.test(this.text.slice(points[next - 1], points[next]))) next--
    return points[next] ?? 0
  }

  private wordLeft(points: readonly number[], index: number): number {
    let next = index
    while (next > 0 && !wordCharacter.test(this.text.slice(points[next - 1], points[next]))) next--
    while (next > 0 && wordCharacter.test(this.text.slice(points[next - 1], points[next]))) next--
    return points[next] ?? 0
  }

  private wordRight(points: readonly number[], index: number): number {
    let next = index
    while (
      next < points.length - 1 &&
      !wordCharacter.test(this.text.slice(points[next], points[next + 1]))
    )
      next++
    while (
      next < points.length - 1 &&
      wordCharacter.test(this.text.slice(points[next], points[next + 1]))
    )
      next++
    return points[next] ?? this.text.length
  }
}
