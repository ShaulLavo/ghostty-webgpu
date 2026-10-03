import { onTestFinished } from 'vitest'
import { GhosttyRuntime } from '../../core/runtime.js'
import { GhosttySelectionGesture } from '../../core/selection.js'
import type { RenderCell, RenderRow, RgbColor } from '../../core/types.js'
import type { RenderStateSource } from '../renderer.js'

function colorSequence(color: RgbColor | undefined, foreground: boolean): string {
  if (!color) return ''
  return `\x1b[${foreground ? 38 : 48};2;${color.r};${color.g};${color.b}m`
}

function cellSequence(cell: RenderCell, y: number): string {
  const style = cell.style
  const codes: (string | number)[] = [0]
  if (style?.bold) codes.push(1)
  if (style?.faint) codes.push(2)
  if (style?.italic) codes.push(3)
  if (style?.inverse) codes.push(7)
  if (style?.invisible) codes.push(8)
  if (style?.strikethrough) codes.push(9)
  if (style?.overline) codes.push(53)
  if (style?.underline) codes.push(`4:${style.underline}`)
  return `\x1b[${y + 1};${cell.x + 1}H\x1b[${codes.join(';')}m${colorSequence(cell.foreground, true)}${colorSequence(cell.background, false)}${cell.text || ' '}`
}

export async function createNativeTestState(columns: number, rows: number) {
  const runtime = await GhosttyRuntime.create()
  onTestFinished(() => runtime.dispose())
  const terminal = runtime.createTerminal({ columns, rows })
  const state = runtime.createRenderState(terminal)
  const selection = new GhosttySelectionGesture(terminal)
  onTestFinished(() => selection.dispose())
  terminal.write('\x1b[?25l\x1b[?7l\x1b[?2027h')
  const previous = new Map<number, string>()

  const writeRows = (source: readonly RenderRow[], full = false) => {
    for (const row of source) {
      const content = row.cells
        .filter((cell) => !cell.continuation)
        .map((cell) => cellSequence(cell, row.y))
        .join('')
      if (!full && previous.get(row.y) === content) continue
      terminal.write(`\x1b[${row.y + 1};1H\x1b[0m\x1b[2K${content}`)
      previous.set(row.y, content)
    }
    const selected = source.flatMap((row) =>
      row.cells.filter((cell) => cell.selected).map((cell) => ({ x: cell.x, y: row.y })),
    )
    if (selected.length > 0) selection.selectRange(selected[0]!, selected.at(-1)!)
    if (selected.length === 0) terminal.clearSelection()
  }
  return { runtime, terminal, state, writeRows }
}

export async function attachNativeTestBuilder(
  source: RenderStateSource,
  columns: number,
  rows: number,
): Promise<void> {
  if (source.createFrameBuilder) return
  const native = await createNativeTestState(columns, rows)
  const readRows = source.readRows.bind(source)
  const update = source.update.bind(source)
  const acknowledge = source.acknowledge.bind(source)
  source.update = () => {
    native.writeRows(readRows())
    native.state.update()
    return update()
  }
  source.acknowledge = () => {
    native.state.acknowledge()
    return acknowledge()
  }
  source.createFrameBuilder = (nextColumns, nextRows) => {
    if (nextColumns !== native.terminal.size.columns || nextRows !== native.terminal.size.rows) {
      native.terminal.resize({ columns: nextColumns, rows: nextRows })
      native.writeRows(readRows(), true)
      native.state.update()
    }
    return native.state.createFrameBuilder(nextColumns, nextRows)
  }
}
