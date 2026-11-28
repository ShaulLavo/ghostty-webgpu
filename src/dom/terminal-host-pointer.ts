import type { RowBidiMapper } from '../bidi/row.js'
import type { RendererTextFrameSnapshot } from '../render/shared/types.js'
import type { WorkerTerminalExecution } from '../worker/execution.js'
import { invokeCleanup } from './cleanup.js'
import { owningWindow, type TerminalElements } from './elements.js'
import type { LocalTerminalExecution } from './execution-local.js'
import { createDomLinkController, type DomLinkController } from './links.js'
import {
  createTerminalPointerController,
  projectPointerPosition,
  type CommittedPointerLayout,
  type TerminalPointerController,
} from './pointer.js'
import {
  createTerminalSelectionController,
  type TerminalSelectionController,
  type TerminalSelectionProjection,
} from './selection.js'
import type { TerminalSubmittedSnapshot } from './submitted-frame.js'
import type { GhosttyWebGpuTerminalFromSessionOptions } from './types.js'

function physicalPadding(value: number, pixelRatio: number): number {
  const result = Math.round(value * pixelRatio)
  if (Number.isSafeInteger(result) && result >= 0) return result
  throw new RangeError('Terminal padding must map to a non-negative safe device-pixel value')
}

interface PointerSource {
  readonly execution:
    | Pick<LocalTerminalExecution, PointerIntent>
    | Pick<WorkerTerminalExecution, PointerIntent>
  elements(): TerminalElements | undefined
  layoutCommitted(): boolean
  onError(cause: unknown, operation: string): void
  wakeHandoff(): void
}

type PointerIntent =
  | 'kind'
  | 'linkProjection'
  | 'links'
  | 'pointer'
  | 'selectionGesture'
  | 'selectionIdentity'
  | 'submittedFrame'
  | 'textFrame'

export class TerminalHostPointer {
  private bidiMapper?: RowBidiMapper
  private links?: DomLinkController
  private pointer?: TerminalPointerController
  private selection?: TerminalSelectionController
  private cachedPointerLayout?: {
    readonly canvas: HTMLCanvasElement
    readonly summary: TerminalSubmittedSnapshot
    readonly layout: CommittedPointerLayout
  }

  constructor(
    private readonly source: PointerSource,
    private readonly linkActivationModifier: GhosttyWebGpuTerminalFromSessionOptions['linkActivationModifier'],
  ) {}

  get owner() {
    return this.pointer?.owner ?? 'none'
  }

  get pressedButtonCount(): number {
    return this.pointer?.pressedButtonCount ?? 0
  }

  get hasPendingResolution(): boolean {
    return this.links?.hasPendingResolution === true
  }

  get hasPendingAutoscroll(): boolean {
    return this.selection?.hasPendingAutoscroll === true
  }

  get needsFrame(): boolean {
    return this.links?.needsFrame ?? false
  }

  get canAdoptCanvas(): boolean {
    return this.owner === 'none' && !this.links?.hasActivePointerActivation
  }

  attach(elements: TerminalElements, bidiMapper: RowBidiMapper | undefined): void {
    this.bidiMapper = bidiMapper
    this.installPointer(elements)
    this.installLinks(elements)
  }

  cancel(): void {
    this.pointer?.cancel()
  }

  focusNextLink(): Promise<boolean> {
    return this.links?.focusNextLink() ?? Promise.resolve(false)
  }

  acceptFrame(snapshot: RendererTextFrameSnapshot): void {
    if (this.needsFrame && snapshot.rows.length > 0) {
      this.updateLinkFrame(snapshot)
      return
    }
    this.invalidateLinks()
  }

  private refreshSelectionProjection(
    previous: TerminalSelectionProjection,
  ): TerminalSelectionProjection | undefined {
    const layout = this.committedPointerLayout()
    if (!layout || !previous.client) return undefined
    return projectPointerPosition(
      { clientX: previous.client.x, clientY: previous.client.y },
      layout,
    ).selection
  }

  private installPointer(elements: TerminalElements): void {
    const selection = createTerminalSelectionController({
      getIdentity:
        this.source.execution.kind === 'async'
          ? () => this.source.execution.selectionIdentity
          : undefined,
      getProjection: (previous) => this.refreshSelectionProjection(previous),
      onError: (cause, operation) => this.source.onError(cause, operation),
      session: this.source.execution.selectionGesture,
      view: owningWindow(elements.canvas),
    })
    let pointer: TerminalPointerController
    try {
      pointer = createTerminalPointerController({
        canvas: elements.canvas,
        getLayout: () => this.committedPointerLayout(),
        onError: (cause, operation) => this.source.onError(cause, operation),
        onOwnerChange: (owner) => {
          if (owner === 'none') this.source.wakeHandoff()
        },
        selection,
        session: this.source.execution.pointer,
        signal: elements.signal,
      })
    } catch (cause) {
      selection.dispose()
      throw cause
    }
    this.selection = selection
    this.pointer = pointer
  }

