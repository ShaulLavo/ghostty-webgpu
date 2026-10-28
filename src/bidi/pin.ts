import { GhosttyResult, PointTag } from '../core/abi.js'
import { assertGhosttyResult } from '../core/error.js'
import { requireLayout } from '../core/memory.js'
import type { SelectionPoint } from '../core/selection.js'
import type { GhosttyTerminal } from '../core/terminal.js'

export class CellPin {
  private readonly handle: number

  constructor(
    private readonly vt: GhosttyTerminal,
    cell: SelectionPoint,
  ) {
    const runtime = vt.runtime
    const point = requireLayout(runtime.layouts, 'GhosttyPoint')
    const value = requireLayout(runtime.layouts, 'GhosttyPointValue')
    const coordinate = requireLayout(runtime.layouts, 'GhosttyPointCoordinate')
    const pointer = runtime.memory.allocate(point.size)
    const out = runtime.memory.allocateOpaque()
    try {
      const view = runtime.memory.view
      view.setInt32(pointer + point.fields.tag!.offset, PointTag.Viewport, true)
      const position = pointer + point.fields.value!.offset + value.fields.coordinate!.offset
      view.setUint16(position + coordinate.fields.x!.offset, cell.x, true)
      view.setUint32(position + coordinate.fields.y!.offset, cell.y, true)
      assertGhosttyResult(
        'bidi.pin',
        runtime.exports.ghostty_terminal_grid_ref_track(vt.handle, pointer, out),
      )
      this.handle = runtime.memory.takeOpaque(out, 'bidi.pin')
    } finally {
      runtime.memory.free(pointer, point.size)
      runtime.memory.freeOpaque(out)
    }
  }

  point(): SelectionPoint | undefined {
    const runtime = this.vt.runtime
    const layout = requireLayout(runtime.layouts, 'GhosttyPointCoordinate')
    const pointer = runtime.memory.allocate(layout.size)
    try {
      const result = runtime.exports.ghostty_tracked_grid_ref_point(
        this.handle,
        PointTag.Screen,
        pointer,
      )
      if (result === GhosttyResult.NoValue) return undefined
      assertGhosttyResult('bidi.pin.read', result)
      const view = runtime.memory.view
      return {
        x: view.getUint16(pointer + layout.fields.x!.offset, true),
        y: view.getUint32(pointer + layout.fields.y!.offset, true),
      }
    } finally {
      runtime.memory.free(pointer, layout.size)
    }
  }

  dispose(): void {
    this.vt.runtime.exports.ghostty_tracked_grid_ref_free(this.handle)
  }
}
