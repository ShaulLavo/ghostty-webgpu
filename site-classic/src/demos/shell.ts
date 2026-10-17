import type { Bash } from 'just-bash/browser'
import { clearScreen, fg, reset, showCursor } from '../ansi.js'
import { dusk, pale, spectre } from '../theme.js'
import { shellFiles } from './shell-files.js'
import type { Demo, DemoContext } from './types.js'

const ESC = '\x1b'
const CSI = `${ESC}[`
const HOME = '/home/ghost'
const BENCH_CHUNK_BYTES = 64 * 1024
const decoder = new TextDecoder()
const encoder = new TextEncoder()
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

function isFinalByte(char: string, length: number): boolean {
  if (length < 3) return false
  const code = char.charCodeAt(0)
  return code >= 0x40 && code <= 0x7e
}

function crlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

function benchLine(index: number): string {
  const ms = (index * 7919) % 997
  const level = index % 11 === 0 ? `${CSI}33mwarn${CSI}0m` : `${CSI}32minfo${CSI}0m`
  return `${CSI}2m${String(index).padStart(7, '0')}${CSI}0m ${level} request ${index} served in ${ms} ms\r\n`
}

export class ShellDemo implements Demo {
  readonly id = 'shell'
  readonly label = 'Shell'
  readonly caption =
    'A real bash, compiled to JavaScript by just-bash, running in this tab. Try ls, cat README.md, or bench 20.'
  readonly animated = false

  private context: DemoContext | undefined
  private bash: Bash | undefined
  private loading: Promise<Bash> | undefined
  private env: Record<string, string> = {}
  private line = ''
  private escape = ''
  private history: string[] = []
  private historyIndex = 0
  private busy = false
  /** Typed or pasted text not yet handled; drained one command at a time. */
  private pending = ''

  start(context: DemoContext): void {
    this.context = context
    this.line = ''
    this.escape = ''
    this.pending = ''
    context.stat('')
    context.write(clearScreen + showCursor)
    if (this.bash) {
      this.busy = false
      this.greet()
      return
    }
    this.busy = true
    context.write(`${fg(dusk)}Loading bash…${reset}`)
    this.load()
      .then(() => {
        // A later start() greets for itself once bash is here.
        if (this.context !== context) return
        this.busy = false
        context.write(`\r${CSI}K`)
        this.greet()
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        context.write(`\r${CSI}K${fg(dusk)}bash did not load. ${message}${reset}\r\n`)
      })
  }

  stop(): void {
    this.context = undefined
  }

  resize(): void {}

  setPaused(): void {}

  input(bytes: Uint8Array): void {
    this.pending += decoder.decode(bytes, { stream: true })
    this.drain()
  }

  private drain(): void {
    while (this.pending !== '' && !this.busy) {
      const [char = ''] = this.pending
      this.pending = this.pending.slice(char.length)
      this.key(char)
    }
  }

  private load(): Promise<Bash> {
    this.loading ??= import('just-bash/browser').then(({ Bash, defineCommand }) => {
      const bench = defineCommand('bench', async (args) => this.bench(args[0]))
      this.bash = new Bash({
        customCommands: [bench],
        cwd: HOME,
        env: { HOME, PS1: '$ ', USER: 'ghost' },
        files: shellFiles(HOME),
      })
      return this.bash
    })
    return this.loading
  }

  private greet(): void {
    this.print(
      `${fg(pale)}bash${reset} ${fg(dusk)}in your browser tab. Nothing leaves this page.${reset}\r\n` +
        `${fg(dusk)}Try${reset} ls${fg(dusk)},${reset} cat README.md${fg(dusk)},${reset} seq 1 50000${fg(dusk)}, or${reset} bench 20${fg(dusk)}.${reset}\r\n\r\n`,
    )
    this.prompt()
  }

