import { renderCursorState } from './cursor.js'
import { copiedFrameRow } from './frame-row.js'
import type { RendererFrameSnapshot, RenderStateSource } from './renderer.js'

export function snapshotRenderState(state: RenderStateSource): RendererFrameSnapshot {
  state.update()
  const cursor = state.readCursor()
  return Object.freeze({
    cursor: Object.freeze({
      ...cursor,
      viewport: cursor.viewport ? Object.freeze({ ...cursor.viewport }) : undefined,
    }),
    paintedCursor: renderCursorState(cursor, true),
    rows: Object.freeze(state.readRows().map(copiedFrameRow)),
  })
}
