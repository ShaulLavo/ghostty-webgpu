import type { Bash } from 'just-bash/browser'
import { readline, type ReadlineApi } from 'ghostty-webgpu-line-editor'
import { clearScreen, fg, reset, showCursor } from '../ansi.js'
import { dusk, pale, spectre } from '../theme.js'
import { shellFiles } from './shell-files.js'
import type { Demo, DemoContext } from './types.js'

const HOME = '/home/ghost'
const BENCH_CHUNK_BYTES = 64 * 1024
const encoder = new TextEncoder()
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

function crlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

function benchLine(index: number): string {
  const level = index % 11 === 0 ? '\u001b[33mwarn\u001b[0m' : '\u001b[32minfo\u001b[0m'
  const ms = (index * 7919) % 997
  return `\u001b[2m${String(index).padStart(7, '0')}\u001b[0m ${level} request ${index} served in ${ms} ms\r\n`
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
  private editor: ReadlineApi | undefined
  private editorHandle: { readonly api: ReadlineApi; dispose(): void } | undefined
  private env: Record<string, string> = {}
  private busy = false

  start(context: DemoContext): void {
    this.context = context
    context.stat('')
    context.write(clearScreen + showCursor)
    this.editorHandle = context.terminal.use(
      readline({
        onError: (cause) =>
          context.write(`${fg(dusk)}line editor error: ${String(cause)}${reset}\r\n`),
      }),
    )
    this.editor = this.editorHandle.api
    if (this.bash) {
      this.busy = false
      void this.greet()
      return
    }
    this.busy = true
    context.write(`${fg(dusk)}Loading bash…${reset}`)
    this.load()
      .then(() => {
        if (this.context !== context) return
        this.busy = false
        context.write('\r\u001b[K')
        void this.greet()
      })
      .catch((cause: unknown) => {
        if (this.context !== context) return
        const message = cause instanceof Error ? cause.message : String(cause)
        context.write(`\r\u001b[K${fg(dusk)}bash did not load. ${message}${reset}\r\n`)
      })
  }

  stop(): void {
    this.editorHandle?.dispose()
    this.editorHandle = undefined
    this.editor = undefined
    this.context = undefined
    this.busy = false
  }

  resize(): void {}

  setPaused(): void {}

  input(): void {}

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

  private async greet(): Promise<void> {
    const editor = this.editor
    if (!editor) return
    editor.print(
      `${fg(pale)}bash${reset} ${fg(dusk)}in your browser tab. Nothing leaves this page.${reset}\r\n` +
        `${fg(dusk)}Try${reset} ls${fg(dusk)},${reset} cat README.md${fg(dusk)},${reset} seq 1 50000${fg(dusk)}, or${reset} bench 20${fg(dusk)}.${reset}\r\n\r\n`,
    )
    await this.readPrompt()
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

  private async readPrompt(): Promise<void> {
    const editor = this.editor
    if (!editor || !this.bash || this.busy) return
    const result = await editor.read({ prompt: this.prompt() }).catch(() => undefined)
    if (!result) return
    if (result.kind !== 'submit') {
      await this.readPrompt()
      return
    }
    const input = result.text
    if (input.trim() === '') {
      await this.readPrompt()
      return
    }
    if (input.trim() === 'clear') {
      editor.print(clearScreen)
      await this.readPrompt()
      return
    }
    this.busy = true
    const output = await this.run(input)
    if (output.stdout !== '') editor.print(crlf(output.stdout))
    if (output.stderr !== '') editor.print(`${fg(dusk)}${crlf(output.stderr)}${reset}`)
    this.busy = false
    await this.readPrompt()
  }

  private async run(input: string): Promise<{ stderr: string; stdout: string }> {
    try {
      const result = await this.bash!.exec(input, { cwd: this.env['PWD'], env: this.env })
      this.env = result.env
      return result
    } catch (cause) {
      return { stderr: `${cause instanceof Error ? cause.message : String(cause)}\n`, stdout: '' }
    }
  }

  private prompt(): string {
    const cwd = this.env['PWD'] ?? HOME
    const path = cwd.startsWith(HOME) ? `~${cwd.slice(HOME.length)}` : cwd
    return `${fg(spectre)}ghost${reset}:${fg(pale)}${path}${reset}${fg(dusk)}$${reset} `
  }
}
