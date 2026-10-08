import type { Terminal } from 'ghostty-webgpu'

export function readHistory(terminal: Terminal) {
  const count = terminal.lineCount()
  const lines = terminal.readLines(Math.max(0, count - 100), count, { trimRight: true })
  return lines.map((line) => line.text).join('\n')
}
