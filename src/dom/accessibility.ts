import type { TerminalScrollbar } from '../core/types.js'
import type { RendererFrameRow, RendererFrameSnapshot } from '../render/renderer.js'

export interface TerminalAccessibilityOptions {
  readonly label?: string
  readonly liveRegionMaxCharacters?: number
  readonly liveRegionMaxEntries?: number
  readonly root: HTMLElement
  readonly signal?: AbortSignal
  readonly textarea: HTMLTextAreaElement
}

export interface TerminalAccessibilityUpdate {
  readonly announced: boolean
  readonly full: boolean
  readonly updatedRows: number
}

export interface TerminalAccessibilityController {
  readonly cursorStatus: HTMLDivElement
  readonly liveRegion: HTMLDivElement
  readonly mirror: HTMLDivElement
  readonly rowElements: readonly HTMLDivElement[]
  dispose(): void
  notifyOutput(): void
  update(
    snapshot: RendererFrameSnapshot,
    scrollbar: Readonly<TerminalScrollbar>,
  ): TerminalAccessibilityUpdate
}

interface AccessibilityRow {
  readonly identity: string
  readonly text: string
  readonly y: number
}

interface PreviousFrame {
  readonly byIdentity: ReadonlyMap<string, string>
  readonly offset: number
  readonly rows: readonly AccessibilityRow[]
  readonly total: number
}

interface TextareaAttributes {
  readonly activeDescendant: string | null
  readonly controls: string | null
  readonly describedBy: string | null
  readonly label: string | null
}

const defaultLabel = 'Terminal input'
const defaultLiveRegionMaxCharacters = 1_024
const defaultLiveRegionMaxEntries = 8
let accessibilityId = 0

function positiveSafeInteger(name: string, value: number): number {
  if (Number.isSafeInteger(value) && value > 0) return value
  throw new RangeError(`${name} must be a positive safe integer`)
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (Number.isSafeInteger(value) && value >= 0) return value
  throw new RangeError(`${name} must be a non-negative safe integer`)
}

function nonEmptyLabel(value: string | undefined): string {
  const label = value ?? defaultLabel
  if (label.trim().length > 0) return label
  throw new TypeError('label must not be empty')
}

function withIdReference(current: string | null, id: string): string {
  if (!current) return id
  const ids = current.split(/\s+/u)
  if (ids.includes(id)) return current
  return `${current} ${id}`
}

function applyOffscreenStyles(element: HTMLElement): void {
  element.style.border = '0'
  element.style.clip = 'rect(0 0 0 0)'
  element.style.clipPath = 'inset(50%)'
  element.style.height = '1px'
  element.style.margin = '-1px'
  element.style.overflow = 'hidden'
  element.style.padding = '0'
  element.style.position = 'absolute'
  element.style.whiteSpace = 'nowrap'
  element.style.width = '1px'
}

function nextElementId(document: Document, suffix: string): string {
  let id: string
  do {
    accessibilityId += 1
    id = `ghostty-webgpu-${suffix}-${accessibilityId}`
  } while (document.getElementById(id))
  return id
}

function setAttribute(element: Element, name: string, value: string): boolean {
  if (element.getAttribute(name) === value) return false
  element.setAttribute(name, value)
  return true
}

function restoreAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) {
    element.removeAttribute(name)
    return
  }
  element.setAttribute(name, value)
}

function normalizedRowText(row: RendererFrameRow): string {
  return row.text.trimEnd()
}

function rowIdentity(offset: number, y: number): string {
  return (BigInt(offset) + BigInt(y)).toString()
}

function ariaPosition(offset: number, y: number): string {
  return (BigInt(offset) + BigInt(y) + 1n).toString()
}

function normalizeRows(
  rows: readonly RendererFrameRow[],
  scrollbar: Readonly<TerminalScrollbar>,
): readonly AccessibilityRow[] {
  const normalized = rows.map((row) => {
    const y = nonNegativeSafeInteger('frame row y', row.y)
    return {
      identity: rowIdentity(scrollbar.offset, y),
      text: normalizedRowText(row),
      y,
    }
  })
  normalized.sort((left, right) => left.y - right.y)
  return normalized
}

