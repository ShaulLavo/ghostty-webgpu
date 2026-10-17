import { History, type HistoryOptions } from './history.js'
import type { EditCommand } from './keymap.js'
import { EditModel, type EditSnapshot } from './model.js'
import { createLineEditorError } from './structured-errors.js'

export type ReadResult =
  | { readonly kind: 'submit'; readonly text: string }
  | { readonly kind: 'interrupt' }
  | { readonly kind: 'end' }
export interface ReadOptions {
  readonly prompt: string
  readonly secondaryPrompt?: string
  readonly signal?: AbortSignal
}
export interface SessionOptions {
  readonly history?: History | HistoryOptions
  readonly complete?: (
    line: string,
    cursor: number,
    signal: AbortSignal,
  ) => readonly string[] | Promise<readonly string[]>
  readonly isComplete?: (text: string, signal: AbortSignal) => boolean | Promise<boolean>
}
export type SessionEvent =
  | { readonly kind: 'change' | 'clear' | 'finish' }
  | { readonly kind: 'output'; readonly text: string }
  | { readonly kind: 'candidates'; readonly values: readonly string[] }

interface Reading {
  readonly options: ReadOptions
  readonly resolve: (result: ReadResult) => void
  readonly reject: (error: unknown) => void
  readonly detach: () => void
}
type State = { kind: 'idle' } | { kind: 'reading'; read: Reading } | { kind: 'disposed' }
interface Candidates {
  revision: number
  values: readonly string[]
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function commonPrefix(values: readonly string[]): string {
  const candidates = values.map((value) =>
    Array.from(segmenter.segment(value), ({ segment }) => segment),
  )
  let prefix = ''
  for (const [index, segment] of (candidates[0] ?? []).entries()) {
    if (!candidates.every((candidate) => candidate[index] === segment)) break
    prefix += segment
  }
  return prefix
}

export class ReadSession {
  readonly model: EditModel
  private state: State = { kind: 'idle' }
  private candidates: Candidates | undefined
  private work: AbortController | undefined
  private action = 0
  private readonly options: SessionOptions
  private readonly emit: (event: SessionEvent) => void

  constructor(options: SessionOptions = {}, emit: (event: SessionEvent) => void = () => {}) {
    this.options = options
    this.model = new EditModel(
      options.history instanceof History ? options.history : new History(options.history),
    )
    this.emit = emit
  }

  get active(): boolean {
    return this.state.kind === 'reading'
  }

  get prompt(): { primary: string; secondary: string } | undefined {
    if (this.state.kind !== 'reading') return undefined
    const { options } = this.state.read
    return { primary: options.prompt, secondary: options.secondaryPrompt ?? '> ' }
  }

  read(options: ReadOptions): Promise<ReadResult> {
    if (this.state.kind === 'disposed')
      return Promise.reject(createLineEditorError('DISPOSED', { state: this.state.kind }))
    if (this.active)
      return Promise.reject(createLineEditorError('READ_PENDING', { state: this.state.kind }))
    if (options.signal?.aborted)
      return Promise.reject(createLineEditorError('READ_ABORTED', { aborted: true }))
    this.model.reset()
    this.action++
    return new Promise((resolve, reject) => {
      const abort = () => this.abort(read)
      const detach = () => options.signal?.removeEventListener('abort', abort)
      const read: Reading = { options, resolve, reject, detach }
      this.state = { kind: 'reading', read }
      options.signal?.addEventListener('abort', abort, { once: true })
      try {
        this.emit({ kind: 'change' })
      } catch (cause) {
        detach()
        reject(cause)
        if (!this.isReading(read)) return
        this.state = { kind: 'idle' }
        this.cancelWork()
      }
    })
  }

  async dispatch(command: EditCommand): Promise<void> {
    if (this.state.kind !== 'reading') return
    const read = this.state.read
    if (command.kind === 'clear') {
      this.emit({ kind: 'clear' })
      return
    }
    const action = ++this.action
    if (command.kind === 'complete') return this.complete(read, action)
    this.cancelWork()
    if (!this.currentAction(read, action)) return
    if (command.kind === 'submit') return this.submit(read, action)
    if (command.kind === 'interrupt') {
      this.model.reset()
      try {
        this.emit({ kind: 'output', text: '^C\r\n' })
      } finally {
        this.finish(read, { kind: 'interrupt' })
      }
      return
    }
    if (command.kind === 'eof' && this.model.snapshot.text === '') {
      this.finish(read, { kind: 'end' })
      return
    }
    this.edit(command)
    this.emit({ kind: 'change' })
  }

  dispose(): void {
    if (this.state.kind === 'disposed') return
    const read = this.state.kind === 'reading' ? this.state.read : undefined
    this.state = { kind: 'disposed' }
    this.model.reset()
    read?.detach()
    read?.reject(createLineEditorError('DISPOSED', { state: 'reading' }))
    this.cancelWork()
    if (read) this.emit({ kind: 'finish' })
  }