  private installLinks(elements: TerminalElements): void {
    const links = createDomLinkController({
      bidiMapper: this.bidiMapper,
      getFrame: () =>
        this.source.execution.linkProjection ? this.source.execution.textFrame() : undefined,
      getProjection: () => this.source.execution.linkProjection,
      activationModifier: this.linkActivationModifier,
      canvas: elements.canvas,
      getLayout: () => this.committedPointerLayout(),
      onActivationChange: (active) => {
        if (!active) this.source.wakeHandoff()
      },
      onError: (cause, operation) => this.source.onError(cause, `link.${operation}`),
      root: elements.root,
      session: this.source.execution.links,
      signal: elements.signal,
    })
    this.links = links
  }

  private disposePointerController(): void {
    const pointer = this.pointer
    this.pointer = undefined
    this.selection = undefined
    invokeCleanup(
      () => pointer?.dispose(),
      (cause) => this.source.onError(cause, 'pointer.dispose'),
    )
  }

  dispose(): void {
    const links = this.links
    this.links = undefined
    invokeCleanup(
      () => links?.dispose(),
      (cause) => this.source.onError(cause, 'link.dispose'),
    )
    this.disposePointerController()
    this.cachedPointerLayout = undefined
  }

  replaceCanvas(elements: TerminalElements, replacement?: HTMLCanvasElement): HTMLCanvasElement {
    elements.signal.throwIfAborted()
    if (!elements.replaceCanvas) throw new Error('Terminal elements cannot replace their canvas')
    const active = elements.root.ownerDocument.activeElement
    const preserveLinks = replacement !== undefined && this.links !== undefined
    const restoreFocus =
      active === elements.canvas ||
      (!preserveLinks &&
        active?.classList.contains('ghostty-webgpu-link') === true &&
        elements.root.contains(active))
    const rebindPointer = this.pointer !== undefined
    const rebindLinks = this.links !== undefined
    if (preserveLinks) this.disposePointerController()
    else this.dispose()
    if (replacement) elements.adoptCanvas?.(replacement)
    else elements.replaceCanvas()
    const canvas = elements.canvas
    if (this.source.execution.kind === 'sync') {
      if (rebindPointer) this.installPointer(elements)
      if (preserveLinks) this.links?.rebindCanvas(canvas)
      else if (rebindLinks) this.installLinks(elements)
    }
    if (restoreFocus) elements.textarea.focus({ preventScroll: true })
    return canvas
  }

  invalidateLinks(): void {
    this.links?.invalidate()
  }

  refreshLinks(): void {
    this.invalidateLinks()
    if (!(this.links?.needsFrame ?? false)) return
    const snapshot = this.source.execution.textFrame()
    if (!snapshot) return
    this.updateLinkFrame(snapshot)
  }

  updateLinkFrame(snapshot: RendererTextFrameSnapshot): void {
    const links = this.links
    const layout = this.committedPointerLayout()
    if (!links || !layout) return
    links.updateFrame(snapshot)
  }

  private committedPointerLayout(): CommittedPointerLayout | undefined {
    const elements = this.source.elements()
    if (!elements || !this.source.layoutCommitted()) return undefined
    const summary = this.source.execution.submittedFrame
    if (!summary) return undefined
    const cached = this.cachedPointerLayout
    if (cached && cached.canvas === elements.canvas && cached.summary === summary) {
      return cached.layout
    }
    const grid = summary.grid
    const font = summary.font
    const ratio = font.pixelRatio
    const padding = summary.padding
    const paddingBottom = physicalPadding(padding.bottom, ratio)
    const paddingLeft = physicalPadding(padding.left, ratio)
    const paddingRight = physicalPadding(padding.right, ratio)
    const paddingTop = physicalPadding(padding.top, ratio)
    const dimensions = Object.freeze({
      deviceCellHeight: font.deviceCellHeight,
      deviceCellWidth: font.deviceCellWidth,
      paddingBottom,
      paddingLeft,
      paddingRight,
      paddingTop,
      screenHeight: paddingTop + font.deviceCellHeight * grid.rows + paddingBottom,
      screenWidth: paddingLeft + font.deviceCellWidth * grid.columns + paddingRight,
    })
    const layout = Object.freeze({
      canvas: elements.canvas,
      grid: Object.freeze({ ...grid }),
      physical: dimensions,
    })
    this.cachedPointerLayout = { canvas: elements.canvas, layout, summary }
    return layout
  }
}
