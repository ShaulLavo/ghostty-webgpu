import { createGhosttyError } from '../core/error.js'
import { copiedFrameRow } from '../render/frame-row.js'
import type { SelectionPoint } from '../core/selection.js'
import type { ReadLinesOptions, TerminalSelectionFormatOptions } from '../core/types.js'
import type {
  RendererFrameSnapshot,
  RendererTextFrameSnapshot,
  WebGpuTerminalRendererOptions,
} from '../render/renderer.js'
import type { LinkProvider, LinkResolution } from '../term/links.js'
import {
  linkProjectionEquals,
  type LinkProjection,
  type NativeLinkRequest,
  type NativeLinkDiscoveryRequest,
} from '../term/link-snapshot.js'
import { TerminalSession } from '../term/session.js'
import {
  NativeSelectionHistory,
  assertSelectionIdentity,
  type SelectionIdentity,
} from '../term/selection-history.js'
import type { TerminalSessionKeyOptions } from '../term/session.js'
import type {
  TerminalAppearanceOptions,
  TerminalClipboardWritePolicy,
  TerminalFittedFont,
  TerminalGrid,
  TerminalInputData,
  TerminalKeyInput,
  TerminalLinkRequest,
  TerminalMouseInput,
  TerminalSelectionDragInput,
  TerminalSelectionPressInput,
  TerminalSelectionReleaseInput,
  TerminalSessionEventType,
  TerminalSessionListener,
  TerminalSessionOptions,
} from '../term/types.js'
import type { TerminalElementPadding } from './elements.js'
import type { GhosttyWebGpuRenderer, GhosttyWebGpuRendererFactory } from './types.js'
import { submittedFrame, type TerminalSubmittedFrame } from './submitted-frame.js'
import { encodeTerminalViewport } from './viewport.js'

interface SubmittedLayout {
  readonly identity: number
  readonly font: TerminalFittedFont
  readonly padding: TerminalElementPadding
}

function copiedFrame(snapshot: RendererFrameSnapshot): RendererFrameSnapshot {
  const viewport = snapshot.cursor.viewport
  return Object.freeze({
    cursor: Object.freeze({
      ...snapshot.cursor,
      viewport: viewport ? Object.freeze({ ...viewport }) : undefined,
    }),
    rows: Object.freeze(
      snapshot.rows.map((row) =>
        copiedFrameRow({ cells: row.renderCells, dirty: false, y: row.y }),
      ),
    ),
    paintedCursor: snapshot.paintedCursor
      ? Object.freeze({ ...snapshot.paintedCursor })
      : undefined,
  })
}

/** The local native actor. Its synchronous operations are private to the main-thread entry. */
export class LocalTerminalExecution {
  readonly kind = 'sync' as const
  private disposed = false
  private layout?: SubmittedLayout
  private lastFrame?: RendererTextFrameSnapshot
  private lastFullFrame?: RendererFrameSnapshot
  private lastFrameVersion?: number
  private rendererValue?: GhosttyWebGpuRenderer
  private summaryValue?: TerminalSubmittedFrame
  private linkEpoch = 0

  private readonly selectionHistory: NativeSelectionHistory

  constructor(
    private readonly session: TerminalSession<Event>,
    private readonly generation = 1,
  ) {
    this.selectionHistory = new NativeSelectionHistory(session, () => ({
      generation: this.generation,
      layout: this.layout?.identity ?? 0,
    }))
    // Capability getters run with the intent object as their receiver.
    // oxlint-disable-next-line typescript/no-this-alias
    const execution = this
    this.renderer = {
      get canPaint() {
        return execution.rendererValue?.canPaint
      },
      get backend() {
        return execution.rendererValue?.backend
      },
      get hasPendingFrame() {
        return execution.rendererValue?.hasPendingFrame
      },
      get hasPendingTimer() {
        return execution.rendererValue?.hasPendingTimer
      },
      clearTextureAtlas: () => this.rendererValue?.clearTextureAtlas?.(),
      dispose: () => this.disposeRenderer(),
      notifyScroll: () => this.rendererValue?.notifyScroll(),
      notifySelectionChange: () => this.rendererValue?.notifySelectionChange(),
      notifyWrite: () => this.rendererValue?.notifyWrite(),
      refreshRows: (start, end) => this.rendererValue?.refreshRows?.(start, end),
      resize: (grid) => this.rendererValue?.resize(grid),
      schedule: () => this.rendererValue?.schedule(),
      setCursorBlinkEnabled: (enabled) => this.rendererValue?.setCursorBlinkEnabled(enabled),
      setDocumentVisible: (visible) => this.rendererValue?.setDocumentVisible(visible),
      setFocused: (focused) => this.rendererValue?.setFocused(focused),
      setInactiveCursorStyle: (style) => this.rendererValue?.setInactiveCursorStyle?.(style),
      setFont: (font) => this.rendererValue?.setFont(font),
      setTheme: (theme) => this.rendererValue?.setTheme(theme),
    }
  }

