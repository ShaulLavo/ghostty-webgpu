import type { RendererTextFrameSnapshot, RendererTextFrameRow } from '../render/shared/types.js'
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
  isActivationGesture(event: MouseEvent): boolean
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

interface PointerLinkActivation {
  readonly pointerId: number
  readonly sequence: number
  readonly frameRevision: number
  readonly projection: LinkProjection | undefined
  readonly target: PointerLinkTarget | Promise<PointerLinkTarget | undefined>
}

interface PointerLinkTarget {
  readonly hit: LinkHit<Event>
  readonly resolution?: LinkResolution<Event>
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

function ownedLinkFrame(snapshot: RendererTextFrameSnapshot): RendererTextFrameSnapshot {
  return Object.freeze({
    cursor: snapshot.cursor,
    paintedCursor: snapshot.paintedCursor,
    rows: snapshot.rows,
  })
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

function sameUriHit(left: LinkHit<Event> | undefined, right: LinkHit<Event> | undefined): boolean {
  if (!left || !right || left.source === 'provider' || right.source === 'provider') return false
  return (
    left.source === right.source &&
    left.row === right.row &&
    left.text === right.text &&
    left.range.start === right.range.start &&
    left.range.end === right.range.end &&
    left.uri === right.uri
  )
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
  private activation?: PointerLinkActivation
  private activationSequence = 0
  private claimedClick?: PointerLinkActivation
  private pointerSequence?: number
  private readonly abortController = new AbortController()
  private currentResolution?: LinkResolution<Event>
  private currentScope?: LinkScope
  private disposed = false
  private displayedHit?: {
    readonly hit: LinkHit<Event>
    readonly projection: LinkProjection | undefined
  }
  private frameRevision = 0
  private frameSnapshot?: RendererTextFrameSnapshot
  private frameProjection?: LinkProjection
  private generation = 0
  private lastPoint?: PointerPoint
  private lastQuery?: LinkQuery
  private readonly overlay: HTMLDivElement
  private pendingGeneration?: number
  private readonly pointerFrameWaiters = new Set<() => void>()
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
      this.pointerSequence !== undefined ||
      this.pendingGeneration !== undefined ||
      this.options.canvas.ownerDocument.activeElement === this.overlay
    )
  }

  get currentHit(): LinkHit<Event> | undefined {
    return this.currentResolution?.hit
  }

  get hasPendingResolution(): boolean {
    return this.pendingGeneration !== undefined || this.pointerSequence !== undefined
  }

  isActivationGesture(event: MouseEvent): boolean {
    return event.button === 0 && this.activationModifier(event)
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
    this.displayedHit = undefined
  }

  invalidate(): void {
    if (this.disposed) return
    this.frameRevision += 1
    this.advanceGeneration()
    this.pendingGeneration = undefined
    this.lastQuery = undefined
    this.frameSnapshot = undefined
    this.clearVisibleHit()
  }

  updateFrame(snapshot: RendererTextFrameSnapshot): void {
    if (this.disposed) return
    const frame = ownedLinkFrame(snapshot)
    this.notifyPointerFrame()
    if (this.preserveEquivalentFrame(frame)) return
    this.frameRevision += 1
    this.advanceGeneration()
    this.pendingGeneration = undefined
    this.lastQuery = undefined
    this.frameSnapshot = frame
    this.frameProjection = this.readProjection()
    this.clearVisibleHit()
    if (this.lastPoint) this.requestResolution(this.lastPoint)
  }

  async focusNextLink(): Promise<boolean> {
    this.finishActivationGesture()
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
    if (event.pointerId !== this.activation?.pointerId) return
    this.consumeActivationEvent(event)
    this.finishActivationGesture()
  }

