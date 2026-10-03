import { createGhosttyError } from '../core/error.js'
import type { RenderRow } from '../core/types.js'
import type { GlyphAtlas } from './atlas/atlas.js'
import type { RowInstanceUpdate } from './instances/types.js'
import type { RenderStateSource } from './renderer.js'

export function rebuildFrame(
  initialRows: readonly RenderRow[],
  state: RenderStateSource,
  atlas: GlyphAtlas,
  rebuild: (rows: readonly RenderRow[]) => readonly RowInstanceUpdate[],
): { rows: readonly RenderRow[]; updates: readonly RowInstanceUpdate[] } {
  const initialUpdates = rebuild(initialRows)
  if (!initialUpdates.some((update) => update.invalidatedRows.length > 0)) {
    return { rows: initialRows, updates: initialUpdates }
  }
  // Reset old references so eviction recovery paints this captured state in the same call.
  atlas.invalidateAll()
  const rows = state.readRows({ packed: true })
  const updates = rebuild(rows)
  if (updates.some((update) => update.invalidatedRows.length > 0)) {
    throw createGhosttyError('renderer.atlas', 'The glyph atlas cannot retain the visible viewport')
  }
  return { rows, updates }
}