  static async create(
    options: TerminalSessionOptions<Event>,
    generation = 1,
  ): Promise<LocalTerminalExecution> {
    return new LocalTerminalExecution(await TerminalSession.create<Event>(options), generation)
  }

  get selectionIdentity(): SelectionIdentity | undefined {
    const summary = this.summaryValue
    if (!summary) return undefined
    return { generation: this.generation, layout: summary.layout, revision: summary.nativeRevision }
  }

  get linkProjection(): LinkProjection | undefined {
    const summary = this.summaryValue
    if (
      this.disposed ||
      !summary ||
      !this.canReadSubmittedState ||
      summary.layout !== this.layout?.identity ||
      summary.nativeRevision !== this.session.revision
    )
      return undefined
    return { generation: this.generation, layout: summary.layout, revision: summary.nativeRevision }
  }

  resolveLinkSnapshot(request: NativeLinkRequest) {
    return this.session.resolveLinkSnapshot(request, () => this.linkProjection)
  }

  resolveLinkDiscovery(request: NativeLinkDiscoveryRequest) {
    return this.session.resolveLinkDiscovery(request, () => this.linkProjection)
  }

  get mouseTracking(): boolean {
    return this.session.mouseTracking
  }

  mouse(input: TerminalMouseInput, expected?: Omit<SelectionIdentity, 'revision'>) {
    if (
      expected &&
      (expected.generation !== this.generation || expected.layout !== (this.layout?.identity ?? 0))
    )
      throw createGhosttyError('mouse.identity', 'Mouse layout identity changed')
    return this.session.mouse(input)
  }

  resetMouseTracking(): void {
    this.session.resetMouseTracking()
  }

  selectionSnapshot(options?: TerminalSelectionFormatOptions, expected?: SelectionIdentity) {
    const snapshot = this.selectionHistory.selectionSnapshot(options)
    if (expected) assertSelectionIdentity(expected, snapshot)
    return snapshot
  }

  selectionPress(input: TerminalSelectionPressInput, expected?: SelectionIdentity) {
    return this.selectionHistory.selectionPress(input, expected)
  }

  selectionDrag(input: TerminalSelectionDragInput, expected?: SelectionIdentity) {
    return this.selectionHistory.selectionDrag(input, expected)
  }

  selectionAutoscrollTick(input: TerminalSelectionDragInput, expected?: SelectionIdentity) {
    return this.selectionHistory.selectionAutoscrollTick(input, expected)
  }

  selectionRelease(input?: TerminalSelectionReleaseInput, expected?: SelectionIdentity) {
    return this.selectionHistory.selectionRelease(input, expected)
  }

  resetSelectionGesture(): void {
    this.selectionHistory.resetSelectionGesture()
  }

  get appearance() {
    return this.session.appearance
  }
  get grid() {
    return this.session.grid
  }
  get scrollbar() {
    return this.session.scrollbar
  }
  get revision() {
    return this.session.revision
  }
  get submittedFrame(): TerminalSubmittedFrame | undefined {
    return this.summaryValue
  }

