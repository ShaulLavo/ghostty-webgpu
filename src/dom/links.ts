import type { RendererTextFrameSnapshot, RendererTextFrameRow } from '../render/renderer.js'
import type { LinkCell, LinkHit, LinkResolution } from '../term/links.js'
import type { TerminalLinkRequest } from '../term/types.js'
import {
  linkProjectionEquals,
  type LinkDiscoveryCell,
  type LinkDiscoveryHit,
  type LinkProjection,
} from '../term/link-snapshot.js'
import {
  projectPointerPosition,
  type CommittedPointerLayout,
  type RawPhysicalPointerPosition,
} from './pointer.js'

export interface DomLinkSession {
  activateLink(resolution: LinkResolution<Event>, event: Event): boolean | Promise<boolean>
  cancelLinkResolution?(): void
  findNextLink?(cells: readonly LinkDiscoveryCell[]): Promise<LinkDiscoveryHit<Event> | undefined>
  isLinkCurrent(resolution: LinkResolution<Event>): boolean | Promise<boolean>
  resolveLink(request: TerminalLinkRequest): LinkResolution<Event> | Promise<LinkResolution<Event>>
}

export interface DomLinkControllerOptions {
  readonly activationModifier?: (event: MouseEvent) => boolean
  readonly canvas: HTMLCanvasElement
  readonly getFrame?: () => RendererTextFrameSnapshot | undefined
  readonly getLayout: () => CommittedPointerLayout | undefined
  readonly getProjection?: () => LinkProjection | undefined
  readonly onError?: (cause: unknown, operation: string) => void
  readonly onHitChange?: (hit: LinkHit<Event> | undefined) => void
  readonly root: HTMLElement
  readonly session: DomLinkSession
  readonly signal?: AbortSignal
}

export interface DomLinkController {
  readonly needsFrame: boolean
  readonly currentHit: LinkHit<Event> | undefined
  readonly hasPendingResolution: boolean
  dispose(): void
  focusNextLink(): Promise<boolean>
  invalidate(): void
  updateFrame(snapshot: RendererTextFrameSnapshot): void
}

interface PointerPoint {
  readonly clientX: number
  readonly clientY: number
}

interface CursorDeclaration {
  readonly priority: string
  readonly value: string
}

interface LinkScope {
  readonly generation: number
  readonly projection: LinkProjection | undefined
}

interface LinkQuery {
  readonly column: number
  readonly frameRevision: number
  readonly projection: LinkProjection | undefined
  readonly row: number
}

interface ResolvedCell {
  readonly column: number
  readonly row: number
}

interface FrameCell extends ResolvedCell {
  readonly frameRow: RendererTextFrameRow
}

function isApplePlatform(view: Window): boolean {
  return /^(Mac|iPhone|iPad|iPod)/iu.test(view.navigator.platform)
}

function defaultActivationModifier(view: Window, event: MouseEvent): boolean {
  if (isApplePlatform(view)) return event.metaKey
  return event.ctrlKey
}

function queryEquals(left: LinkQuery | undefined, right: LinkQuery): boolean {
  if (!left) return false
  return (
    left.column === right.column &&
    left.frameRevision === right.frameRevision &&
    left.row === right.row &&
    (left.projection === right.projection ||
      linkProjectionEquals(left.projection, right.projection))
  )
}

function physicalPointInsideGrid(
  point: RawPhysicalPointerPosition,
  layout: CommittedPointerLayout,
): boolean {
  const physical = layout.physical
  const right = physical.paddingLeft + physical.deviceCellWidth * layout.grid.columns
  const bottom = physical.paddingTop + physical.deviceCellHeight * layout.grid.rows
  if (point.x < physical.paddingLeft || point.x >= right) return false
  return point.y >= physical.paddingTop && point.y < bottom
}

function frameRow(
  snapshot: RendererTextFrameSnapshot,
  row: number,
): RendererTextFrameRow | undefined {
  return snapshot.rows.find((candidate) => candidate.y === row)
}

