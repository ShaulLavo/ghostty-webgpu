export interface ShaderFrame {
  readonly time: number
  readonly delta: number
  readonly frame: number
}

export class FrameSchedule {
  #activeSince: number | undefined
  #elapsed = 0
  #lastDrawTime = 0
  #frame = 0
  #dirty = true

  get pending(): boolean {
    return this.#dirty || this.#activeSince !== undefined
  }

  setActive(active: boolean, timestamp: number): void {
    if (active === (this.#activeSince !== undefined)) return
    this.#elapsed = this.timeAt(timestamp)
    this.#activeSince = active ? timestamp : undefined
  }

  invalidate(): void {
    this.#dirty = true
  }

  timeAt(timestamp: number): number {
    if (this.#activeSince === undefined) return this.#elapsed
    return this.#elapsed + Math.max(0, timestamp - this.#activeSince) / 1000
  }

  draw(timestamp: number, submit: (frame: ShaderFrame) => boolean): void {
    if (!this.pending) return
    const time = this.timeAt(timestamp)
    const delta = Math.max(0, time - this.#lastDrawTime)
    this.#dirty = true
    if (!submit({ time, delta, frame: this.#frame })) return
    this.#dirty = false
    this.#lastDrawTime = time
    this.#frame = (this.#frame + 1) % 2147483647
  }
}