function validateScrollbar(scrollbar: Readonly<TerminalScrollbar>): void {
  const length = nonNegativeSafeInteger('scrollbar length', scrollbar.length)
  const offset = nonNegativeSafeInteger('scrollbar offset', scrollbar.offset)
  const total = nonNegativeSafeInteger('scrollbar total', scrollbar.total)
  if (length > total) throw new RangeError('scrollbar length must not exceed total')
  if (offset <= total - length) return
  throw new RangeError('scrollbar offset must not exceed the last viewport row')
}

function frameByIdentity(rows: readonly AccessibilityRow[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const row of rows) result.set(row.identity, row.text)
  return result
}

function previousFrame(
  rows: readonly AccessibilityRow[],
  scrollbar: Readonly<TerminalScrollbar>,
): PreviousFrame {
  return {
    byIdentity: frameByIdentity(rows),
    offset: scrollbar.offset,
    rows: rows.map((row) => ({ ...row })),
    total: scrollbar.total,
  }
}

function isAtBottom(scrollbar: Readonly<TerminalScrollbar>): boolean {
  return scrollbar.offset === scrollbar.total - scrollbar.length
}

function changedOutput(previous: PreviousFrame, rows: readonly AccessibilityRow[]): string {
  const changed: string[] = []
  for (const row of rows) {
    const before = previous.byIdentity.get(row.identity)
    if (before === row.text) continue
    if (before === undefined) {
      if (BigInt(row.identity) >= BigInt(previous.total) && row.text.length > 0)
        changed.push(row.text)
      continue
    }
    if (row.text.startsWith(before)) {
      const suffix = row.text.slice(before.length)
      if (suffix.length > 0) changed.push(suffix)
      continue
    }
    if (row.text.length > 0) changed.push(row.text)
  }
  return changed.join('\n')
}

function cursorCoordinates(
  snapshot: RendererFrameSnapshot,
  scrollbar: Readonly<TerminalScrollbar>,
): { readonly column: string; readonly row: string; readonly viewportRow: number } | undefined {
  const viewport = snapshot.cursor.viewport
  if (!viewport || !snapshot.cursor.visible) return undefined
  const leadingColumn = viewport.wideTail ? Math.max(0, viewport.x - 1) : viewport.x
  return {
    column: (BigInt(leadingColumn) + 1n).toString(),
    row: ariaPosition(scrollbar.offset, viewport.y),
    viewportRow: viewport.y,
  }
}

class OwnedTerminalAccessibility implements TerminalAccessibilityController {
  private readonly announcements: HTMLDivElement[] = []
  private disposed = false
  private outputPending = false
  private previous?: PreviousFrame
  private readonly rows: HTMLDivElement[] = []

  constructor(
    readonly mirror: HTMLDivElement,
    readonly cursorStatus: HTMLDivElement,
    readonly liveRegion: HTMLDivElement,
    private readonly container: HTMLDivElement | undefined,
    private readonly root: HTMLElement,
    private readonly textarea: HTMLTextAreaElement,
    private readonly textareaAttributes: TextareaAttributes,
    private readonly xtermFacade: boolean,
    private readonly liveRegionMaxEntries: number,
    private readonly liveRegionMaxCharacters: number,
    private readonly signal: AbortSignal | undefined,
    private readonly abortListener: () => void,
  ) {}

  get rowElements(): readonly HTMLDivElement[] {
    return this.rows
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.signal?.removeEventListener('abort', this.abortListener)
    restoreAttribute(
      this.textarea,
      'aria-activedescendant',
      this.textareaAttributes.activeDescendant,
    )
    restoreAttribute(this.textarea, 'aria-controls', this.textareaAttributes.controls)
    restoreAttribute(this.textarea, 'aria-describedby', this.textareaAttributes.describedBy)
    restoreAttribute(this.textarea, 'aria-label', this.textareaAttributes.label)
    this.mirror.remove()
    this.cursorStatus.remove()
    this.liveRegion.remove()
    this.container?.remove()
    this.rows.length = 0
    this.announcements.length = 0
    this.previous = undefined
    this.outputPending = false
  }

  notifyOutput(): void {
    if (this.disposed) return
    this.outputPending = true
  }

