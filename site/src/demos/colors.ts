import { bg, clearScreen, CSI, fg, hideCursor, mix, reset, rgb, type Rgb } from '../ansi.js'
import { dusk, ink, pale, spectre } from '../theme.js'
import type { Demo, DemoContext } from './types.js'

function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) }
}

function heading(text: string): string {
  return `${fg(dusk)}${text}${reset}`
}

function ramp(width: number, at: (t: number) => Rgb): string {
  let line = ''
  for (let i = 0; i < width; i += 1) {
    line += `${bg(at(i / Math.max(1, width - 1)))} `
  }
  return line + reset
}

function ansiRow(offset: number): string {
  let line = ''
  for (let i = 0; i < 8; i += 1) {
    line += `${CSI}48;5;${offset + i}m  `
  }
  return line + reset
}

function cubeRows(width: number): string[] {
  // Two colors per cell: upper half block shows one, background shows the next.
  const perRow = Math.max(6, Math.min(36, Math.floor((width - 2) / 3) * 3))
  const rows: string[] = []
  for (let start = 16; start < 232; start += perRow * 2) {
    let line = ''
    for (let i = 0; i < perRow && start + i < 232; i += 1) {
      const top = start + i
      const bottom = start + i + perRow
      line += bottom < 232 ? `${CSI}38;5;${top}m${CSI}48;5;${bottom}m▀` : `${CSI}38;5;${top}m▀`
    }
    rows.push(line + reset)
  }
  return rows
}

function grayRow(): string {
  let line = ''
  for (let i = 232; i < 256; i += 1) line += `${CSI}48;5;${i}m `
  return line + reset
}

function styles(): string[] {
  const u = (kind: number, text: string) => `${CSI}4:${kind}m${text}${CSI}4:0m`
  const link = `${'\x1b]8;;https://github.com/ShaulLavo/ghostty-webgpu\x1b\\'}ghostty-webgpu on GitHub\x1b]8;;\x1b\\`
  return [
    `${CSI}1mbold${reset}  ${CSI}2mdim${reset}  ${CSI}3mitalic${reset}  ${CSI}1;3mbold italic${reset}  ${CSI}9mstruck${reset}  ${CSI}7m inverse ${reset}`,
    `${u(1, 'underline')}  ${u(2, 'double')}  ${fg(spectre)}${u(3, 'curly')}${reset}  ${u(4, 'dotted')}  ${u(5, 'dashed')}  ${CSI}58;2;240;124;140m${u(3, 'colored')}${reset}`,
    `${fg(spectre)}${link}${reset}  ${fg(pale)}漢字 ひらがな 한글${reset}  ${fg(pale)}👻 🎃 🪐${reset}  ${fg(dusk)}λ → ∞ ≠ ∑${reset}`,
  ]
}

export class ColorsDemo implements Demo {
  readonly id = 'colors'
  readonly label = 'Colors'
  readonly caption =
    'Sixteen named colors, the 256-color cube, three truecolor ramps, and every text style ghostty knows, including curly underlines and OSC 8 links.'
  readonly animated = false
  private context: DemoContext | undefined

  start(context: DemoContext): void {
    this.context = context
    this.render()
  }

  stop(): void {
    this.context = undefined
  }

  resize(): void {
    this.render()
  }

  setPaused(): void {}

  private render(): void {
    const context = this.context
    if (!context) return
    const { cols, rows } = context.grid()
    const width = Math.max(8, Math.min(cols - 4, 72))
    const lines: string[] = []
    lines.push(heading('16 colors'))
    lines.push(ansiRow(0))
    lines.push(ansiRow(8))
    lines.push('')
    lines.push(heading('256 colors'))
    lines.push(...cubeRows(width))
    lines.push(grayRow())
    lines.push('')
    lines.push(heading('truecolor'))
    lines.push(ramp(width, (t) => hsl(t * 300 + 20, 0.72, 0.62)))
    lines.push(ramp(width, (t) => mix(ink, spectre, t)))
    lines.push(ramp(width, (t) => mix(rgb('#F07C8C'), rgb('#F2CF87'), t)))
    lines.push('')
    lines.push(heading('styles'))
    lines.push(...styles())

    const output = lines.slice(0, Math.max(1, rows - 1)).map((line) => `  ${line}`)
    context.write(clearScreen + hideCursor + output.join('\r\n'))
  }
}