  /** Streams generated log lines straight into the terminal and times the parse. */
  private async bench(sizeArg: string | undefined) {
    const megabytes = Math.min(200, Math.max(1, Number(sizeArg) || 10))
    const target = megabytes * 1_000_000
    let chunk = ''
    let bytes = 0
    let index = 0
    let elapsed = 0
    while (bytes < target) {
      chunk += benchLine(index)
      index += 1
      if (chunk.length < BENCH_CHUNK_BYTES) continue
      const data = encoder.encode(chunk)
      const started = performance.now()
      this.context?.writeBytes(data)
      elapsed += performance.now() - started
      bytes += data.length
      chunk = ''
    }
    const rate = bytes / 1_000_000 / (elapsed / 1000)
    const summary =
      `${fg(spectre)}${numberFormat.format(bytes / 1_000_000)} MB${reset} in ` +
      `${numberFormat.format(elapsed)} ms, ${fg(spectre)}${numberFormat.format(rate)} MB/s${reset}\n`
    return { exitCode: 0, stderr: '', stdout: summary }
  }

  private key(char: string): void {
    if (this.escape !== '') {
      this.escape += char
      this.finishEscape()
      return
    }
    if (char === ESC) {
      this.escape = char
      return
    }
    if (char === '\r' || char === '\n') {
      void this.submit()
      return
    }
    if (char === '\x7f' || char === '\b') {
      this.backspace()
      return
    }
    if (char === '\x03') {
      this.print('^C\r\n')
      this.line = ''
      this.prompt()
      return
    }
    if (char === '\x0c') {
      this.print(clearScreen)
      this.prompt()
      this.print(this.line)
      return
    }
    if (char < ' ') return
    this.line += char
    this.print(char)
  }

  /** Waits for the whole sequence so a key like Delete (ESC [ 3 ~) leaves nothing behind. */
  private finishEscape(): void {
    const sequence = this.escape
    if (sequence.length < 2) return
    const kind = sequence[1]
    if (kind === '[' && !isFinalByte(sequence.at(-1)!, sequence.length)) return
    if (kind === 'O' && sequence.length < 3) return
    this.escape = ''
    if (sequence === `${CSI}A`) this.recall(-1)
    if (sequence === `${CSI}B`) this.recall(1)
  }

  private recall(direction: number): void {
    const next = this.historyIndex + direction
    if (next < 0 || next > this.history.length) return
    this.historyIndex = next
    this.line = this.history[next] ?? ''
    this.print(`\r${CSI}K`)
    this.prompt()
    this.print(this.line)
  }

  private backspace(): void {
    if (this.line.length === 0) return
    this.line = [...this.line].slice(0, -1).join('')
    this.print('\b \b')
  }

  private async submit(): Promise<void> {
    const input = this.line
    this.line = ''
    this.print('\r\n')
    if (input.trim() === '' || !this.bash) {
      this.prompt()
      return
    }
    this.history.push(input)
    this.historyIndex = this.history.length
    if (input.trim() === 'clear') {
      this.print(clearScreen)
      this.prompt()
      return
    }
    this.busy = true
    const result = await this.run(input)
    this.print(crlf(result.stdout))
    if (result.stderr !== '') this.print(`${fg(dusk)}${crlf(result.stderr)}${reset}`)
    this.prompt()
    this.busy = false
    this.drain()
  }

  private async run(input: string): Promise<{ stderr: string; stdout: string }> {
    try {
      const result = await this.bash!.exec(input, { cwd: this.env['PWD'], env: this.env })
      // Each exec starts fresh; carrying the environment keeps cd and exports.
      this.env = result.env
      return result
    } catch (cause) {
      return { stderr: `${cause instanceof Error ? cause.message : String(cause)}\n`, stdout: '' }
    }
  }

  private prompt(): void {
    const cwd = this.env['PWD'] ?? HOME
    const path = cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd
    this.print(`${fg(spectre)}ghost${reset}:${fg(pale)}${path}${reset}${fg(dusk)}$${reset} `)
  }

  private print(data: string): void {
    this.context?.write(data)
  }
}