  update(
    snapshot: RendererFrameSnapshot,
    scrollbar: Readonly<TerminalScrollbar>,
  ): TerminalAccessibilityUpdate {
    if (this.disposed) return { announced: false, full: false, updatedRows: 0 }
    validateScrollbar(scrollbar)
    const rows = normalizeRows(snapshot.rows, scrollbar)
    const full = this.requiresFullUpdate(rows, scrollbar)
    this.resizeRows(rows.length)
    const updatedRows = this.updateRows(rows, scrollbar, full)
    this.updateCursor(snapshot, scrollbar, rows)
    const announced = this.announcePendingOutput(rows, scrollbar)
    this.previous = previousFrame(rows, scrollbar)
    this.outputPending = false
    return { announced, full, updatedRows }
  }

  private requiresFullUpdate(
    rows: readonly AccessibilityRow[],
    scrollbar: Readonly<TerminalScrollbar>,
  ): boolean {
    const previous = this.previous
    if (!previous) return true
    if (previous.offset !== scrollbar.offset || previous.total !== scrollbar.total) return true
    if (previous.rows.length !== rows.length) return true
    return previous.rows.some((row, index) => row.identity !== rows[index]?.identity)
  }

  private resizeRows(count: number): void {
    while (this.rows.length > count) this.rows.pop()?.remove()
    while (this.rows.length < count) {
      const row = this.root.ownerDocument.createElement('div')
      row.id = nextElementId(this.root.ownerDocument, 'row')
      row.setAttribute('role', 'listitem')
      if (this.xtermFacade) row.tabIndex = -1
      this.mirror.append(row)
      this.rows.push(row)
    }
  }

  private updateRows(
    rows: readonly AccessibilityRow[],
    scrollbar: Readonly<TerminalScrollbar>,
    full: boolean,
  ): number {
    let updated = 0
    for (let index = 0; index < rows.length; index += 1) {
      const source = rows[index]!
      const target = this.rows[index]!
      let changed = full
      if (target.textContent !== source.text) {
        target.textContent = source.text
        changed = true
      }
      if (setAttribute(target, 'aria-posinset', ariaPosition(scrollbar.offset, source.y)))
        changed = true
      if (setAttribute(target, 'aria-setsize', scrollbar.total.toString())) changed = true
      if (setAttribute(target, 'data-row', source.identity)) changed = true
      if (changed) updated += 1
    }
    return updated
  }

  private updateCursor(
    snapshot: RendererFrameSnapshot,
    scrollbar: Readonly<TerminalScrollbar>,
    rows: readonly AccessibilityRow[],
  ): void {
    const coordinates = cursorCoordinates(snapshot, scrollbar)
    this.cursorStatus.textContent = coordinates
      ? `Cursor at row ${coordinates.row}, column ${coordinates.column}`
      : 'Cursor location unavailable'
    if (this.xtermFacade) return
    const activeRow = this.updateCurrentRow(rows, coordinates?.viewportRow)
    if (!coordinates) {
      this.textarea.removeAttribute('aria-activedescendant')
      return
    }
    if (activeRow) {
      this.textarea.setAttribute('aria-activedescendant', activeRow.id)
      return
    }
    this.textarea.removeAttribute('aria-activedescendant')
  }

  private updateCurrentRow(
    rows: readonly AccessibilityRow[],
    viewportRow: number | undefined,
  ): HTMLDivElement | undefined {
    let activeRow: HTMLDivElement | undefined
    for (let index = 0; index < this.rows.length; index += 1) {
      const row = this.rows[index]!
      if (viewportRow !== rows[index]?.y) {
        row.removeAttribute('aria-current')
        continue
      }
      row.setAttribute('aria-current', 'true')
      activeRow = row
    }
    return activeRow
  }

  private announcePendingOutput(
    rows: readonly AccessibilityRow[],
    scrollbar: Readonly<TerminalScrollbar>,
  ): boolean {
    const previous = this.previous
    if (!this.outputPending || !previous || !isAtBottom(scrollbar)) return false
    const output = changedOutput(previous, rows)
    if (output.length === 0) return false
    this.appendAnnouncement(output)
    return true
  }

  private appendAnnouncement(output: string): void {
    const document = this.root.ownerDocument
    const entry = document.createElement('div')
    entry.textContent = output.slice(-this.liveRegionMaxCharacters)
    this.liveRegion.append(entry)
    this.announcements.push(entry)
    this.trimAnnouncements()
  }

