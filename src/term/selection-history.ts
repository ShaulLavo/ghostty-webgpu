import { createGhosttyError } from '../core/error.js'
import type { SelectionCoordinates, SelectionPoint } from '../core/selection.js'
import type {
  ReadLinesOptions,
  TerminalLine,
  TerminalSelectionFormatOptions,
} from '../core/types.js'
import type { TerminalSession } from './session.js'
import type {
  TerminalSelectionDragInput,
  TerminalSelectionPressInput,
  TerminalSelectionReleaseInput,
} from './types.js'

export interface SelectionIdentity {
  readonly generation: number
  readonly layout: number
  readonly revision: number
}

export type OwnedSelectionCoordinates = {
  readonly [Key in keyof SelectionCoordinates]: Readonly<SelectionCoordinates[Key]>
}

export interface TerminalSelectionSnapshot extends SelectionIdentity {
  readonly selection:
    | {
        readonly text: string
        readonly coordinates: OwnedSelectionCoordinates
      }
    | undefined
}

export interface TerminalHistorySnapshot extends SelectionIdentity {
  readonly lineCount: number
  readonly lines: readonly Readonly<TerminalLine>[]
  readonly scrollbar: Readonly<TerminalSession['scrollbar']>
}

export function ownedSelectionCoordinates(
  coordinates: Readonly<SelectionCoordinates> | undefined,
): OwnedSelectionCoordinates | undefined {
  if (!coordinates) return undefined
  return Object.freeze({
    rectangle: coordinates.rectangle,
    start: Object.freeze({ ...coordinates.start }),
    end: Object.freeze({ ...coordinates.end }),
  })
}

export function assertSelectionIdentity(
  expected: SelectionIdentity,
  actual: SelectionIdentity,
): void {
  if (
    expected.generation === actual.generation &&
    expected.layout === actual.layout &&
    expected.revision === actual.revision
  )
    return
  throw createGhosttyError(
    'selection.identity',
    `Selection identity changed (${expected.generation}/${expected.layout}/${expected.revision} to ${actual.generation}/${actual.layout}/${actual.revision})`,
  )
}

export class NativeSelectionHistory {
  private projection?: { readonly base: SelectionIdentity; revision: number }

  constructor(
    private readonly session: TerminalSession<Event>,
    private readonly context: () => Omit<SelectionIdentity, 'revision'>,
  ) {}

  private identity(): SelectionIdentity {
    return Object.freeze({ ...this.context(), revision: this.session.revision })
  }

  selectionSnapshot(options: TerminalSelectionFormatOptions = {}): TerminalSelectionSnapshot {
    const identity = this.identity()
    const text = this.session.getSelection(options)
    const coordinates = ownedSelectionCoordinates(this.session.selectionCoordinates())
    assertSelectionIdentity(identity, this.identity())
    if ((text === undefined) !== (coordinates === undefined)) {
      throw createGhosttyError(
        'selection.snapshot',
        'Native selection text and coordinates disagree',
      )
    }
    const selection =
      text !== undefined && coordinates ? Object.freeze({ text, coordinates }) : undefined
    return Object.freeze({ ...identity, selection })
  }

  getSelection(options?: TerminalSelectionFormatOptions): string | undefined {
    return this.selectionSnapshot(options).selection?.text
  }

  selectionCoordinates(): OwnedSelectionCoordinates | undefined {
    return ownedSelectionCoordinates(this.session.selectionCoordinates())
  }

  clearSelection(): boolean {
    return this.session.clearSelection()
  }
  selectAll(): boolean {
    return this.session.selectAll().selectionInstalled
  }
  selectRange(start: SelectionPoint, end: SelectionPoint): boolean {
    return this.session.selectRange(start, end).selectionInstalled
  }
  selectLines(startRow: number, endRow: number): boolean {
    return this.session.selectLines(startRow, endRow).selectionInstalled
  }

  selectionPress(input: TerminalSelectionPressInput, expected?: SelectionIdentity) {
    this.projection = undefined
    return this.updateGesture(expected, () => this.session.selectionPress(input))
  }
  selectionDrag(input: TerminalSelectionDragInput, expected?: SelectionIdentity) {
    return this.updateGesture(expected, () => this.session.selectionDrag(input))
  }
  selectionAutoscrollTick(input: TerminalSelectionDragInput, expected?: SelectionIdentity) {
    return this.updateGesture(expected, () => this.session.selectionAutoscrollTick(input))
  }
  selectionRelease(input?: TerminalSelectionReleaseInput, expected?: SelectionIdentity) {
    this.checkProjection(expected)
    this.projection = undefined
    return Object.freeze({ ...this.session.selectionRelease(input) })
  }
  resetSelectionGesture(): void {
    this.projection = undefined
    this.session.resetSelectionGesture()
  }

  scrollToTop() {
    return this.session.scrollToTop()
  }
  scrollToBottom() {
    return this.session.scrollToBottom()
  }
  scrollBy(delta: number) {
    return this.session.scrollBy(delta)
  }
  scrollToRow(row: number) {
    return this.session.scrollToRow(row)
  }
  lineCount(): number {
    return this.session.lineCount()
  }

  readLines(
    start: number,
    end: number,
    options?: ReadLinesOptions,
  ): readonly Readonly<TerminalLine>[] {
    return Object.freeze(
      this.session.readLines(start, end, options).map((line) => Object.freeze({ ...line })),
    )
  }

  historySnapshot(start: number, end: number, options?: ReadLinesOptions): TerminalHistorySnapshot {
    const identity = this.identity()
    const lineCount = this.lineCount()
    const lines = this.readLines(start, end, options)
    const scrollbar = Object.freeze({ ...this.session.scrollbar })
    assertSelectionIdentity(identity, this.identity())
    return Object.freeze({ ...identity, lineCount, lines, scrollbar })
  }

  private updateGesture(
    expected: SelectionIdentity | undefined,
    invoke: () => ReturnType<TerminalSession<Event>['selectionDrag']>,
  ) {
    if (!expected) {
      this.projection = undefined
      return Object.freeze({ ...invoke() })
    }
    this.checkProjection(expected)
    const before = this.identity()
    const offset = this.session.scrollbar.offset
    const update = invoke()
    const after = this.identity()
    const changed = update.selectionChanged || offset !== this.session.scrollbar.offset
    if (
      before.generation !== after.generation ||
      before.layout !== after.layout ||
      after.revision !== before.revision + Number(changed)
    )
      this.projection = undefined
    if (this.projection) this.projection.revision = after.revision
    return Object.freeze({ ...update })
  }

  private checkProjection(expected: SelectionIdentity | undefined): void {
    const actual = this.identity()
    const projection = this.projection
    // Only this gesture's own contiguous selection revisions preserve its displayed projection.
    if (
      expected &&
      projection &&
      actual.generation === projection.base.generation &&
      actual.layout === projection.base.layout &&
      actual.revision === projection.revision &&
      expected.generation === actual.generation &&
      expected.layout === actual.layout &&
      expected.revision >= projection.base.revision &&
      expected.revision <= projection.revision
    )
      return
    this.projection = undefined
    if (!expected) return
    assertSelectionIdentity(expected, actual)
    this.projection = { base: actual, revision: actual.revision }
  }
}