  private edit(command: EditCommand): void {
    switch (command.kind) {
      case 'insert':
        this.model.insert(command.text)
        return
      case 'newline':
        this.model.insert('\n')
        return
      case 'left':
      case 'right':
      case 'start':
      case 'end':
      case 'word-left':
      case 'word-right':
        this.model.move(command.kind)
        return
      case 'backspace':
        this.model.delete('backward')
        return
      case 'delete':
      case 'eof':
        this.model.delete('forward')
        return
      case 'kill-word':
        this.model.kill('word')
        return
      case 'kill-start':
        this.model.kill('start')
        return
      case 'kill-end':
        this.model.kill('end')
        return
      case 'yank':
        this.model.yank()
        return
      case 'previous':
      case 'next':
        this.model.recall(command.kind)
        return
      case 'search':
        this.model.search()
        return
      case 'cancel-search':
        this.model.cancelSearch()
        return
      default:
        return
    }
  }

  private async complete(read: Reading, action: number): Promise<void> {
    if (this.candidates?.revision === this.model.snapshot.revision) {
      this.emit({ kind: 'candidates', values: this.candidates.values })
      return
    }
    this.cancelWork()
    if (!this.currentAction(read, action)) return
    const snapshot = this.acceptSearch(read, action)
    const complete = this.options.complete
    if (!snapshot || !complete) return
    const work = new AbortController()
    this.work = work
    let values: readonly string[]
    try {
      values = await complete(snapshot.text, snapshot.cursor, work.signal)
    } catch (cause) {
      if (!this.current(read, snapshot.revision, work)) return
      this.work = undefined
      throw cause
    }
    if (!this.current(read, snapshot.revision, work)) return
    this.work = undefined
    const candidates = Array.from(new Set(values))
    if (candidates.length === 0) return
    const prefix = commonPrefix(candidates)
    const before = snapshot.text.slice(0, snapshot.cursor)
    const from = before.search(/[^\s]*$/u)
    const typed = before.slice(from)
    const replace =
      candidates.length === 1 || (prefix.length > typed.length && prefix.startsWith(typed))
    if (replace) this.model.replace(from, snapshot.cursor, prefix)
    if (candidates.length > 1)
      this.candidates = {
        revision: this.model.snapshot.revision,
        values: Object.freeze(candidates),
      }
    if (replace) this.emit({ kind: 'change' })
  }

  private async submit(read: Reading, action: number): Promise<void> {
    const snapshot = this.acceptSearch(read, action)
    if (!snapshot) return
    const work = new AbortController()
    this.work = work
    let complete: boolean
    try {
      complete = await (this.options.isComplete?.(snapshot.text, work.signal) ?? true)
    } catch (cause) {
      if (!this.current(read, snapshot.revision, work)) return
      this.work = undefined
      throw cause
    }
    if (!this.current(read, snapshot.revision, work)) return
    this.work = undefined
    if (!complete) {
      this.model.replace(snapshot.text.length, snapshot.text.length, '\n')
      this.emit({ kind: 'change' })
      return
    }
    this.model.history.add(snapshot.text)
    this.finish(read, { kind: 'submit', text: snapshot.text })
  }

  private acceptSearch(read: Reading, action: number): EditSnapshot | undefined {
    const searching = this.model.snapshot.search !== undefined
    this.model.acceptSearch()
    const snapshot = this.model.snapshot
    if (searching) this.emit({ kind: 'change' })
    if (!this.currentAction(read, action) || this.model.snapshot.revision !== snapshot.revision)
      return undefined
    return snapshot
  }

  private isReading(read: Reading): boolean {
    return this.state.kind === 'reading' && this.state.read === read
  }

  private currentAction(read: Reading, action: number): boolean {
    return this.isReading(read) && this.action === action
  }

  private current(read: Reading, revision: number, work: AbortController): boolean {
    return (
      this.isReading(read) &&
      !work.signal.aborted &&
      this.work === work &&
      this.model.snapshot.revision === revision
    )
  }

  private finish(read: Reading, result: ReadResult): void {
    if (!this.isReading(read)) return
    const action = this.action
    this.state = { kind: 'idle' }
    read.detach()
    read.resolve(result)
    this.cancelWork()
    if (this.state.kind === 'idle' && this.action === action) this.emit({ kind: 'finish' })
  }

  private abort(read: Reading): void {
    if (!this.isReading(read)) return
    const action = this.action
    this.state = { kind: 'idle' }
    this.model.reset()
    read.detach()
    read.reject(createLineEditorError('READ_ABORTED', { state: 'reading' }))
    this.cancelWork()
    if (this.state.kind === 'idle' && this.action === action) this.emit({ kind: 'finish' })
  }

  private cancelWork(): void {
    const work = this.work
    this.work = undefined
    this.candidates = undefined
    // Abort listeners may synchronously start another read or completion.
    work?.abort()
  }
}