  private trimAnnouncements(): void {
    while (this.announcements.length > this.liveRegionMaxEntries) {
      this.announcements.shift()?.remove()
    }
    let characters = this.announcementCharacters()
    while (characters > this.liveRegionMaxCharacters && this.announcements.length > 1) {
      const removed = this.announcements.shift()
      characters -= removed?.textContent?.length ?? 0
      removed?.remove()
    }
  }

  private announcementCharacters(): number {
    let characters = 0
    for (const entry of this.announcements) characters += entry.textContent?.length ?? 0
    return characters
  }
}

export function createTerminalAccessibility(
  options: TerminalAccessibilityOptions,
): TerminalAccessibilityController {
  const document = options.root.ownerDocument
  if (options.textarea.ownerDocument !== document)
    throw new TypeError('root and textarea must belong to the same document')
  const xtermFacade = options.root.classList.contains('xterm')
  const existingLabel = options.textarea.getAttribute('aria-label')
  const label =
    xtermFacade && options.label === undefined
      ? (existingLabel ?? defaultLabel)
      : nonEmptyLabel(options.label)
  const maxEntries = positiveSafeInteger(
    'liveRegionMaxEntries',
    options.liveRegionMaxEntries ?? defaultLiveRegionMaxEntries,
  )
  const maxCharacters = positiveSafeInteger(
    'liveRegionMaxCharacters',
    options.liveRegionMaxCharacters ?? defaultLiveRegionMaxCharacters,
  )
  const mirror = document.createElement('div')
  const cursorStatus = document.createElement('div')
  const liveRegion = document.createElement('div')
  const container = xtermFacade ? document.createElement('div') : undefined
  mirror.classList.add('ghostty-webgpu-accessibility')
  if (xtermFacade) mirror.classList.add('xterm-accessibility-tree')
  mirror.id = nextElementId(document, 'screen')
  if (!xtermFacade) mirror.setAttribute('aria-label', 'Terminal screen')
  mirror.setAttribute('role', 'list')
  cursorStatus.className = 'ghostty-webgpu-cursor-status'
  cursorStatus.id = nextElementId(document, 'cursor')
  cursorStatus.textContent = 'Cursor location unavailable'
  liveRegion.classList.add('ghostty-webgpu-live-region')
  if (xtermFacade) liveRegion.classList.add('live-region')
  liveRegion.setAttribute('aria-atomic', 'false')
  liveRegion.setAttribute('aria-live', xtermFacade ? 'assertive' : 'polite')
  liveRegion.setAttribute('aria-relevant', 'additions text')
  applyOffscreenStyles(cursorStatus)
  if (!xtermFacade) {
    applyOffscreenStyles(mirror)
    applyOffscreenStyles(liveRegion)
  }

  const textareaAttributes: TextareaAttributes = {
    activeDescendant: options.textarea.getAttribute('aria-activedescendant'),
    controls: options.textarea.getAttribute('aria-controls'),
    describedBy: options.textarea.getAttribute('aria-describedby'),
    label: options.textarea.getAttribute('aria-label'),
  }
  if (!xtermFacade) {
    options.textarea.setAttribute(
      'aria-controls',
      withIdReference(textareaAttributes.controls, mirror.id),
    )
    options.textarea.setAttribute(
      'aria-describedby',
      withIdReference(textareaAttributes.describedBy, cursorStatus.id),
    )
  }
  options.textarea.setAttribute('aria-label', label)
  if (container) {
    container.className = 'xterm-accessibility'
    container.append(mirror, liveRegion)
    options.root.prepend(container)
    options.root.append(cursorStatus)
  } else {
    options.root.append(mirror, cursorStatus, liveRegion)
  }

  let controller: OwnedTerminalAccessibility
  const abortListener = () => controller.dispose()
  controller = new OwnedTerminalAccessibility(
    mirror,
    cursorStatus,
    liveRegion,
    container,
    options.root,
    options.textarea,
    textareaAttributes,
    xtermFacade,
    maxEntries,
    maxCharacters,
    options.signal,
    abortListener,
  )
  options.signal?.addEventListener('abort', abortListener, { once: true })
  if (options.signal?.aborted) controller.dispose()
  return controller
}