function linkCells(row: RendererTextFrameRow): readonly LinkCell[] {
  return row.cells.map((text, column) =>
    Object.freeze({ continuation: row.continuations[column] === true, text: text.slice() }),
  )
}

function frameContentEquals(
  left: RendererTextFrameSnapshot | undefined,
  right: RendererTextFrameSnapshot,
): boolean {
  if (!left || left.rows.length !== right.rows.length) return false
  for (let rowIndex = 0; rowIndex < left.rows.length; rowIndex += 1) {
    const leftRow = left.rows[rowIndex]!
    const rightRow = right.rows[rowIndex]!
    if (leftRow === rightRow) continue
    if (leftRow.text !== rightRow.text) return false
    if (leftRow.y !== rightRow.y || leftRow.cells.length !== rightRow.cells.length) return false
    for (let column = 0; column < leftRow.cells.length; column += 1) {
      if (leftRow.cells[column] !== rightRow.cells[column]) return false
      if (leftRow.continuations[column] !== rightRow.continuations[column]) return false
    }
  }
  return true
}

function frameCells(snapshot: RendererTextFrameSnapshot): readonly FrameCell[] {
  const result: FrameCell[] = []
  const rows = snapshot.rows.toSorted((left, right) => left.y - right.y)
  for (const row of rows) {
    for (let column = 0; column < row.cells.length; column += 1) {
      if (row.continuations[column]) continue
      result.push({ column, frameRow: row, row: row.y })
    }
  }
  return result
}

function discoveryStart(cells: readonly FrameCell[], hit: LinkHit<Event> | undefined): number {
  if (!hit) return 0
  const index = cells.findIndex(
    (cell) => cell.row > hit.row || (cell.row === hit.row && cell.column > hit.range.end),
  )
  if (index >= 0) return index
  return 0
}

function orderedDiscoveryCells(
  snapshot: RendererTextFrameSnapshot,
  currentHit: LinkHit<Event> | undefined,
): readonly FrameCell[] {
  const cells = frameCells(snapshot)
  const start = discoveryStart(cells, currentHit)
  return Object.freeze(cells.slice(start).concat(cells.slice(0, start)))
}

function cellInsideHit(cell: ResolvedCell, hit: LinkHit<Event>): boolean {
  if (cell.row !== hit.row) return false
  return cell.column >= hit.range.start && cell.column <= hit.range.end
}

function accessibleHitLabel(hit: LinkHit<Event>): string {
  if (hit.text.length > 0) return hit.text
  if (hit.source !== 'provider') return hit.uri
  return 'Terminal link'
}

function applyOverlayStyles(overlay: HTMLDivElement): void {
  overlay.style.borderBottom = '1px solid currentColor'
  overlay.style.boxSizing = 'border-box'
  overlay.style.pointerEvents = 'none'
  overlay.style.position = 'absolute'
  overlay.style.zIndex = '1'
}

class BrowserLinkController implements DomLinkController {
  private activationPointer?: number
  private claimedClick = false
  private readonly abortController = new AbortController()
  private currentResolution?: LinkResolution<Event>
  private currentScope?: LinkScope
  private disposed = false
  private frameRevision = 0
  private frameSnapshot?: RendererTextFrameSnapshot
  private frameProjection?: LinkProjection
  private generation = 0
  private lastPoint?: PointerPoint
  private lastQuery?: LinkQuery
  private readonly overlay: HTMLDivElement
  private pendingGeneration?: number
  private replacedCursor?: CursorDeclaration
  private readonly view: Window

  constructor(private readonly options: DomLinkControllerOptions) {
    const view = options.canvas.ownerDocument.defaultView
    if (!view) throw new TypeError('canvas must belong to a document with a window')
    if (options.root.ownerDocument !== options.canvas.ownerDocument) {
      throw new TypeError('root and canvas must belong to the same document')
    }
    this.view = view
    this.overlay = options.canvas.ownerDocument.createElement('div')
    this.overlay.className = 'ghostty-webgpu-link'
    this.overlay.setAttribute('role', 'link')
    this.overlay.tabIndex = 0
    applyOverlayStyles(this.overlay)
    this.attach()
  }

