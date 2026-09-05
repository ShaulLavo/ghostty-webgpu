import { expectTypeOf, test } from 'vitest'
import type {
  GhosttyWebGpuTerminalAppearanceApi,
  RendererTheme,
  RgbColor,
  TerminalAppearance,
  TerminalAppearanceOptions,
  TerminalColor,
  TerminalRendererTheme,
  TerminalTheme,
} from '../../index.js'

const background = { b: 17, g: 17, r: 17 }
const rendererTheme: RendererTheme = {
  background,
  cursor: { b: 238, g: 238, r: 238 },
  foreground: { b: 221, g: 221, r: 221 },
  minimumContrast: 1,
  selectionBackground: { b: 85, g: 68, r: 51 },
  selectionForeground: { b: 255, g: 255, r: 255 },
}
const terminalRendererTheme: TerminalRendererTheme = rendererTheme
const terminalTheme: TerminalTheme = {
  ...terminalRendererTheme,
  palette: Array.from({ length: 256 }, () => background),
}
const appearance: TerminalAppearance = {
  colorScheme: 'dark',
  cursor: { blink: false, style: 'block' },
  font: {
    boldWeight: 700,
    family: 'monospace',
    letterSpacing: 0,
    lineHeight: 1.2,
    size: 14,
    weight: 400,
  },
  grid: { cellHeight: 20, cellWidth: 10, columns: 80, pixelRatio: 1, rows: 24 },
  rendererTheme: terminalRendererTheme,
  scrollbackLimit: undefined,
  theme: terminalTheme,
}
const options: TerminalAppearanceOptions = { theme: terminalTheme }
const legacyApi: GhosttyWebGpuTerminalAppearanceApi = {
  setColorScheme() {},
  setCursor() {},
  setFont() {},
  setTheme() {},
}

test('keeps cursor text optional in every public constructible appearance shape', () => {
  expectTypeOf(rendererTheme.cursorText).toEqualTypeOf<RgbColor | undefined>()
  expectTypeOf(terminalRendererTheme.cursorText).toEqualTypeOf<TerminalColor | undefined>()
  expectTypeOf(terminalTheme.cursorText).toEqualTypeOf<TerminalColor | undefined>()
  expectTypeOf(options).toMatchTypeOf<TerminalAppearanceOptions>()
  expectTypeOf(appearance).toMatchTypeOf<TerminalAppearance>()
  expectTypeOf(legacyApi).toMatchTypeOf<GhosttyWebGpuTerminalAppearanceApi>()
})
