import type { ExtensionDispatch } from '../extensions/manager.js'
import { EventEmitter } from '../term/events.js'
import type { TerminalAppearance, TerminalGrid } from '../term/types.js'
import type { TerminalSubmittedSnapshot, TerminalSubmittedText } from './submitted-frame.js'
import type {
  GhosttyWebGpuTerminalEventMap,
  GhosttyWebGpuTerminalEventType,
  GhosttyWebGpuTerminalLifecycle,
  GhosttyWebGpuTerminalListener,
  GhosttyWebGpuTerminalSubscription,
} from './types.js'

type HostEmitters = {
  -readonly [TType in GhosttyWebGpuTerminalEventType]: EventEmitter<
    GhosttyWebGpuTerminalEventMap[TType]
  >
}

function createHostEmitters(): HostEmitters {
  const error = new EventEmitter<GhosttyWebGpuTerminalEventMap['error']>()
  const sink = (operation: string) => (cause: unknown) => error.emit({ cause, operation })
  return {
    open: new EventEmitter(sink('event.open')),
    appearance: new EventEmitter(sink('event.appearance')),
    bell: new EventEmitter(sink('event.bell')),
    data: new EventEmitter(sink('event.data')),
    error,
    frame: new EventEmitter(sink('event.frame')),
    outputTiming: new EventEmitter(sink('event.outputTiming')),
    resize: new EventEmitter(sink('event.resize')),
    scroll: new EventEmitter(sink('event.scroll')),
    selection: new EventEmitter(sink('event.selection')),
    title: new EventEmitter(sink('event.title')),
  }
}

function disposeHostEmitters(emitters: HostEmitters): void {
  emitters.open.dispose()
  emitters.appearance.dispose()
  emitters.bell.dispose()
  emitters.data.dispose()
  emitters.frame.dispose()
  emitters.outputTiming.dispose()
  emitters.resize.dispose()
  emitters.scroll.dispose()
  emitters.selection.dispose()
  emitters.title.dispose()
  emitters.error.dispose()
}

interface HostEventSource {
  lifecycle(): GhosttyWebGpuTerminalLifecycle
  appearance(): TerminalAppearance
  grid(): TerminalGrid
}

export class TerminalHostEvents {
  private readonly emitters = createHostEmitters()
  private readonly textSubscribers = new EventEmitter<TerminalSubmittedText>((cause) =>
    this.reportError(cause, 'frame.text'),
  )
  private readonly pendingText: TerminalSubmittedText[] = []
  private deliveringText = false
  private readonly pendingEvents: (() => void)[] = []
  private pendingAppearance?: GhosttyWebGpuTerminalEventMap['appearance']
  private pendingAppearanceToken = 0
  private pendingResize?: GhosttyWebGpuTerminalEventMap['resize']
  private pendingResizeToken = 0

  constructor(
    private readonly source: HostEventSource,
    private readonly extensionDispatch: ExtensionDispatch,
  ) {}

  hasListeners(type: GhosttyWebGpuTerminalEventType): boolean {
    return this.emitters[type].hasListeners
  }

  get hasTextListeners(): boolean {
    return this.textSubscribers.hasListeners
  }

  on<TType extends GhosttyWebGpuTerminalEventType>(
    type: TType,
    listener: GhosttyWebGpuTerminalListener<TType>,
  ): GhosttyWebGpuTerminalSubscription {
    return this.emitters[type].subscribe(listener)
  }

  onText(
    after: number,
    listener: (text: TerminalSubmittedText) => void,
  ): GhosttyWebGpuTerminalSubscription {
    return this.textSubscribers.subscribe((text) => {
      if (text.frame > after) return listener(text)
    })
  }

  reportError(cause: unknown, operation: string): void {
    if (this.source.lifecycle() === 'disposed') return
    this.emit('error', { cause, operation })
  }

  emitError(cause: unknown, operation: string): void {
    this.emitters.error.emit({ cause, operation })
  }

  discardPending(): void {
    this.pendingEvents.length = 0
    this.pendingAppearance = undefined
    this.pendingAppearanceToken += 1
    this.pendingResize = undefined
    this.pendingResizeToken += 1
    this.pendingText.length = 0
  }

  disposeText(): void {
    this.textSubscribers.dispose()
  }

  dispose(): void {
    disposeHostEmitters(this.emitters)
  }

  publishText(summary: TerminalSubmittedSnapshot | undefined): void {
    if (!this.textSubscribers.hasListeners || !summary) return
    this.emitText(
      Object.freeze({
        frame: summary.frame,
        rows: summary.rows,
        rowPatches: summary.rowPatches,
      }),
    )
  }

  private emitText(text: TerminalSubmittedText): void {
    if (this.source.lifecycle() === 'opening') {
      this.pendingEvents.push(() => this.emitText(text))
      return
    }
    if (this.source.lifecycle() !== 'open') return
    this.pendingText.push(text)
    if (this.deliveringText) return
    this.deliveringText = true
    try {
      while (this.pendingText.length > 0 && this.source.lifecycle() === 'open') {
        this.textSubscribers.emit(this.pendingText.shift()!)
      }
    } finally {
      this.deliveringText = false
      this.pendingText.length = 0
    }
  }

  emit<TType extends GhosttyWebGpuTerminalEventType>(
    type: TType,
    event: GhosttyWebGpuTerminalEventMap[TType],
  ): void {
    const emitter = this.emitters[type]
    if (this.source.lifecycle() === 'open') {
      if (type === 'appearance') {
        this.pendingAppearance = undefined
        this.pendingAppearanceToken += 1
      }
      if (type === 'resize') {
        this.pendingResize = undefined
        this.pendingResizeToken += 1
      }
      emitter.emit(event)
      if (this.source.lifecycle() === 'open') this.extensionDispatch.events[type]?.(event)
      return
    }
    if (this.source.lifecycle() !== 'opening') return
    if (type === 'appearance') {
      this.pendingAppearance = event as GhosttyWebGpuTerminalEventMap['appearance']
      const token = ++this.pendingAppearanceToken
      this.pendingEvents.push(() => this.flushPendingAppearance(token))
      return
    }
    if (type === 'resize') {
      this.pendingResize = event as GhosttyWebGpuTerminalEventMap['resize']
      const token = ++this.pendingResizeToken
      this.pendingEvents.push(() => this.flushPendingResize(token))
      return
    }
    this.pendingEvents.push(() => this.emit(type, event))
  }

  private flushPendingAppearance(token: number): void {
    if (token !== this.pendingAppearanceToken) return
    const appearance = this.pendingAppearance
    this.pendingAppearance = undefined
    if (!appearance || this.source.appearance() !== appearance) return
    this.emit('appearance', appearance)
  }

  private flushPendingResize(token: number): void {
    if (token !== this.pendingResizeToken) return
    const resize = this.pendingResize
    this.pendingResize = undefined
    if (!resize) return
    const grid = this.source.grid()
    if (grid.columns !== resize.cols || grid.rows !== resize.rows) return
    this.emit('resize', resize)
  }

  flushPending(): void {
    const events = this.pendingEvents.splice(0)
    for (const emit of events) {
      if (this.source.lifecycle() !== 'open') return
      emit()
    }
  }
}