  get needsFrame(): boolean {
    return (
      this.lastPoint !== undefined ||
      this.pendingGeneration !== undefined ||
      this.options.canvas.ownerDocument.activeElement === this.overlay
    )
  }

  get currentHit(): LinkHit<Event> | undefined {
    return this.currentResolution?.hit
  }

  get hasPendingResolution(): boolean {
    return this.pendingGeneration !== undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.advanceGeneration()
    this.pendingGeneration = undefined
    this.finishActivationGesture()
    this.abortController.abort()
    this.clearVisibleHit()
    this.lastPoint = undefined
    this.frameSnapshot = undefined
  }

  invalidate(): void {
    if (this.disposed) return
    this.frameRevision += 1
    this.advanceGeneration()
    this.pendingGeneration = undefined
    this.finishActivationGesture()
    this.lastQuery = undefined
    this.frameSnapshot = undefined
    this.clearVisibleHit()
  }

  updateFrame(snapshot: RendererTextFrameSnapshot): void {
    if (this.disposed) return
    if (this.preserveEquivalentFrame(snapshot)) return
    this.frameRevision += 1
    this.advanceGeneration()
    this.pendingGeneration = undefined
    this.lastQuery = undefined
    this.frameSnapshot = snapshot
    this.frameProjection = this.readProjection()
    this.clearVisibleHit()
    if (this.lastPoint) this.requestResolution(this.lastPoint)
  }

  async focusNextLink(): Promise<boolean> {
    const snapshot = this.readFrame()
    if (this.disposed || !snapshot) return false
    const cells = orderedDiscoveryCells(snapshot, this.currentHit)
    if (cells.length === 0) return false
    const scope = this.beginResolution()
    this.lastPoint = undefined
    this.lastQuery = undefined
    this.clearVisibleHit()
    if (this.options.session.findNextLink) return this.discoverBatch(cells, scope)
    for (const cell of cells) {
      const resolution = await this.resolveForCell(cell.frameRow, cell, scope)
      if (!resolution || !this.isScopeCurrent(scope)) {
        this.finishResolution(scope)
        return false
      }
      if (!resolution.hit || !cellInsideHit(cell, resolution.hit)) continue
      this.pendingGeneration = undefined
      return this.focusHit(cell, resolution, scope)
    }
    this.finishResolution(scope)
    return false
  }

  private async discoverBatch(
    cells: readonly LinkDiscoveryCell[],
    scope: LinkScope,
  ): Promise<boolean> {
    if (!this.isScopeCurrent(scope)) {
      this.finishResolution(scope)
      return false
    }
    try {
      const found = await this.options.session.findNextLink?.(cells)
      if (!this.isScopeCurrent(scope) || !found) {
        this.finishResolution(scope)
        return false
      }
      const current = await this.options.session.isLinkCurrent(found.resolution)
      if (!this.finishResolution(scope) || !current) return false
      return this.focusHit(found.cell, found.resolution, scope)
    } catch (cause) {
      if (!this.finishResolution(scope)) return false
      this.options.onError?.(cause, 'resolve')
      return false
    }
  }

  private focusHit(
    cell: ResolvedCell,
    resolution: LinkResolution<Event>,
    scope: LinkScope,
  ): boolean {
    this.commitHit(cell, resolution, scope)
    if (!this.isScopeCurrent(scope) || this.currentResolution !== resolution) return false
    this.overlay.focus({ preventScroll: true })
    return true
  }

