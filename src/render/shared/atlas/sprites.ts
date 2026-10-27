import { boxLines } from './sprite-box-lines.js'
import type { TerminalFittedFont } from '../../../term/types.js'

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
interface Metrics {
  width: number
  height: number
  thickness: number
}
interface StrokeBounds {
  lightStart: number
  lightEnd: number
  heavyStart: number
  heavyEnd: number
  doubleStart: number
  doubleEnd: number
}

// Geometry adapted from Ghostty 7b11f3d, src/font/sprite/draw. MIT, see THIRD_PARTY_NOTICES.md.
export function spriteCodepoint(text: string): number | undefined {
  const cp = text.codePointAt(0)
  if (cp === undefined || text.length !== (cp > 0xffff ? 2 : 1)) return undefined
  if (
    (cp >= 0x2500 && cp <= 0x259f) ||
    (cp >= 0x2800 && cp <= 0x28ff) ||
    (cp >= 0x1fb00 && cp <= 0x1fb3b) ||
    (cp >= 0xe0b0 && cp <= 0xe0bf)
  )
    return cp
  return undefined
}

export function spriteThickness(font: TerminalFittedFont): number {
  // Canvas exposes no underline thickness; use Ghostty Metrics.FaceMetrics' ascent-based estimate.
  return Math.max(1, Math.ceil(0.15 * 0.75 * 0.75 * (font.deviceBaseline - font.charTop)))
}

export function drawSprite(
  context: Context,
  cp: number,
  font: TerminalFittedFont,
  span: number,
): void {
  const metrics = {
    width: font.deviceCellWidth,
    height: font.deviceCellHeight,
    thickness: spriteThickness(font),
  }
  if (cp < 0x2580) return box(context, cp, metrics)
  if (cp < 0x25a0) return block(context, cp, metrics)
  if (cp >= 0x2800 && cp <= 0x28ff)
    return braille(context, cp, metrics.width * span, metrics.height)
  if (cp >= 0x1fb00) return sextant(context, cp, metrics)
  powerline(context, cp, metrics.width * span, metrics)
}

function strokeBounds(size: number, thickness: number): StrokeBounds {
  const lightStart = Math.floor(Math.max(0, size - thickness) / 2)
  const heavyStart = Math.floor(Math.max(0, size - thickness * 2) / 2)
  return {
    lightStart,
    lightEnd: lightStart + thickness,
    heavyStart,
    heavyEnd: heavyStart + thickness * 2,
    doubleStart: Math.max(0, lightStart - thickness),
    doubleEnd: lightStart + thickness * 2,
  }
}

function armEnd(first: number, second: number, same: boolean, bounds: StrokeBounds): number {
  if (first === 2 || second === 2) return bounds.heavyEnd
  if (first !== second || same)
    return first === 3 || second === 3 ? bounds.doubleEnd : bounds.lightEnd
  if (first === 0 && second === 0) return bounds.lightEnd
  return bounds.lightStart
}

function armStart(first: number, second: number, same: boolean, bounds: StrokeBounds): number {
  if (first === 2 || second === 2) return bounds.heavyStart
  if (first !== second || same)
    return first === 3 || second === 3 ? bounds.doubleStart : bounds.lightStart
  if (first === 0 && second === 0) return bounds.lightStart
  return bounds.lightEnd
}

function box(context: Context, cp: number, m: Metrics): void {
  const packed = boxLines[cp - 0x2500] ?? -1
  if (packed >= 0) return lines(context, packed, m)
  if (cp >= 0x256d && cp <= 0x2570) return arc(context, cp, m)
  if (cp >= 0x2571 && cp <= 0x2573) return diagonal(context, cp, m)
  const vertical = (cp & 2) !== 0
  const count = cp >= 0x254c ? 2 : 3 + Number(cp >= 0x2508)
  const thickness = cp & 1 ? m.thickness * 2 : m.thickness
  const desiredGap =
    count === 2 ? Math.max(thickness, vertical ? m.thickness * 2 : 0) : Math.max(4, m.thickness)
  dashes(context, m, vertical, count, thickness, desiredGap)
}

function lines(context: Context, packed: number, m: Metrics): void {
  const up = packed & 3
  const right = (packed >> 2) & 3
  const down = (packed >> 4) & 3
  const left = (packed >> 6) & 3
  const x = strokeBounds(m.width, m.thickness)
  const y = strokeBounds(m.height, m.thickness)
  const upEnd = armEnd(left, right, up === down, y)
  const downStart = armStart(left, right, up === down, y)
  const leftEnd = armEnd(up, down, left === right, x)
  const rightStart = armStart(up, down, left === right, x)
  verticalArm(
    context,
    up,
    x,
    0,
    upEnd,
    left === 3 ? y.lightStart : upEnd,
    right === 3 ? y.lightStart : upEnd,
  )
  verticalArm(
    context,
    down,
    x,
    downStart,
    m.height,
    left === 3 ? y.lightEnd : downStart,
    right === 3 ? y.lightEnd : downStart,
    true,
  )
  horizontalArm(
    context,
    left,
    y,
    0,
    leftEnd,
    up === 3 ? x.lightStart : leftEnd,
    down === 3 ? x.lightStart : leftEnd,
  )
  horizontalArm(
    context,
    right,
    y,
    rightStart,
    m.width,
    up === 3 ? x.lightEnd : rightStart,
    down === 3 ? x.lightEnd : rightStart,
    true,
  )
}

