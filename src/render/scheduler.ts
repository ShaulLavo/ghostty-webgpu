export interface RenderSchedulerClock {
  cancelFrame(handle: number): void
  clearTimer(handle: number): void
  requestFrame(callback: () => void): number
  setTimer(callback: () => void, delayMs: number): number
}

export interface RenderFrameState {
  cursorVisible: boolean
}

export interface RenderSchedulerOptions {
  blinkIntervalMs?: number
  clock: RenderSchedulerClock
  onFrame(state: RenderFrameState): void
}

const defaultBlinkIntervalMs = 500

function validateBlinkInterval(value: number): number {
  if (Number.isFinite(value) && value > 0) return value
  throw new RangeError('blinkIntervalMs must be greater than zero')
}

export class RenderScheduler {
  private blinkEnabled = false
  private readonly blinkIntervalMs: number
  private blinkTimerHandle?: number
  private blinkTimerToken = 0
  private readonly clock: RenderSchedulerClock
  private cursorVisibleValue = true
  private disposed = false
  private documentVisible = true
  private focused = false
  private frameHandle?: number
  private frameToken = 0
  private readonly onFrame: (state: RenderFrameState) => void

  constructor(options: RenderSchedulerOptions) {
    this.clock = options.clock
    this.onFrame = options.onFrame
    this.blinkIntervalMs = validateBlinkInterval(options.blinkIntervalMs ?? defaultBlinkIntervalMs)
  }

  get cursorVisible(): boolean {
    return this.cursorVisibleValue
  }

  get hasPendingFrame(): boolean {
    return this.frameHandle !== undefined
  }

  get hasPendingTimer(): boolean {
    return this.blinkTimerHandle !== undefined
  }

  schedule(): void {
    if (this.disposed) return
    if (!this.documentVisible) return
    if (this.frameHandle !== undefined) return
    const token = ++this.frameToken
    this.frameHandle = this.clock.requestFrame(() => this.runFrame(token))
  }

  setCursorBlinkEnabled(enabled: boolean): void {
    if (this.disposed) return
    if (this.blinkEnabled === enabled) return
    this.blinkEnabled = enabled
    this.synchronizeBlinkTimer()
    this.schedule()
  }

  setDocumentVisible(visible: boolean): void {
    if (this.disposed) return
    if (this.documentVisible === visible) return
    this.documentVisible = visible
    this.synchronizeBlinkTimer()
    if (!visible) {
      this.cancelFrame()
      return
    }
    this.schedule()
  }

  setFocused(focused: boolean): void {
    if (this.disposed) return
    if (this.focused === focused) return
    this.focused = focused
    this.synchronizeBlinkTimer()
    this.schedule()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelFrame()
    this.cancelBlinkTimer()
  }

  private get blinkEligible(): boolean {
    return this.blinkEnabled && this.documentVisible && this.focused
  }

  private armBlinkTimer(): void {
    if (!this.blinkEligible) return
    if (this.blinkTimerHandle !== undefined) return
    const token = ++this.blinkTimerToken
    this.blinkTimerHandle = this.clock.setTimer(
      () => this.runBlinkTransition(token),
      this.blinkIntervalMs,
    )
  }

  private cancelBlinkTimer(): void {
    this.blinkTimerToken += 1
    if (this.blinkTimerHandle === undefined) return
    this.clock.clearTimer(this.blinkTimerHandle)
    this.blinkTimerHandle = undefined
  }

  private cancelFrame(): void {
    this.frameToken += 1
    if (this.frameHandle === undefined) return
    this.clock.cancelFrame(this.frameHandle)
    this.frameHandle = undefined
  }

  private restoreCursor(): void {
    this.cursorVisibleValue = true
  }

  private runBlinkTransition(token: number): void {
    if (this.disposed) return
    if (token !== this.blinkTimerToken) return
    this.blinkTimerHandle = undefined
    if (!this.blinkEligible) return
    this.cursorVisibleValue = !this.cursorVisibleValue
    this.schedule()
    this.armBlinkTimer()
  }

  private runFrame(token: number): void {
    if (this.disposed) return
    if (token !== this.frameToken) return
    this.frameHandle = undefined
    this.onFrame({ cursorVisible: this.cursorVisibleValue })
  }

  private synchronizeBlinkTimer(): void {
    if (this.blinkEligible) {
      this.armBlinkTimer()
      return
    }
    this.cancelBlinkTimer()
    this.restoreCursor()
  }
}