  // Host controllers receive these intents, never the native session or its render source.
  readonly input = {
    getSelection: (options?: TerminalSelectionFormatOptions) => this.session.getSelection(options),
    selectionCoordinates: () => this.session.selectionCoordinates(),
    key: (input: TerminalKeyInput, options?: TerminalSessionKeyOptions) =>
      this.session.key(input, options),
    paste: (data: TerminalInputData) => this.session.paste(data),
    sendInput: (data: TerminalInputData) => this.session.sendInput(data),
  }
  readonly focus = { setFocused: (focused: boolean) => this.session.setFocused(focused) }
  readonly pointer = {
    mouse: (input: TerminalMouseInput) => this.session.mouse(input),
    mouseTracking: () => this.session.mouseTracking,
    resetMouseTracking: () => this.session.resetMouseTracking(),
    scrollBy: (delta: number) => this.session.scrollBy(delta),
  }
  readonly selectionGesture = {
    resetSelectionGesture: () => this.resetSelectionGesture(),
    selectionAutoscrollTick: (input: TerminalSelectionDragInput, expected?: SelectionIdentity) =>
      this.selectionAutoscrollTick(input, expected),
    selectionDrag: (input: TerminalSelectionDragInput, expected?: SelectionIdentity) =>
      this.selectionDrag(input, expected),
    selectionPress: (input: TerminalSelectionPressInput, expected?: SelectionIdentity) =>
      this.selectionPress(input, expected),
    selectionRelease: (input?: TerminalSelectionReleaseInput, expected?: SelectionIdentity) =>
      this.selectionRelease(input, expected),
  }
  readonly scroll = {
    scrollBy: (delta: number) => this.session.scrollBy(delta),
    scrollToRow: (row: number) => this.session.scrollToRow(row),
    scrollToTop: () => this.session.scrollToTop(),
    scrollToBottom: () => this.session.scrollToBottom(),
  }
  readonly links = {
    activateLink: (resolution: LinkResolution<Event>, event: Event) =>
      this.session.activateLink(resolution, event),
    cancelLinkResolution: () => {
      this.linkEpoch += 1
    },
    isLinkCurrent: (resolution: LinkResolution<Event>) => this.session.isLinkCurrent(resolution),
    resolveLink: (request: TerminalLinkRequest) => {
      const projection = this.linkProjection
      const epoch = ++this.linkEpoch
      return this.session.resolveLink(
        request,
        () => epoch === this.linkEpoch && linkProjectionEquals(projection, this.linkProjection),
      )
    },
  }