  private attach(): void {
    const signal = this.abortController.signal
    this.options.canvas.addEventListener('pointerdown', this.handleActivationPointerDown, {
      capture: true,
      signal,
    })
    this.options.canvas.addEventListener('pointermove', this.handleActivationPointerMove, {
      capture: true,
      signal,
    })
    this.options.canvas.addEventListener('pointerup', this.handleActivationPointerUp, {
      capture: true,
      signal,
    })
    this.options.canvas.addEventListener('pointercancel', this.handleActivationPointerCancel, {
      capture: true,
      signal,
    })
    this.options.canvas.addEventListener('lostpointercapture', this.handleLostPointerCapture, {
      signal,
    })
    this.view.addEventListener('blur', this.handleWindowBlur, { signal })
    this.options.canvas.addEventListener('pointermove', this.handlePointerMove, { signal })
    this.options.canvas.addEventListener('pointerleave', this.handlePointerLeave, { signal })
    this.options.canvas.addEventListener('click', this.handleClick, { capture: true, signal })
    this.overlay.addEventListener('keydown', this.handleOverlayKeyDown, { signal })
    this.options.signal?.addEventListener('abort', this.handleAbort, { once: true, signal })
    if (this.options.signal?.aborted) this.dispose()
  }

  private readonly handleAbort = (): void => {
    this.dispose()
  }

