import type { Terminal } from '../../dist/index.js'

const FADE_SECONDS = 0.35
const PEAK_ALPHA = 0.16
const TINT = '126, 230, 206'
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

/** Tints each row the renderer repainted, fading so a steady redraw reads as a steady glow. */
export class DamageOverlay {
  private readonly canvas = document.createElement('canvas')
  private readonly context = this.canvas.getContext('2d')
  private heat: number[] = []
  private handle = 0
  private lastAt = 0
  private subscription: { dispose(): void } | undefined

  constructor(private readonly host: HTMLElement) {
    this.canvas.className = 'damage-overlay'
    this.canvas.setAttribute('aria-hidden', 'true')
  }

  get supported(): boolean {
    return this.context !== null
  }

  get enabled(): boolean {
    return this.subscription !== undefined
  }

  enable(terminal: Terminal): void {
    if (this.subscription || !this.context) return
    this.host.append(this.canvas)
    this.subscription = terminal.onFrame(({ rows }) => this.mark(terminal, rows))
  }

  disable(): void {
    this.subscription?.dispose()
    this.subscription = undefined
    cancelAnimationFrame(this.handle)
    this.handle = 0
    this.lastAt = 0
    this.heat = []
    this.canvas.remove()
  }

  private mark(terminal: Terminal, rows: readonly number[]): void {
    const count = terminal.appearance.grid.rows
    // Reduced motion shows only the latest frame's rows, held still.
    if (this.heat.length !== count || reducedMotion.matches) {
      this.heat = new Array<number>(count).fill(0)
    }
    for (const row of rows) {
      if (row >= 0 && row < count) this.heat[row] = 1
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.handle !== 0) return
    this.handle = requestAnimationFrame((now) => this.paint(now))
  }

  private paint(now: number): void {
    this.handle = 0
    if (!this.context) return
    const still = reducedMotion.matches
    const delta = this.lastAt === 0 || still ? 0 : (now - this.lastAt) / 1000
    this.lastAt = now
    const target = this.host.querySelector<HTMLCanvasElement>('canvas:not(.damage-overlay)')
    if (!target) return
    // The grid fills the canvas content box; its inline padding sits outside the rows.
    const style = getComputedStyle(target)
    const left = Number.parseFloat(style.paddingLeft)
    const top = Number.parseFloat(style.paddingTop)
    const width = target.clientWidth - left - Number.parseFloat(style.paddingRight)
    const height = target.clientHeight - top - Number.parseFloat(style.paddingBottom)
    this.place(target, left, top, width, height)
    this.context.clearRect(0, 0, width, height)
    const rowHeight = height / Math.max(1, this.heat.length)
    let warm = false
    for (let row = 0; row < this.heat.length; row += 1) {
      const heat = Math.max(0, this.heat[row]! - delta / FADE_SECONDS)
      this.heat[row] = heat
      if (heat === 0) continue
      warm = true
      this.context.fillStyle = `rgba(${TINT}, ${(heat * PEAK_ALPHA).toFixed(3)})`
      this.context.fillRect(0, row * rowHeight, width, rowHeight)
    }
    if (warm && !still) this.schedule()
    if (!warm || still) this.lastAt = 0
  }

  private place(
    target: HTMLCanvasElement,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    const hostRect = this.host.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    this.canvas.style.left = `${targetRect.left - hostRect.left + target.clientLeft + left}px`
    this.canvas.style.top = `${targetRect.top - hostRect.top + target.clientTop + top}px`
    const ratio = window.devicePixelRatio || 1
    const pixelWidth = Math.round(width * ratio)
    const pixelHeight = Math.round(height * ratio)
    if (this.canvas.width === pixelWidth && this.canvas.height === pixelHeight) return
    this.canvas.width = pixelWidth
    this.canvas.height = pixelHeight
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.context?.setTransform(ratio, 0, 0, ratio, 0, 0)
  }
}
