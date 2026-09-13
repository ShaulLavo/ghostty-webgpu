import { clearScreen, CSI, fg, reset, showCursor } from '../ansi.js'
import { frameToLines, loadGhostFrames, type GhostFrames } from '../ghost-frames.js'
import { dusk, pale, spectre } from '../theme.js'
import type { Demo, DemoContext } from './types.js'

const decoder = new TextDecoder()
// A full-ghost pose from the real animation, shown verbatim in `about`.
const ABOUT_FRAME = 116
const PROMPT = `${fg(spectre)}ghost${reset} ${fg(dusk)}›${reset} `
const PROMPT_WIDTH = 8

type Command = (args: string, shell: ShellDemo) => string[]

const commands: Record<string, Command> = {
  about: (_args, shell) => shell.about(),
  boo: () => [`${fg(pale)}👻  boo.${reset}`],
  clear: () => [],
  date: () => [new Date().toString()],
  echo: (args) => [args],
  exit: () => [`${fg(dusk)}There is no leaving. Try another tab.${reset}`],
  help: () => [
    `${fg(dusk)}This shell lives in the page. Nothing here reaches a real machine.${reset}`,
    '',
    `  ${fg(pale)}about${reset}    what is rendering this, and how`,
    `  ${fg(pale)}echo${reset}     print the rest of the line`,
    `  ${fg(pale)}date${reset}     the current time`,
    `  ${fg(pale)}clear${reset}    empty the screen`,
    `  ${fg(pale)}boo${reset}      say boo`,
    `  ${fg(pale)}whoami${reset}   who you are here`,
    '',
    `${fg(dusk)}Up and down recall history. Ctrl+L clears. Ctrl+C abandons the line.${reset}`,
  ],
  uname: (_args, shell) => [
    `ghostty-webgpu ${shell.info().version} wasm32 ${shell.info().backend}`,
  ],
  whoami: () => ['ghost'],
}

export class ShellDemo implements Demo {
  readonly id = 'shell'
  readonly label = 'Shell'
  readonly caption =
    'A small shell that lives in the page. Click the terminal, type help, and press Enter. Input travels the same byte path a real PTY would use.'
  readonly animated = false
  private context: DemoContext | undefined
  private line = ''
  private history: string[] = []
  private historyIndex = 0
  private escape = ''
  private ghost: GhostFrames | undefined

  start(context: DemoContext): void {
    this.context = context
    this.line = ''
    this.escape = ''
    loadGhostFrames()
      .then((frames) => {
        this.ghost = frames
      })
      .catch(() => undefined)
    context.write(clearScreen + showCursor)
    this.print([
      `${fg(pale)}ghostty-webgpu ${context.info().version}${reset} ${fg(dusk)}rendering with ${context.info().backend}${reset}`,
      `${fg(dusk)}Type ${reset}help${fg(dusk)} to see what this shell can do.${reset}`,
      '',
    ])
    this.prompt()
  }

  stop(): void {
    this.context = undefined
  }

  resize(): void {}

  setPaused(): void {}

  info() {
    return this.context!.info()
  }

  input(bytes: Uint8Array): void {
    const text = decoder.decode(bytes)
    for (const char of text) this.key(char)
  }

  about(): string[] {
    const context = this.context!
    const { cols, rows } = context.grid()
    const info = context.info()
    const facts = [
      `${fg(spectre)}ghost${reset}@${fg(spectre)}ghostty-webgpu${reset}`,
      `${fg(dusk)}${'-'.repeat(20)}${reset}`,
      `${fg(pale)}Package${reset}   ghostty-webgpu ${info.version}`,
      `${fg(pale)}Parser${reset}    libghostty-vt ${info.revision.slice(0, 7)}`,
      `${fg(pale)}Renderer${reset}  ${info.backend}`,
      `${fg(pale)}Grid${reset}      ${cols} columns by ${rows} rows`,
      `${fg(pale)}Font${reset}      ${info.fontFamily}`,
      `${fg(pale)}Input${reset}     bytes over onData, no PTY here`,
      `${fg(pale)}License${reset}   MIT`,
    ]
    if (!this.ghost) return facts
    const art = frameToLines(this.ghost, ABOUT_FRAME)
    // Center the facts vertically against the ghost so they land beside it.
    const factTop = Math.max(0, Math.floor((art.length - facts.length) / 2))
    const blank = ' '.repeat(this.ghost.width)
    return art.map((line, i) => {
      const fact = facts[i - factTop]
      return fact ? `${line}   ${fact}` : line || blank
    })
  }

  private key(char: string): void {
    if (this.escape !== '') {
      this.escape += char
      this.finishEscape()
      return
    }
    if (char === '\x1b') {
      this.escape = char
      return
    }
    if (char === '\r' || char === '\n') {
      this.submit()
      return
    }
    if (char === '\x7f' || char === '\b') {
      this.backspace()
      return
    }
    if (char === '\x03') {
      this.write('^C\r\n')
      this.line = ''
      this.prompt()
      return
    }
    if (char === '\x0c') {
      this.write(clearScreen)
      this.prompt()
      this.write(this.line)
      return
    }
    if (char < ' ') return
    this.line += char
    this.write(char)
  }

  private finishEscape(): void {
    const sequence = this.escape
    if (sequence.length < 3) return
    this.escape = ''
    if (sequence === `${CSI}A`) this.recall(-1)
    if (sequence === `${CSI}B`) this.recall(1)
  }

  private recall(direction: number): void {
    const next = this.historyIndex + direction
    if (next < 0 || next > this.history.length) return
    this.historyIndex = next
    const replacement = this.history[next] ?? ''
    this.write(`\r${CSI}K`)
    this.prompt()
    this.line = replacement
    this.write(replacement)
  }

  private backspace(): void {
    if (this.line.length === 0) return
    const chars = [...this.line]
    chars.pop()
    this.line = chars.join('')
    this.write('\b \b')
  }

  private submit(): void {
    const input = this.line.trim()
    this.line = ''
    this.write('\r\n')
    if (input === '') {
      this.prompt()
      return
    }
    this.history.push(input)
    this.historyIndex = this.history.length
    const [name = '', ...rest] = input.split(/\s+/)
    const command = commands[name]
    if (!command) {
      this.print([`${fg(dusk)}${name}: not found. Type ${reset}help${fg(dusk)}.${reset}`])
      this.prompt()
      return
    }
    if (name === 'clear') {
      this.write(clearScreen)
      this.prompt()
      return
    }
    this.print(command(rest.join(' '), this))
    this.prompt()
  }

  private prompt(): void {
    this.write(PROMPT)
  }

  private print(lines: string[]): void {
    if (lines.length === 0) return
    this.write(`${lines.join('\r\n')}\r\n`)
  }

  private write(data: string): void {
    this.context?.write(data)
  }
}

export { PROMPT_WIDTH }
