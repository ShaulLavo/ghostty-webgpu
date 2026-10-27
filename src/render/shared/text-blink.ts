import { emptyRenderCell } from '../../core/packed-cells.js'
import type { RenderCell, RenderRow } from '../../core/types.js'
import type { RenderSchedulerClock } from './scheduler.js'

export function cellNeedsTextBlink(cell: RenderCell): boolean {
  if (!cell.style?.blink || cell.style.invisible) return false
  if (cell.style.underline || cell.style.overline || cell.style.strikethrough) return true
  return !cell.continuation && cell.text.trim().length > 0
}

export function rowNeedsTextBlink(row: RenderRow): boolean {
  if (!row.packed) return row.cells.some(cellNeedsTextBlink)
  const cell = emptyRenderCell()
  for (let index = 0; index < row.packed.length; index += 1) {
    if (cellNeedsTextBlink(row.packed.read(index, cell))) return true
  }
  return false
}

export class TextBlink {
  private timer?: number
  private token = 0
  private needed = false
  private active = false
  private reducedMotion = false
  visible = true

  constructor(
    private readonly clock: RenderSchedulerClock,
    private readonly repaint: () => void,
  ) {}

  get hasPendingTimer(): boolean {
    return this.timer !== undefined
  }

  setNeeded(needed: boolean): void {
    this.needed = needed
    this.synchronize()
  }

  setActive(active: boolean): void {
    this.active = active
    this.synchronize()
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced
    this.synchronize()
  }

  dispose(): void {
    this.active = false
    this.needed = false
    this.cancelTimer()
  }

  private cancelTimer(): void {
    this.token += 1
    if (this.timer !== undefined) this.clock.clearTimer(this.timer)
    this.timer = undefined
  }

  private synchronize(): void {
    if (this.needed && this.active && !this.reducedMotion) {
      this.arm()
      return
    }
    this.cancelTimer()
    if (this.visible) return
    this.visible = true
    this.repaint()
  }

  private arm(): void {
    if (this.timer !== undefined) return
    const token = ++this.token
    this.timer = this.clock.setTimer(() => {
      if (token !== this.token) return
      this.timer = undefined
      this.visible = !this.visible
      this.repaint()
      this.arm()
    }, 600)
  }
}
