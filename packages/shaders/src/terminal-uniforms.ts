import type { TerminalApi } from 'ghostty-webgpu'
import type { ShaderFrame } from './frame-schedule.js'
import type { ShaderUniformValues } from './uniforms.js'
import type { ShaderVector3, ShaderVector4 } from './types.js'

type Color = { readonly r: number; readonly g: number; readonly b: number }
function rgb(color: Color): ShaderVector3 {
  return [color.r / 255, color.g / 255, color.b / 255]
}
function rgba(color: Color): ShaderVector4 {
  return [color.r / 255, color.g / 255, color.b / 255, 1]
}

export class UniformState {
  current: ShaderVector4 = [0, 0, 0, 0]
  previous: ShaderVector4 = [0, 0, 0, 0]
  currentColor: ShaderVector4 = [0, 0, 0, 0]
  previousColor: ShaderVector4 = [0, 0, 0, 0]
  style = 0
  previousStyle = 0
  changedAt = 0
  focusAt = 0
  mouse: ShaderVector4 = [0, 0, 0, 0]
  focusChanged(time: number): void {
    this.focusAt = time
  }
  pointer(type: string, x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const previous = this.mouse
    if (type === 'pointerdown') {
      this.mouse = [x, y, x, y]
      return
    }
    if (type === 'pointerup') {
      this.mouse = [x, y, -Math.abs(previous[2]), -Math.abs(previous[3])]
      return
    }
    this.mouse = [x, y, previous[2], previous[3]]
  }
  update(cursor: ShaderVector4, color: ShaderVector4, style: number, time: number): void {
    if (
      cursor.every((value, index) => value === this.current[index]) &&
      color.every((value, index) => value === this.currentColor[index]) &&
      style === this.style
    )
      return
    this.previous = this.current
    this.previousColor = this.currentColor
    this.previousStyle = this.style
    this.current = cursor
    this.currentColor = color
    this.style = style
    this.changedAt = time
  }
}

function cursorStyle(style: string): number {
  if (style === 'bar') return 2
  if (style === 'underline') return 3
  return 0
}

export function frameUniforms(
  terminal: TerminalApi,
  state: UniformState,
  frame: ShaderFrame,
  size: { width: number; height: number },
): Partial<ShaderUniformValues> {
  const submitted = terminal.submittedFrame
  const theme = submitted?.theme ?? terminal.appearance.theme
  const cursor = submitted?.paintedCursor ?? submitted?.cursor.viewport
  const grid = submitted?.grid ?? terminal.appearance.grid
  const width = size.width / grid.columns
  const height = size.height / grid.rows
  const position: ShaderVector4 = cursor
    ? [cursor.x * width, size.height - cursor.y * height, width, height]
    : [0, 0, 0, 0]
  state.update(
    position,
    rgba(theme.cursor),
    cursorStyle(
      submitted?.paintedCursor?.style ??
        submitted?.cursor.style ??
        terminal.appearance.cursor.style,
    ),
    frame.time,
  )
  const date = new Date()
  const seconds =
    date.getHours() * 3600 +
    date.getMinutes() * 60 +
    date.getSeconds() +
    date.getMilliseconds() / 1000
  return {
    iResolution: [size.width, size.height, 1],
    iTime: frame.time,
    iTimeDelta: frame.delta,
    iFrameRate: frame.delta > 0 ? 1 / frame.delta : 0,
    iFrame: frame.frame,
    iChannelTime: [frame.time, 0, 0, 0],
    iChannelResolution: [
      [size.width, size.height, 1],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    iMouse: state.mouse,
    iDate: [date.getFullYear(), date.getMonth(), date.getDate(), seconds],
    iCurrentCursor: state.current,
    iPreviousCursor: state.previous,
    iCurrentCursorColor: state.currentColor,
    iPreviousCursorColor: state.previousColor,
    iCurrentCursorStyle: state.style,
    iPreviousCursorStyle: state.previousStyle,
    iCursorVisible: submitted?.paintedCursor?.visible ? 1 : 0,
    iTimeCursorChange: state.changedAt,
    iFocus: terminal.element?.contains(terminal.element.ownerDocument.activeElement) ? 1 : 0,
    iTimeFocus: state.focusAt,
    iPalette: terminal.appearance.theme.palette.map(rgb),
    iBackgroundColor: rgb(theme.background),
    iForegroundColor: rgb(theme.foreground),
    iCursorColor: rgb(theme.cursor),
    iCursorText: rgb(theme.cursorText ?? theme.background),
    iSelectionForegroundColor: rgb(theme.selectionForeground),
    iSelectionBackgroundColor: rgb(theme.selectionBackground),
  }
}