function verticalArm(
  context: Context,
  style: number,
  x: StrokeBounds,
  start: number,
  end: number,
  first: number,
  second: number,
  reverse = false,
): void {
  if (style === 0) return
  if (style !== 3) {
    const left = style === 1 ? x.lightStart : x.heavyStart
    const right = style === 1 ? x.lightEnd : x.heavyEnd
    context.fillRect(left, start, right - left, end - start)
    return
  }
  context.fillRect(
    x.doubleStart,
    reverse ? first : start,
    x.lightStart - x.doubleStart,
    reverse ? end - first : first - start,
  )
  context.fillRect(
    x.lightEnd,
    reverse ? second : start,
    x.doubleEnd - x.lightEnd,
    reverse ? end - second : second - start,
  )
}

function horizontalArm(
  context: Context,
  style: number,
  y: StrokeBounds,
  start: number,
  end: number,
  first: number,
  second: number,
  reverse = false,
): void {
  if (style === 0) return
  if (style !== 3) {
    const top = style === 1 ? y.lightStart : y.heavyStart
    const bottom = style === 1 ? y.lightEnd : y.heavyEnd
    context.fillRect(start, top, end - start, bottom - top)
    return
  }
  context.fillRect(
    reverse ? first : start,
    y.doubleStart,
    reverse ? end - first : first - start,
    y.lightStart - y.doubleStart,
  )
  context.fillRect(
    reverse ? second : start,
    y.lightEnd,
    reverse ? end - second : second - start,
    y.doubleEnd - y.lightEnd,
  )
}

function dashes(
  context: Context,
  m: Metrics,
  vertical: boolean,
  count: number,
  thickness: number,
  desiredGap: number,
): void {
  const length = vertical ? m.height : m.width
  const breadth = vertical ? m.width : m.height
  if (length < count * 2) return lines(context, vertical ? 17 : 68, m)
  const gap = Math.min(desiredGap, Math.floor(length / (2 * count)))
  const available = length - count * gap
  const dash = Math.floor(available / count)
  const cross = Math.floor(Math.max(0, breadth - thickness) / 2)
  let position = vertical ? 0 : Math.floor(gap / 2)
  for (let index = 0; index < count; index++) {
    const size = dash + Number(index < available % count)
    if (vertical) context.fillRect(cross, position, thickness, size)
    if (!vertical) context.fillRect(position, cross, size, thickness)
    position += size + gap
  }
}

function arc(context: Context, cp: number, m: Metrics): void {
  const x = Math.floor(Math.max(0, m.width - m.thickness) / 2) + m.thickness / 2
  const y = Math.floor(Math.max(0, m.height - m.thickness) / 2) + m.thickness / 2
  const r = Math.min(m.width, m.height) / 2
  const right = cp === 0x256d || cp === 0x2570
  const bottom = cp === 0x256d || cp === 0x256e
  const sx = right ? 1 : -1
  const sy = bottom ? 1 : -1
  context.beginPath()
  context.moveTo(x, bottom ? m.height : 0)
  context.lineTo(x, y + sy * r)
  context.bezierCurveTo(x, y + sy * 0.25 * r, x + sx * 0.25 * r, y, x + sx * r, y)
  context.lineTo(right ? m.width : 0, y)
  context.lineWidth = m.thickness
  context.stroke()
}

function diagonal(context: Context, cp: number, m: Metrics): void {
  const dx = 0.5 * Math.min(1, m.width / m.height)
  const dy = 0.5 * Math.min(1, m.height / m.width)
  context.lineWidth = m.thickness
  context.beginPath()
  if (cp !== 0x2572) {
    context.moveTo(m.width + dx, -dy)
    context.lineTo(-dx, m.height + dy)
  }
  if (cp !== 0x2571) {
    context.moveTo(-dx, -dy)
    context.lineTo(m.width + dx, m.height + dy)
  }
  context.stroke()
}

function fractionRect(
  context: Context,
  m: Metrics,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): void {
  const left = m.width - Math.round((1 - x0) * m.width)
  const top = m.height - Math.round((1 - y0) * m.height)
  context.fillRect(left, top, Math.round(x1 * m.width) - left, Math.round(y1 * m.height) - top)
}

