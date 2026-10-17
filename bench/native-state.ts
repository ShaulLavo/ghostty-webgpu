import type { GhosttyRenderState } from '../src/core/render-state.js'
import type { RenderStateSource } from '../src/render/shared/types.js'

export interface DecodedRows {
  cells: number
  rows: number
}

export function measuredRenderState(
  state: GhosttyRenderState,
  decoded: DecodedRows,
): RenderStateSource {
  return {
    get snapshotVersion() {
      return state.snapshotVersion
    },
    createFrameBuilder: (columns, rows) => state.createFrameBuilder(columns, rows),
    update: () => state.update(),
    acknowledge: () => state.acknowledge(),
    readCursor: () => state.readCursor(),
    readRows: (options) => {
      const rows = state.readRows(options)
      decoded.rows += rows.length
      decoded.cells += rows.reduce((sum, row) => sum + row.cells.length, 0)
      return rows
    },
  }
}
