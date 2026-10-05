import type { RenderSchedulerClock } from './scheduler.js'

export interface FrameSubmission {
  readonly owner: object
  readonly device: GPUDevice
  readonly command: GPUCommandBuffer
  commit(): void
  notify(): void
  failed(cause: unknown): void
}

export class FrameCoordinator implements RenderSchedulerClock {
  private readonly callbacks = new Map<number, () => void>()
  private readonly pending: FrameSubmission[] = []
  private nextHandle = 0
  private frameHandle?: number
  private active = false

  constructor(private readonly clock: RenderSchedulerClock) {}

  requestFrame(callback: () => void): number {
    const handle = ++this.nextHandle
    this.callbacks.set(handle, callback)
    this.frameHandle ??= this.clock.requestFrame(() => this.runFrame())
    return handle
  }

  cancelFrame(handle: number): void {
    this.callbacks.delete(handle)
    if (this.callbacks.size !== 0 || this.frameHandle === undefined) return
    this.clock.cancelFrame(this.frameHandle)
    this.frameHandle = undefined
  }

  setTimer(callback: () => void, delayMs: number): number {
    return this.clock.setTimer(callback, delayMs)
  }

  clearTimer(handle: number): void {
    this.clock.clearTimer(handle)
  }

  submit(frame: FrameSubmission): void {
    if (!this.active) {
      frame.device.queue.submit([frame.command])
      frame.commit()
      frame.notify()
      return
    }
    this.pending.push(frame)
  }

  flushPending(): void {
    this.flush()
  }

  flushOwner(owner: object): void {
    if (this.pending.some((frame) => frame.owner === owner)) this.flushPending()
  }

  private runFrame(): void {
    this.frameHandle = undefined
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    this.active = true
    try {
      for (const callback of callbacks) this.invoke(callback)
    } finally {
      this.flush()
      this.active = false
    }
  }

  private flush(): void {
    const frames = this.pending.splice(0)
    if (frames.length === 0) return
    const groups = new Map<GPUDevice, FrameSubmission[]>()
    for (const frame of frames) {
      const group = groups.get(frame.device) ?? []
      group.push(frame)
      groups.set(frame.device, group)
    }
    const submitted: FrameSubmission[] = []
    const failures: { frame: FrameSubmission; cause: unknown }[] = []
    for (const [device, group] of groups) {
      const result = this.submitGroup(device, group)
      if (result.kind === 'submitted') submitted.push(...result.frames)
      else failures.push(...result.frames.map((frame) => ({ frame, cause: result.cause })))
    }
    const committed = submitted.filter((frame) => this.invoke(() => frame.commit()))
    for (const failure of failures) this.invoke(() => failure.frame.failed(failure.cause))
    for (const frame of committed) this.invoke(() => frame.notify())
    this.flush()
  }

  private submitGroup(
    device: GPUDevice,
    frames: readonly FrameSubmission[],
  ):
    | { kind: 'submitted'; frames: readonly FrameSubmission[] }
    | { kind: 'failed'; frames: readonly FrameSubmission[]; cause: unknown } {
    try {
      device.queue.submit(frames.map((frame) => frame.command))
      return { kind: 'submitted', frames }
    } catch (cause) {
      return { kind: 'failed', frames, cause }
    }
  }

  private invoke(callback: () => void): boolean {
    try {
      callback()
      return true
    } catch (cause) {
      queueMicrotask(() => {
        throw cause
      })
      return false
    }
  }
}
