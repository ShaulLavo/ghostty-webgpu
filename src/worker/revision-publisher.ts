import type { NativeDisplayedFrame } from '../core/displayed-frame.js'
import type { WorkerRevisionRow } from './protocol.js'
import { workerError } from './structured-errors.js'

export interface RevisionContent {
  readonly store: number
  readonly revisions: readonly number[]
  readonly content: readonly WorkerRevisionRow[]
}

const emptyContent: readonly WorkerRevisionRow[] = Object.freeze([])

/** One ordered subscriber. Pending native captures must never enter this publisher. */
export class RevisionPublisher {
  private source?: object
  private store = 0
  private published = new Set<number>()
  private last?: { readonly frame: NativeDisplayedFrame; readonly result: RevisionContent }

  encode(frame: NativeDisplayedFrame): RevisionContent {
    if (frame === this.last?.frame)
      return Object.freeze({
        store: this.store,
        revisions: this.last.result.revisions,
        content: emptyContent,
      })
    if (frame.revisionSource !== this.source) this.nextStore(frame.revisionSource)
    const revisions = frame.readTextRevisions()
    const rows = frame.readTextRows()
    if (revisions.length !== rows.length)
      throw workerError('protocol', 'frame.revision', { rows: rows.length })
    const emitted = new Set<number>()
    const content: WorkerRevisionRow[] = []
    for (let y = 0; y < revisions.length; y += 1) {
      const revision = revisions[y]!
      if (!Number.isSafeInteger(revision) || revision < 1)
        throw workerError('protocol', 'frame.revision', { y, revision })
      if (this.published.has(revision) || emitted.has(revision)) continue
      const row = rows[y]!
      content.push(
        Object.freeze({
          revision,
          text: row.text,
          cells: row.cells,
          continuations: row.continuations,
        }),
      )
      emitted.add(revision)
    }
    this.published = new Set(revisions)
    const result = Object.freeze({ store: this.store, revisions, content: Object.freeze(content) })
    this.last = { frame, result }
    return result
  }

  private nextStore(source: object): void {
    if (this.store === Number.MAX_SAFE_INTEGER)
      throw workerError('protocol', 'frame.store', { store: this.store })
    this.store += 1
    this.source = source
    this.published.clear()
  }

  clear(): void {
    this.source = undefined
    this.store = 0
    this.published.clear()
    this.last = undefined
  }
}