  private readonly handleActivationPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== this.activationPointer) return
    this.consumeActivationEvent(event)
    this.finishActivationGesture()
  }

  private readonly handleActivationPointerDown = (event: PointerEvent): void => {
    this.claimedClick = false
    if (event.button !== 0 || !this.activationModifier(event)) return
    if (!this.currentResolutionAt(event)) return
    this.activationPointer = event.pointerId
    if (!this.captureActivationPointer(event.pointerId)) {
      this.activationPointer = undefined
      return
    }
    this.consumeActivationEvent(event)
  }

  private readonly handleActivationPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activationPointer) return
    this.consumeActivationEvent(event)
  }

  private readonly handleActivationPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activationPointer) return
    this.claimedClick = true
    this.consumeActivationEvent(event)
    this.finishActivationGesture()
  }

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId !== this.activationPointer) return
    this.finishActivationGesture()
  }

  private readonly handleWindowBlur = (): void => {
    this.claimedClick = false
    this.finishActivationGesture()
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const claimed = this.claimedClick
    this.claimedClick = false
    if (!claimed) return
    const resolution = this.currentResolutionAt(event)
    if (!resolution) return
    this.consumeActivationEvent(event)
    this.activate(resolution, event)
  }

  private readonly handleOverlayKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const resolution = this.currentResolution
    if (!resolution?.hit || !this.currentScope || !this.isScopeCurrent(this.currentScope)) return
    event.preventDefault()
    this.activate(resolution, event)
  }

  private readonly handlePointerLeave = (): void => {
    if (this.activationPointer !== undefined) return
    if (this.options.canvas.ownerDocument.activeElement === this.overlay) return
    this.lastPoint = undefined
    this.lastQuery = undefined
    this.advanceGeneration()
    this.pendingGeneration = undefined
    this.clearVisibleHit()
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const point = { clientX: event.clientX, clientY: event.clientY }
    this.lastPoint = point
    this.requestResolution(point)
  }

  private activate(resolution: LinkResolution<Event>, event: Event): void {
    const scope = this.currentScope
    if (!scope) return
    void this.activateCurrent(resolution, event, scope)
  }

  private async activateCurrent(
    resolution: LinkResolution<Event>,
    event: Event,
    scope: LinkScope,
  ): Promise<void> {
    try {
      const currency = this.options.session.isLinkCurrent(resolution)
      const current = currency instanceof Promise ? await currency : currency
      if (!current || !this.isScopeCurrent(scope) || this.currentResolution !== resolution) return
      await this.options.session.activateLink(resolution, event)
    } catch (cause) {
      if (!this.isScopeCurrent(scope)) return
      this.options.onError?.(cause, 'activate')
    }
  }

  private captureActivationPointer(pointerId: number): boolean {
    try {
      this.options.canvas.setPointerCapture(pointerId)
      return true
    } catch {
      return false
    }
  }

  private consumeActivationEvent(event: Event): void {
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  private currentResolutionAt(point: PointerPoint): LinkResolution<Event> | undefined {
    const cell = this.cellAt(point)
    const resolution = this.currentResolution
    const hit = resolution?.hit
    if (!cell || !resolution || !hit || !cellInsideHit(cell, hit)) return undefined
    if (!this.currentScope || !this.isScopeCurrent(this.currentScope)) return undefined
    return resolution
  }

  private finishActivationGesture(): void {
    const pointerId = this.activationPointer
    this.activationPointer = undefined
    if (pointerId === undefined) return
    try {
      if (this.options.canvas.hasPointerCapture(pointerId)) {
        this.options.canvas.releasePointerCapture(pointerId)
      }
    } catch {
      return
    }
  }

  private activationModifier(event: MouseEvent): boolean {
    const configured = this.options.activationModifier
    if (configured) return configured(event)
    return defaultActivationModifier(this.view, event)
  }

  private cellAt(point: PointerPoint): ResolvedCell | undefined {
    const layout = this.options.getLayout()
    if (!layout) return undefined
    const projection = projectPointerPosition(point, layout)
    if (!physicalPointInsideGrid(projection.raw, layout)) return undefined
    return {
      column: projection.selection.viewport.x,
      row: projection.selection.viewport.y,
    }
  }

  private clearVisibleHit(): void {
    const changed = this.currentResolution?.hit !== undefined
    this.currentResolution = undefined
    this.currentScope = undefined
    if (!changed) return
    this.overlay.remove()
    const cursor = this.replacedCursor
    this.replacedCursor = undefined
    const style = this.options.canvas.style
    if (
      cursor &&
      style.getPropertyValue('cursor') === 'pointer' &&
      style.getPropertyPriority('cursor') === 'important'
    ) {
      style.setProperty('cursor', cursor.value, cursor.priority)
    }
    this.options.onHitChange?.(undefined)
  }

  private readFrame(): RendererTextFrameSnapshot | undefined {
    if (this.disposed) return undefined
    if (!this.frameSnapshot) {
      this.frameSnapshot = this.options.getFrame?.()
      this.frameProjection = this.readProjection()
    }
    return this.frameSnapshot
  }

  private requestResolution(point: PointerPoint): void {
    const snapshot = this.readFrame()
    const cell = this.cellAt(point)
    if (!snapshot || !cell) {
      this.lastQuery = undefined
      this.advanceGeneration()
      this.pendingGeneration = undefined
      this.clearVisibleHit()
      return
    }
    const query = { ...cell, frameRevision: this.frameRevision, projection: this.readProjection() }
    if (queryEquals(this.lastQuery, query)) return
    this.lastQuery = query
    const scope = this.beginResolution()
    this.clearVisibleHit()
    void this.resolveCell(snapshot, cell, scope)
  }

  private async resolveCell(
    snapshot: RendererTextFrameSnapshot,
    cell: ResolvedCell,
    scope: LinkScope,
  ): Promise<void> {
    const row = frameRow(snapshot, cell.row)
    if (!row) {
      this.finishResolution(scope)
      return
    }
    const resolution = await this.resolveForCell(row, cell, scope)
    if (!this.finishResolution(scope) || !resolution?.hit) return
    this.commitHit(cell, resolution, scope)
  }

  private async resolveForCell(
    row: RendererTextFrameRow,
    cell: ResolvedCell,
    scope: LinkScope,
  ): Promise<LinkResolution<Event> | undefined> {
    if (!this.isScopeCurrent(scope)) {
      this.finishResolution(scope)
      return undefined
    }
    try {
      const resolution = await this.options.session.resolveLink({
        column: cell.column,
        line: linkCells(row),
        row: cell.row,
      })
      if (!this.isScopeCurrent(scope)) {
        this.finishResolution(scope)
        return undefined
      }
      const current = await this.options.session.isLinkCurrent(resolution)
      if (current && this.isScopeCurrent(scope)) return resolution
      this.finishResolution(scope)
      return undefined
    } catch (cause) {
      if (!this.finishResolution(scope)) return undefined
      this.options.onError?.(cause, 'resolve')
      return undefined
    }
  }

  private preserveEquivalentFrame(snapshot: RendererTextFrameSnapshot): boolean {
    if (!frameContentEquals(this.frameSnapshot, snapshot)) return false
    if (
      this.options.getProjection &&
      !linkProjectionEquals(this.frameProjection, this.readProjection())
    )
      return false
    this.frameSnapshot = snapshot
    const resolution = this.currentResolution
    if (resolution) {
      const current = this.options.session.isLinkCurrent(resolution)
      if (current === false) return false
      if (typeof current !== 'boolean') {
        void this.validatePreservedHit(resolution, current)
        return true
      }
    }
    const hit = resolution?.hit
    const layout = this.options.getLayout()
    if (hit && layout) this.positionOverlay(hit, layout)
    return true
  }

  private async validatePreservedHit(
    resolution: LinkResolution<Event>,
    current: Promise<boolean>,
  ): Promise<void> {
    const scope = this.currentScope
    try {
      const valid = await current
      if (!scope || !this.isScopeCurrent(scope) || this.currentResolution !== resolution) return
      if (valid) {
        const layout = this.options.getLayout()
        if (resolution.hit && layout) this.positionOverlay(resolution.hit, layout)
        return
      }
      this.lastQuery = undefined
      this.clearVisibleHit()
    } catch (cause) {
      if (!scope || !this.isScopeCurrent(scope) || this.currentResolution !== resolution) return
      this.lastQuery = undefined
      this.clearVisibleHit()
      this.options.onError?.(cause, 'resolve')
    }
  }

  private readProjection(): LinkProjection | undefined {
    const projection = this.options.getProjection?.()
    return projection ? Object.freeze({ ...projection }) : undefined
  }

  private advanceGeneration(): void {
    this.generation += 1
    this.options.session.cancelLinkResolution?.()
  }

  private beginResolution(): LinkScope {
    this.advanceGeneration()
    this.pendingGeneration = this.generation
    return { generation: this.generation, projection: this.readProjection() }
  }

  private isScopeCurrent(scope: LinkScope): boolean {
    if (this.disposed || scope.generation !== this.generation) return false
    if (!this.options.getProjection) return true
    return linkProjectionEquals(scope.projection, this.options.getProjection())
  }

  private finishResolution(scope: LinkScope): boolean {
    if (scope.generation === this.generation) this.pendingGeneration = undefined
    return this.isScopeCurrent(scope)
  }

  private commitHit(cell: ResolvedCell, resolution: LinkResolution<Event>, scope: LinkScope): void {
    const hit = resolution.hit
    const layout = this.options.getLayout()
    if (!hit || !layout || !cellInsideHit(cell, hit) || !this.isScopeCurrent(scope)) return
    this.currentResolution = resolution
    this.currentScope = scope
    this.positionOverlay(hit, layout)
    const style = this.options.canvas.style
    const value = style.getPropertyValue('cursor')
    const priority = style.getPropertyPriority('cursor')
    if (value !== 'pointer' || priority !== 'important') {
      this.replacedCursor = { value, priority }
      // Link hover must remain visible above important author cursor rules.
      style.setProperty('cursor', 'pointer', 'important')
    }
    this.options.onHitChange?.(hit)
  }

  private positionOverlay(hit: LinkHit<Event>, layout: CommittedPointerLayout): void {
    const ratio = layout.grid.pixelRatio
    const left = layout.physical.paddingLeft / ratio + hit.range.start * layout.grid.cellWidth
    const top = layout.physical.paddingTop / ratio + hit.row * layout.grid.cellHeight
    const cells = hit.range.end - hit.range.start + 1
    this.overlay.style.height = `${layout.grid.cellHeight}px`
    this.overlay.style.left = `${left}px`
    this.overlay.style.top = `${top}px`
    this.overlay.style.width = `${cells * layout.grid.cellWidth}px`
    this.overlay.setAttribute('aria-label', accessibleHitLabel(hit))
    if (this.overlay.parentElement !== this.options.root) this.options.root.append(this.overlay)
  }
}

export function createDomLinkController(options: DomLinkControllerOptions): DomLinkController {
  return new BrowserLinkController(options)
}
