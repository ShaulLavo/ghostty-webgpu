import type { TerminalScrollbar } from '../core/types.js'
import {
  createTerminalAccessibility,
  type TerminalAccessibilityController,
} from './accessibility.js'
import { owningWindow, type TerminalElements } from './elements.js'
import type { TerminalSubmittedSnapshot } from './submitted-frame.js'
import type { GhosttyWebGpuTerminalAccessibilityOptions } from './types.js'

// Batch fast output while keeping foreground readable text responsive.
const accessibilityRefreshDelayMs = 100

function viewportMoved(
  previous: Readonly<TerminalScrollbar>,
  next: Readonly<TerminalScrollbar>,
): boolean {
  return (
    previous.offset !== next.offset &&
    (previous.offset !== previous.total - previous.length ||
      next.offset !== next.total - next.length)
  )
}

interface AccessibilitySource {
  frame(): TerminalSubmittedSnapshot | undefined
  visible(): boolean
  onError(cause: unknown, operation: string): void
}

export class TerminalHostAccessibility {
  private elements?: TerminalElements
  private accessibility?: TerminalAccessibilityController
  private accessibilityTimer?: number
  private accessibilityFrame?: TerminalSubmittedSnapshot
  private accessibilityResizeRevision?: number

  constructor(
    private readonly options: false | GhosttyWebGpuTerminalAccessibilityOptions | undefined,
    private readonly source: AccessibilitySource,
  ) {}

  attach(elements: TerminalElements): void {
    this.elements = elements
    elements.textarea.addEventListener(
      'focus',
      () => {
        this.refreshFromEvent()
      },
      { signal: elements.signal },
    )
    if (!this.options) return
    this.enableAccessibility(elements)
  }

  setEnabled(enabled: boolean, elements: TerminalElements | undefined): boolean {
    if (!enabled) return this.disable()
    if (this.accessibility || !elements) return false
    this.enableAccessibility(elements)
    return true
  }

  get enabled(): boolean {
    return this.accessibility !== undefined
  }

  noteResize(revision: number): void {
    this.accessibilityResizeRevision = revision
  }

  noteScroll(next: Readonly<TerminalScrollbar>): void {
    if (!this.accessibility) return
    const displayed = this.source.frame()?.scrollbar
    if (displayed && viewportMoved(displayed, next)) this.refreshFromEvent()
  }

  visibilityChanged(visible: boolean): void {
    if (visible) this.refreshFromEvent()
    else this.cancelAccessibilityTimer()
  }

  dispose(): void {
    this.disable()
    this.elements = undefined
  }

  private refreshFromEvent(announce = true): void {
    try {
      this.refreshAccessibility(announce)
    } catch (cause) {
      this.source.onError(cause, 'frame.accessibility')
    }
  }

  private enableAccessibility(elements: TerminalElements): void {
    this.elements = elements
    this.accessibility = this.createAccessibility(elements)
    this.refreshAccessibility()
  }

  schedule(): void {
    if (!this.accessibility || !this.source.visible()) return
    const summary = this.source.frame()
    if (!summary) return
    const previous = this.accessibilityFrame
    if (
      previous &&
      previous.snapshotVersion === summary.snapshotVersion &&
      previous.nativeRevision === summary.nativeRevision &&
      previous.layout === summary.layout &&
      previous.cursor.visible === summary.cursor.visible &&
      previous.cursor.viewport?.x === summary.cursor.viewport?.x &&
      previous.cursor.viewport?.y === summary.cursor.viewport?.y &&
      previous.cursor.viewport?.wideTail === summary.cursor.viewport?.wideTail &&
      previous.scrollbar.offset === summary.scrollbar.offset &&
      previous.scrollbar.total === summary.scrollbar.total &&
      previous.scrollbar.length === summary.scrollbar.length
    )
      return
    const movedViewport = previous && viewportMoved(previous.scrollbar, summary.scrollbar)
    if (this.accessibility.rowElements.length === 0 || movedViewport) {
      this.refreshFromEvent(!movedViewport)
      return
    }
    if (this.accessibilityTimer !== undefined) return
    const view = owningWindow(this.elements!.root)
    this.accessibilityTimer = view.setTimeout(() => {
      this.refreshFromEvent()
    }, accessibilityRefreshDelayMs)
  }

  private refreshAccessibility(announce = true): void {
    this.cancelAccessibilityTimer()
    const accessibility = this.accessibility
    if (!accessibility || !this.source.visible()) return
    const summary = this.source.frame()
    if (!summary) return
    const resizeRevision = this.accessibilityResizeRevision
    // Resize intervals establish readable text without inferring output across reflowed rows.
    accessibility.update(summary, summary.scrollbar, announce && resizeRevision === undefined)
    this.accessibilityFrame = summary
    // Focus can refresh an older displayed frame while the resized frame is waiting to paint.
    if (resizeRevision !== undefined && summary.nativeRevision >= resizeRevision)
      this.accessibilityResizeRevision = undefined
  }

  private cancelAccessibilityTimer(): void {
    if (this.accessibilityTimer === undefined) return
    owningWindow(this.elements!.root).clearTimeout(this.accessibilityTimer)
    this.accessibilityTimer = undefined
  }

  private createAccessibility(elements: TerminalElements): TerminalAccessibilityController {
    const options = this.options || undefined
    return createTerminalAccessibility({
      ...(options?.label === undefined ? {} : { label: options.label }),
      ...(options?.liveRegionMaxCharacters === undefined
        ? {}
        : { liveRegionMaxCharacters: options.liveRegionMaxCharacters }),
      ...(options?.liveRegionMaxEntries === undefined
        ? {}
        : { liveRegionMaxEntries: options.liveRegionMaxEntries }),
      root: elements.root,
      signal: elements.signal,
      textarea: elements.textarea,
    })
  }

  private disable(): boolean {
    const accessibility = this.accessibility
    if (!accessibility) return false
    this.accessibility = undefined
    this.cancelAccessibilityTimer()
    this.accessibilityFrame = undefined
    this.accessibilityResizeRevision = undefined
    accessibility.dispose()
    return true
  }
}
