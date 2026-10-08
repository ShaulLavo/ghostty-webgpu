import type { Terminal } from 'ghostty-webgpu'

export function applyTheme(terminal: Terminal) {
  terminal.setTheme({
    ...terminal.appearance.theme,
    background: { r: 21, g: 19, b: 31 },
    foreground: { r: 230, g: 226, b: 247 },
    cursor: { r: 126, g: 230, b: 206 },
    selectionBackground: { r: 62, g: 58, b: 92 },
    selectionForeground: { r: 230, g: 226, b: 247 },
  })
}
