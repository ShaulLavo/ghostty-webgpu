import type { RenderCursorSnapshot } from '../core/types.js'
import type { CursorState, CursorStyle } from './instances/types.js'

export type InactiveCursorStyle = CursorStyle | 'none'

export function renderCursorState(
  cursor: RenderCursorSnapshot | undefined,
  phaseVisible: boolean,
  styleOverride?: InactiveCursorStyle,
): CursorState | undefined {
  const viewport = cursor?.viewport
  if (!cursor || !viewport) return undefined
  const style = styleOverride ?? cursor.style
  return {
    style: style === 'none' ? cursor.style : style,
    visible: cursor.visible && phaseVisible && style !== 'none',
    x: viewport.wideTail ? Math.max(0, viewport.x - 1) : viewport.x,
    y: viewport.y,
  }
}
