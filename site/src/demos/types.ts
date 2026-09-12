export interface DemoGrid {
  readonly cols: number
  readonly rows: number
}

export interface DemoInfo {
  readonly backend: string
  readonly fontFamily: string
  readonly revision: string
  readonly version: string
}

export interface DemoContext {
  grid(): DemoGrid
  info(): DemoInfo
  write(data: string): void
}

export interface Demo {
  readonly id: string
  readonly label: string
  readonly caption: string
  readonly animated: boolean
  /** A grid the demo would like to fit; the page shrinks the font to make room. */
  readonly fit?: DemoGrid
  start(context: DemoContext): void
  stop(): void
  resize(): void
  setPaused(paused: boolean): void
  input?(bytes: Uint8Array): void
}

const FRAME_INTERVAL_MS = 1000 / 30

/** Shared frame loop: 30 frames per second, pausable, stops cleanly. */
export abstract class AnimatedDemo implements Demo {
  abstract readonly id: string
  abstract readonly label: string
  abstract readonly caption: string
  readonly animated = true
  protected context: DemoContext | undefined
  private handle = 0
  private paused = false
  private lastFrameAt = 0
  private elapsed = 0

  start(context: DemoContext): void {
    this.context = context
    this.elapsed = 0
    this.lastFrameAt = 0
    this.layout()
    this.schedule()
  }

  stop(): void {
    cancelAnimationFrame(this.handle)
    this.handle = 0
    this.context = undefined
  }

  resize(): void {
    if (!this.context) return
    this.layout()
    if (this.paused) this.frame(0, this.elapsed)
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    if (paused) {
      cancelAnimationFrame(this.handle)
      this.handle = 0
      return
    }
    this.lastFrameAt = 0
    this.schedule()
  }

  protected abstract layout(): void
  protected abstract frame(deltaSeconds: number, elapsedSeconds: number): void

  private schedule(): void {
    if (!this.context || this.handle !== 0) return
    this.handle = requestAnimationFrame((now) => this.tick(now))
  }

  private tick(now: number): void {
    this.handle = 0
    if (!this.context || this.paused) return
    if (this.lastFrameAt === 0) this.lastFrameAt = now - FRAME_INTERVAL_MS
    const delta = now - this.lastFrameAt
    if (delta >= FRAME_INTERVAL_MS - 1) {
      const deltaSeconds = Math.min(delta, 100) / 1000
      this.elapsed += deltaSeconds
      this.lastFrameAt = now
      this.frame(deltaSeconds, this.elapsed)
    }
    this.schedule()
  }
}