  private readonly handleActivationPointerDown = (event: PointerEvent): void => {
    this.claimedClick = undefined
    this.activationSequence += 1
    this.finishActivationGesture()
    if (!this.isActivationGesture(event)) return
    const cell = this.cellAt(event)
    const currentProjection = this.readProjection()
    const displayed = this.displayedHit
    const projection = currentProjection ?? displayed?.projection
    if (!cell || (this.options.getProjection && !projection)) return
    if (
      !currentProjection &&
      this.options.getProjection &&
      (!displayed || !cellInsideHit(cell, displayed.hit))
    )
      return
    if (!this.captureActivationPointer(event.pointerId)) return
    this.pointerSequence = this.activationSequence
    const target = this.initialPointerTarget(cell)
    this.activation = {
      pointerId: event.pointerId,
      sequence: this.activationSequence,
      frameRevision: this.frameRevision,
      projection,
      target,
    }
    this.consumeActivationEvent(event)
  }

  private readonly handleActivationPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.activation?.pointerId) return
    this.lastPoint = { clientX: event.clientX, clientY: event.clientY }
    this.consumeActivationEvent(event)
  }

  private readonly handleActivationPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.activation?.pointerId) return
    this.lastPoint = { clientX: event.clientX, clientY: event.clientY }
    this.claimedClick = this.activation
    this.consumeActivationEvent(event)
    this.finishActivationGesture(true)
  }

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    if (event.pointerId !== this.activation?.pointerId) return
    this.finishActivationGesture()
  }

  private readonly handleWindowBlur = (): void => {
    this.claimedClick = undefined
    this.activationSequence += 1
    this.finishActivationGesture()
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const claimed = this.claimedClick
    this.claimedClick = undefined
    if (!claimed) return
    this.consumeActivationEvent(event)
    void this.activatePointer(claimed, event)
  }

  private readonly handleOverlayKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const resolution = this.currentResolution
    if (!resolution?.hit || !this.currentScope || !this.isScopeCurrent(this.currentScope)) return
    event.preventDefault()
    this.activate(resolution, event)
  }

  private readonly handlePointerLeave = (): void => {
    if (this.activation !== undefined) return
    if (this.options.canvas.ownerDocument.activeElement === this.overlay) return
    // A claimed click survives leaving: touch fires pointerleave before click.
    this.displayedHit = undefined
    this.lastPoint = undefined
    this.lastQuery = undefined
    this.advanceGeneration()
    this.pendingGeneration = undefined
    this.clearVisibleHit()
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    // Click follows pointerup in the same task; a later move means it never arrived.
    if (this.claimedClick) this.finishActivationGesture()
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

  private async pointerTarget(cell: ResolvedCell): Promise<PointerLinkTarget | undefined> {
    try {
      const snapshot = this.options.getFrame ? this.options.getFrame() : this.readFrame()
      const row = snapshot && frameRow(snapshot, cell.row)
      if (!row) return undefined
      const resolution = await this.options.session.resolveLink({ ...cell, line: linkCells(row) })
      return resolution.hit ? { hit: resolution.hit, resolution } : undefined
    } catch (cause) {
      if (!this.disposed) this.options.onError?.(cause, 'resolve')
      return undefined
    }
  }

  private pointerCurrent(
    activation: PointerLinkActivation,
    event: MouseEvent,
    hit: LinkHit<Event>,
  ): boolean {
    if (this.disposed || activation.sequence !== this.activationSequence) return false
    const cell = this.cellAt(event)
    if (!cell || !cellInsideHit(cell, hit)) return false
    if (!this.options.getProjection) return true
    const projection = this.readProjection()
    return (
      projection !== undefined &&
      projection.generation === activation.projection?.generation &&
      projection.layout === activation.projection?.layout
    )
  }

  private initialPointerTarget(
    cell: ResolvedCell,
  ): PointerLinkTarget | Promise<PointerLinkTarget | undefined> {
    const resolution = this.currentResolution
    const scope = this.currentScope
    if (
      resolution?.hit &&
      scope &&
      this.isScopeCurrent(scope) &&
      cellInsideHit(cell, resolution.hit)
    )
      return { hit: resolution.hit, resolution }
    const displayed = this.displayedHit?.hit
    if (displayed && displayed.source !== 'provider' && cellInsideHit(cell, displayed))
      return { hit: displayed }
    return this.pointerTarget(cell)
  }

  private revalidatePointerTarget(
    activation: PointerLinkActivation,
    original: PointerLinkTarget,
    cell: ResolvedCell,
  ): LinkResolution<Event> | Promise<LinkResolution<Event> | undefined> | undefined {
    const sameProjection =
      !this.options.getProjection ||
      linkProjectionEquals(activation.projection, this.readProjection())
    if (original.resolution && activation.frameRevision === this.frameRevision && sameProjection)
      return original.resolution
    if (original.hit.source === 'provider') return undefined
    return this.pointerTarget(cell).then((current) =>
      sameUriHit(original.hit, current?.hit) ? current?.resolution : undefined,
    )
  }

  private async activatePointer(
    activation: PointerLinkActivation,
    event: MouseEvent,
  ): Promise<void> {
    try {
      const target = activation.target
      const original = target instanceof Promise ? await target : target
      if (!original) return
      if (this.options.getProjection && !this.readProjection()) await this.waitForPointerFrame()
      if (!this.pointerCurrent(activation, event, original.hit)) return
      const projection = this.readProjection()
      const cell = this.cellAt(event)
      if (!cell) return
      const revalidated = this.revalidatePointerTarget(activation, original, cell)
      const current = revalidated instanceof Promise ? await revalidated : revalidated
      if (!current) return
      const currency = this.options.session.isLinkCurrent(current)
      const live = currency instanceof Promise ? await currency : currency
      if (!live || !this.pointerCurrent(activation, event, original.hit)) return
      if (this.options.getProjection && !linkProjectionEquals(projection, this.readProjection()))
        return
      const opened = this.options.session.activateLink(current, event)
      // The session checks currency synchronously; a slow host opener must not freeze hover.
      this.releasePointerActivation(activation)
      await opened
    } catch (cause) {
      if (!this.disposed) this.options.onError?.(cause, 'activate')
    } finally {
      this.releasePointerActivation(activation)
    }
  }

  private releasePointerActivation(activation: PointerLinkActivation): void {
    if (this.pointerSequence !== activation.sequence) return
    this.pointerSequence = undefined
    if (this.lastPoint && !this.disposed) this.requestResolution(this.lastPoint)
  }

  private notifyPointerFrame(): void {
    if (this.pointerFrameWaiters.size === 0 || !this.readProjection()) return
    for (const done of this.pointerFrameWaiters) done()
  }

  private waitForPointerFrame(): Promise<void> {
    const signal = this.abortController.signal
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      let timer = 0
      const done = (): void => {
        this.pointerFrameWaiters.delete(done)
        this.view.clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      this.pointerFrameWaiters.add(done)
      timer = this.view.setTimeout(done, 100)
      signal.addEventListener('abort', done, { once: true })
      this.notifyPointerFrame()
    })
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

  private finishActivationGesture(preserveClick = false): void {
    const pointerId = this.activation?.pointerId
    this.activation = undefined
    if (!preserveClick && this.pointerSequence !== undefined) {
      this.pointerSequence = undefined
      this.claimedClick = undefined
      this.activationSequence += 1
      this.pendingGeneration = undefined
      this.lastQuery = undefined
      this.advanceGeneration()
      this.clearVisibleHit()
    }
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
      const frame = this.options.getFrame?.()
      this.frameSnapshot = frame ? ownedLinkFrame(frame) : undefined
      this.frameProjection = this.readProjection()
    }
    return this.frameSnapshot
  }

  private requestResolution(point: PointerPoint): void {
    if (this.pointerSequence !== undefined) return
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
    if (this.pointerSequence === undefined) this.options.session.cancelLinkResolution?.()
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
    this.displayedHit = { hit, projection: scope.projection }
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
