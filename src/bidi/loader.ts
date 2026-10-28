import type { RowBidiMapper } from './row.js'
import type { RenderStateSource } from '../render/shared/types.js'
import type { CursorState } from '../render/shared/instances/types.js'

export async function loadBidiMapper(): Promise<RowBidiMapper> {
  const { RowBidiMapper } = await import('./row.js')
  return new RowBidiMapper()
}

export function paintedBidiCursor(
  mapper: RowBidiMapper | undefined,
  source: RenderStateSource,
  cursor: CursorState | undefined,
): CursorState | undefined {
  return mapper ? mapper.paintedCursor(source, cursor) : cursor
}
