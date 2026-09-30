import { FormatterFormat } from './abi.js'
import { createGhosttyError } from './error.js'
import { requireLayout } from './memory.js'
import { readNativeBuffer } from './native-buffer.js'
import type { GhosttyTerminal } from './terminal.js'
import type { TerminalSelectionFormatOptions } from './types.js'

const decoder = new TextDecoder()

function nativeFormatterFormat(format: TerminalSelectionFormatOptions['format']): FormatterFormat {
  switch (format) {
    case undefined:
    case 'plain':
      return FormatterFormat.Plain
    case 'vt':
      return FormatterFormat.Vt
    case 'html':
      return FormatterFormat.Html
    default:
      throw createGhosttyError('terminal.getSelection', `Unknown format: ${String(format)}`)
  }
}

// A nonzero selection is a borrowed range snapshot; zero formats the installed selection.
export function readSelectionText(
  terminal: GhosttyTerminal,
  options: TerminalSelectionFormatOptions,
  selection = 0,
): string | undefined {
  const { memory, layouts, exports } = terminal.runtime
  const layout = requireLayout(layouts, 'GhosttyTerminalSelectionFormatOptions')
  const pointer = memory.allocate(layout.size)
  try {
    memory.view.setUint32(pointer + layout.fields.size!.offset, layout.size, true)
    memory.view.setInt32(
      pointer + layout.fields.emit!.offset,
      nativeFormatterFormat(options.format),
      true,
    )
    memory.view.setUint8(pointer + layout.fields.unwrap!.offset, Number(options.unwrap ?? true))
    memory.view.setUint8(pointer + layout.fields.trim!.offset, Number(options.trim ?? true))
    memory.view.setUint32(pointer + layout.fields.selection!.offset, selection, true)
    const bytes = readNativeBuffer(
      terminal.runtime,
      'ghostty_terminal_selection_format_buf',
      (buffer, length, out) =>
        exports.ghostty_terminal_selection_format_buf(
          terminal.handle,
          pointer,
          buffer,
          length,
          out,
        ),
    )
    if (!bytes) return undefined
    return decoder.decode(bytes)
  } finally {
    memory.free(pointer, layout.size)
  }
}
