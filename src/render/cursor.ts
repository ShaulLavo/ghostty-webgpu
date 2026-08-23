import type { RenderCursorSnapshot } from '../core/types.js'
import type { CursorState } from './instances/types.js'

export function renderCursorState(
  cursor: RenderCursorSnapshot | undefined,
  phaseVisible: boolean,
): CursorState | undefined {
  const viewport = cursor?.viewport
  if (!cursor || !viewport) return undefined
  return {
    style: cursor.style,
    visible: cursor.visible && phaseVisible,
    x: viewport.wideTail ? Math.max(0, viewport.x - 1) : viewport.x,
    y: viewport.y,
  }
}