  on<TType extends TerminalSessionEventType>(
    type: TType,
    listener: TerminalSessionListener<TType>,
  ) {
    return this.session.on(type, listener)
  }
  setClipboardWritePolicy(policy?: TerminalClipboardWritePolicy): void {
    this.session.setClipboardWritePolicy(policy)
  }
  lineCount() {
    return this.session.lineCount()
  }
  readLines(start: number, end: number, options?: ReadLinesOptions) {
    return this.session.readLines(start, end, options)
  }
  registerLinkProvider(provider: LinkProvider<Event>) {
    return this.session.registerLinkProvider(provider)
  }
  geometry() {
    return this.session.geometry()
  }
  measure(text: string) {
    return this.session.measure(text)
  }
  measureTexts(texts: readonly string[]) {
    return this.session.measureTexts(texts)
  }
  writeAndReadGeometry(data: TerminalInputData) {
    return this.session.writeAndReadGeometry(data)
  }
  write(data: TerminalInputData) {
    return this.session.write(data)
  }
  writeln(data: TerminalInputData) {
    return this.session.writeln(data)
  }
  sendInput(data: TerminalInputData) {
    return this.session.sendInput(data)
  }
  paste(data: TerminalInputData) {
    return this.session.paste(data)
  }
  key(input: TerminalKeyInput) {
    return this.session.key(input)
  }
  reset() {
    return this.session.reset()
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
  getSelection(options?: TerminalSelectionFormatOptions) {
    return this.session.getSelection(options)
  }
  selectionCoordinates() {
    return this.session.selectionCoordinates()
  }
  clearSelection() {
    return this.session.clearSelection()
  }
  selectAll() {
    return this.session.selectAll()
  }
  selectRange(start: SelectionPoint, end: SelectionPoint) {
    return this.session.selectRange(start, end)
  }
  selectLines(startRow: number, endRow: number) {
    return this.session.selectLines(startRow, endRow)
  }
  setAppearance(options: TerminalAppearanceOptions) {
    return this.session.setAppearance(options)
  }
  resize(grid: Partial<TerminalGrid>) {
    return this.session.resize(grid)
  }

  private get canReadSubmittedState(): boolean {
    return this.lastFrameVersion === this.session.renderState.snapshotVersion
  }

  textFrame(): RendererTextFrameSnapshot | undefined {
    return this.lastFrame
  }

  frameSnapshot(): RendererFrameSnapshot | undefined {
    if (!this.lastFrame) return undefined
    if (!this.canReadSubmittedState) return this.lastFullFrame
    const rows = Object.freeze(
      this.session.renderState.readRows({ packed: true }).map(copiedFrameRow),
    )
    this.lastFullFrame = copiedFrame(Object.freeze({ ...this.lastFrame, rows }))
    return this.lastFullFrame
  }

  captureViewport(width: number, height: number): string | undefined {
    const summary = this.summaryValue
    if (
      !summary ||
      summary.nativeRevision !== this.session.revision ||
      summary.layout !== this.layout?.identity ||
      !this.canReadSubmittedState
    )
      return undefined
    const painted = summary.paintedCursor
    const cursor = painted
      ? {
          ...summary.cursor,
          visible: painted.visible,
          style: painted.style,
          viewport: { x: painted.x, y: painted.y, wideTail: false },
        }
      : summary.cursor
    return encodeTerminalViewport({
      width,
      height,
      columns: summary.grid.columns,
      rows: this.session.renderState.readRows(),
      cursor,
      scrollbar: summary.scrollbar,
      font: summary.font,
      theme: summary.theme,
      padding: summary.padding,
    })
  }

  commitLayout(font: TerminalFittedFont, padding: TerminalElementPadding): void {
    this.layout = Object.freeze({
      identity: (this.layout?.identity ?? 0) + 1,
      font,
      padding: Object.freeze({ ...padding }),
    })
  }

  submit(snapshot: RendererTextFrameSnapshot): RendererTextFrameSnapshot {
    this.lastFrameVersion = this.session.renderState.snapshotVersion
    this.lastFullFrame = undefined
    // Native rows are copied at submission, before a later update can replace the render snapshot.
    const rows =
      snapshot.rows.length > 0
        ? snapshot.rows
        : Object.freeze(
            this.session.renderState.readTextRows
              ? this.session.renderState.readTextRows()
              : this.session.renderState.readRows({ packed: true }).map(copiedFrameRow),
          )
    this.lastFrame = Object.freeze({ ...snapshot, rows })
    let layout = this.layout
    if (!layout) return this.lastFrame
    const grid = this.session.grid
    const previous = this.summaryValue
    const gridChanged =
      previous && (previous.grid.columns !== grid.columns || previous.grid.rows !== grid.rows)
    if (gridChanged && previous.layout === layout.identity) {
      layout = Object.freeze({ ...layout, identity: layout.identity + 1 })
      this.layout = layout
    }
    this.summaryValue = submittedFrame(previous, {
      nativeRevision: this.session.revision,
      snapshotVersion: this.lastFrameVersion,
      layout: layout.identity,
      grid: {
        ...grid,
        cellHeight: layout.font.cssCellHeight,
        cellWidth: layout.font.cssCellWidth,
        pixelRatio: layout.font.pixelRatio,
      },
      font: layout.font,
      padding: layout.padding,
      theme: this.session.appearance.rendererTheme,
      selection: this.session.selectionCoordinates(),
      scrollbar: this.session.scrollbar,
      snapshot: this.lastFrame,
    })
    return this.lastFrame
  }

  confirmCleanUpdate(): void {
    const summary = this.summaryValue
    if (
      !summary ||
      summary.layout !== this.layout?.identity ||
      !this.canReadSubmittedState ||
      this.rendererValue?.canPaint !== true ||
      this.rendererValue.hasPendingFrame
    )
      return
    this.summaryValue = Object.freeze({ ...summary, nativeRevision: this.session.revision })
  }

  async createRenderer(
    factory: GhosttyWebGpuRendererFactory,
    options: Omit<WebGpuTerminalRendererOptions, 'renderState'>,
    signal: AbortSignal,
  ): Promise<GhosttyWebGpuRenderer> {
    const renderer = await factory({ ...options, renderState: this.session.renderState }, signal)
    if (this.disposed) {
      renderer.dispose()
      signal.throwIfAborted()
      throw createGhosttyError(
        'terminal_execution.create_renderer',
        'Terminal execution has been disposed',
      )
    }
    this.rendererValue = renderer
    return this.renderer
  }

  readonly renderer: GhosttyWebGpuRenderer

  private disposeRenderer(): void {
    const renderer = this.rendererValue
    this.rendererValue = undefined
    renderer?.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.layout = undefined
    this.lastFrame = undefined
    this.lastFullFrame = undefined
    this.summaryValue = undefined
    try {
      this.disposeRenderer()
    } finally {
      this.session.dispose()
    }
  }
}