function block(context: Context, cp: number, m: Metrics): void {
  if (cp === 0x2580 || (cp >= 0x2581 && cp <= 0x2588) || cp === 0x2594) {
    let height = Math.round((m.height * (cp - 0x2580)) / 8)
    if (cp === 0x2580) height = Math.round(m.height / 2)
    if (cp === 0x2594) height = Math.round(m.height / 8)
    context.fillRect(0, cp >= 0x2581 && cp <= 0x2588 ? m.height - height : 0, m.width, height)
    return
  }
  if (cp <= 0x2590 || cp === 0x2595) {
    let width = Math.round((m.width * (0x2590 - cp)) / 8)
    if (cp === 0x2590) width = Math.round(m.width / 2)
    if (cp === 0x2595) width = Math.round(m.width / 8)
    context.fillRect(cp >= 0x2590 ? m.width - width : 0, 0, width, m.height)
    return
  }
  if (cp <= 0x2593) {
    context.globalAlpha = ((cp - 0x2590) * 64) / 255
    context.fillRect(0, 0, m.width, m.height)
    context.globalAlpha = 1
    return
  }
  const mask = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14][cp - 0x2596] ?? 0
  for (let index = 0; index < 4; index++) {
    if ((mask & (1 << index)) === 0) continue
    const x = index % 2
    const y = Math.floor(index / 2)
    fractionRect(context, m, x / 2, (x + 1) / 2, y / 2, (y + 1) / 2)
  }
}

function sextant(context: Context, cp: number, m: Metrics): void {
  const index = cp - 0x1fb00
  const mask = index + Math.floor(index / 20) + 1
  for (let bit = 0; bit < 6; bit++) {
    if ((mask & (1 << bit)) === 0) continue
    const x = bit % 2
    const y = Math.floor(bit / 2)
    fractionRect(context, m, x / 2, (x + 1) / 2, y / 3, (y + 1) / 3)
  }
}

function braille(context: Context, cp: number, width: number, height: number): void {
  let dot = Math.min(Math.floor(width / 4), Math.floor(height / 8))
  let xs = Math.floor(width / 4)
  let ys = Math.floor(height / 8)
  let xm = Math.floor(xs / 2)
  let ym = Math.floor(ys / 2)
  let xr = width - 2 * xm - xs - 2 * dot
  let yr = height - 2 * ym - 3 * ys - 4 * dot
  if (xr >= 2 && yr >= 4 && dot === 0) {
    dot++
    xr -= 2
    yr -= 4
  }
  if (xr >= 2 && xm === 0) {
    xm = 1
    xr -= 2
  }
  if (yr >= 2 && ym === 0) {
    ym = 1
    yr -= 2
  }
  if (xr >= 1) {
    xs++
    xr--
  }
  if (yr >= 3) {
    ys++
    yr -= 3
  }
  if (xr >= 2) {
    xm++
    xr -= 2
  }
  if (yr >= 2) {
    ym++
    yr -= 2
  }
  if (xr >= 2 && yr >= 4) dot++
  const rows = [0, 1, 2, 0, 1, 2, 3, 3]
  const columns = [0, 0, 0, 1, 1, 1, 0, 1]
  for (let bit = 0; bit < 8; bit++) {
    if ((cp & (1 << bit)) === 0) continue
    context.fillRect(xm + columns[bit]! * (dot + xs), ym + rows[bit]! * (dot + ys), dot, dot)
  }
}

function powerline(context: Context, cp: number, width: number, m: Metrics): void {
  const { height, thickness } = m
  if (cp >= 0xe0b8) {
    if (cp & 1) return diagonal(context, cp === 0xe0bb || cp === 0xe0bd ? 0x2571 : 0x2572, m)
    context.beginPath()
    const right = cp === 0xe0ba || cp === 0xe0be
    const bottom = cp === 0xe0b8 || cp === 0xe0ba
    context.moveTo(right ? width : 0, 0)
    context.lineTo(right ? 0 : width, bottom ? height : 0)
    context.lineTo(right ? width : 0, height)
    context.fill()
    return
  }
  const flipped = cp === 0xe0b2 || cp === 0xe0b3 || cp === 0xe0b6 || cp === 0xe0b7
  context.save()
  if (flipped) {
    context.translate(width, 0)
    context.scale(-1, 1)
  }
  context.beginPath()
  if (cp < 0xe0b4) {
    context.moveTo(0, 0)
    context.lineTo(width, height / 2)
    context.lineTo(0, height)
  } else {
    const radius = Math.min(width, height / 2)
    const c = ((Math.SQRT2 - 1) * 4) / 3
    const inset = cp & 1 ? thickness / 2 : 0
    const r = Math.max(0, radius - inset)
    context.moveTo(0, inset)
    if (cp & 1) context.lineTo(1, inset)
    context.bezierCurveTo(r * c, inset, r, radius - r * c, r, radius)
    context.lineTo(r, height - radius)
    context.bezierCurveTo(
      r,
      height - radius + r * c,
      r * c,
      height - inset,
      cp & 1 ? 1 : 0,
      height - inset,
    )
    if (cp & 1) context.lineTo(0, height - inset)
  }
  if (cp & 1) {
    context.lineWidth = thickness
    context.stroke()
  } else {
    context.closePath()
    context.fill()
  }
  context.restore()
}
