import type { Extension, TerminalApi, TerminalKeyInput, TerminalInputEvent } from 'ghostty-webgpu'
import { History } from './history.js'
import { keyCommand, type EditCommand, type KeyStroke } from './keymap.js'
import {
  ReadSession,
  type ReadOptions,
  type ReadResult,
  type SessionEvent,
  type SessionOptions,
} from './session.js'

const ansiEscape = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g
const textDecoder = new TextDecoder()

export type ReadlineTerminal = Pick<TerminalApi, 'geometry' | 'measureTexts' | 'write'>

export interface ReadlineOptions extends SessionOptions {
  readonly onError?: (cause: unknown, operation: string) => void
}

export interface ReadlineApi {
  readonly active: boolean
  readonly history: History
  read(options: ReadOptions): Promise<ReadResult>
  print(text: string): void
}

interface DisplayText {
  readonly content: string
  readonly visible: string
  readonly cursor: number
}

interface Position {
  readonly row: number
  readonly column: number
}

interface RenderedLine {
  readonly cursorRow: number
}

interface Prompt {
  readonly primary: string
  readonly secondary: string
}

interface RenderLayout {
  readonly cursor: Position
  readonly end: Position
}

function stripAnsi(text: string): string {
  return text.replace(ansiEscape, '')
}

function normalizedPrint(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')
  return normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`
}

function displayText(prompt: Prompt, text: string, cursor: number): DisplayText {
  const primary = prompt.primary
  const secondary = prompt.secondary
  let content = primary
  let visible = stripAnsi(primary)
  let cursorOffset = visible.length

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\n') {
      content += `\n${secondary}`
      visible += `\n${stripAnsi(secondary)}`
    } else {
      content += character
      visible += character
    }
    if (index + 1 === cursor) cursorOffset = visible.length
  }

  if (cursor === text.length) cursorOffset = visible.length
  return { content, visible, cursor: cursorOffset }
}

function advance(position: Position, cells: number, columns: number): Position {
  const total = position.column + cells
  return {
    row: position.row + Math.floor(total / columns),
    column: total % columns,
  }
}

function positionForLines(
  lines: readonly string[],
  cells: readonly number[],
  columns: number,
): Position {
  let position: Position = { row: 0, column: 0 }
  for (let index = 0; index < lines.length; index += 1) {
    position = advance(position, cells[index] ?? 0, columns)
    if (index < lines.length - 1) position = { row: position.row + 1, column: 0 }
  }
  return position
}

function layout(
  display: DisplayText,
  measurements: readonly number[],
  columns: number,
): RenderLayout {
  const lines = display.visible.split('\n')
  const cursorLines = display.visible.slice(0, display.cursor).split('\n')
  const lineCells = measurements.slice(0, lines.length)
  const cursorCells = measurements.slice(lines.length)
  return {
    cursor: positionForLines(cursorLines, cursorCells, columns),
    end: positionForLines(lines, lineCells, columns),
  }
}

function keyFromCode(code: string, text: string): string {
  const names: Readonly<Record<string, string>> = {
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    ArrowUp: 'ArrowUp',
    Backspace: 'Backspace',
    Delete: 'Delete',
    End: 'End',
    Enter: 'Enter',
    Escape: 'Escape',
    Home: 'Home',
    NumpadEnter: 'Enter',
    Tab: 'Tab',
  }
  const named = names[code]
  if (named) return named
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toLowerCase()
  return text || code
}

function modifiers(input: TerminalKeyInput) {
  const active = input.modifiers
  return {
    ctrl: active?.control !== undefined,
    alt: active?.alt !== undefined,
    shift: active?.shift !== undefined,
    meta: active?.super !== undefined,
  }
}

function commandFromInput(event: TerminalInputEvent): EditCommand | undefined {
  if (event.type === 'key' && 'event' in event) {
    if (event.event.type === 'keyup') return undefined
    const stroke: KeyStroke = {
      key: event.event.key,
      ctrl: event.event.ctrlKey,
      alt: event.event.altKey,
      shift: event.event.shiftKey,
      meta: event.event.metaKey,
    }
    return keyCommand(stroke)
  }
  if (event.type === 'key') {
    if (event.input.action === 'release') return undefined
    return keyCommand({
      key: keyFromCode(event.input.code, event.input.text),
      ...modifiers(event.input),
    })
  }
  if (event.type === 'composition') return { kind: 'insert', text: event.text }
  return {
    kind: 'insert',
    text: typeof event.data === 'string' ? event.data : textDecoder.decode(event.data),
  }
}

function movement(end: Position, cursor: Position): string {
  const up = end.row - cursor.row
  const moveUp = up > 0 ? `\u001b[${up}A` : ''
  return `${moveUp}\u001b[${cursor.column + 1}G`
}

export class ReadlineRenderer {
  private queue = Promise.resolve()
  private rendered: RenderedLine | undefined
  private prompt: Prompt | undefined
  private disposed = false

  constructor(
    private readonly terminal: ReadlineTerminal,
    private readonly session: ReadSession,
    private readonly onError: ReadlineOptions['onError'],
  ) {}

  handle(event: SessionEvent): void {
    if (this.disposed) return
    if (event.kind === 'change') {
      this.enqueue(() => this.render())
      return
    }
    if (event.kind === 'clear') {
      this.enqueue(() => this.clearScreen())
      return
    }
    if (event.kind === 'output') {
      this.enqueue(() => this.printNow(event.text))
      return
    }
    if (event.kind === 'candidates') {
      this.enqueue(() => this.printNow(`${event.values.join('\r\n')}\r\n`))
    }
  }

  finish(result: ReadResult): void {
    if (this.disposed) return
    this.enqueue(async () => {
      if (result.kind === 'submit' && this.prompt) {
        const display = displayText(this.prompt, result.text, result.text.length)
        await this.write(`${this.clearPrefix()}${display.content}\r\n`)
      } else if (result.kind === 'end') {
        await this.write(`${this.clearPrefix()}\r\n`)
      } else {
        await this.write(this.clearPrefix())
      }
      this.rendered = undefined
      this.prompt = undefined
    })
  }

  print(text: string): void {
    if (this.disposed) return
    this.enqueue(() => this.printNow(text))
  }

  dispose(): void {
    this.disposed = true
    this.rendered = undefined
    this.prompt = undefined
  }

  private enqueue(task: () => Promise<void>): void {
    const next = this.queue.then(task)
    this.queue = next.catch((cause: unknown) => this.onError?.(cause, 'readline.render'))
  }

  private async render(): Promise<void> {
    const prompt = this.session.prompt
    if (!prompt) return
    this.prompt = prompt
    const snapshot = this.session.model.snapshot
    const display = displayText(prompt, snapshot.text, snapshot.cursor)
    const lines = display.visible.split('\n')
    const cursorLines = display.visible.slice(0, display.cursor).split('\n')
    const measurements = await this.terminal.measureTexts(lines.concat(cursorLines))
    const columns = Math.max(1, measurements.geometry.columns)
    const layoutValue = layout(
      display,
      measurements.texts.map((value) => value.cells),
      columns,
    )
    await this.write(
      `${this.clearPrefix()}${display.content}${movement(layoutValue.end, layoutValue.cursor)}`,
    )
    this.rendered = { cursorRow: layoutValue.cursor.row }
  }

  private async clearScreen(): Promise<void> {
    await this.write(`${this.clearPrefix()}\u001b[2J\u001b[H`)
    this.rendered = undefined
    await this.render()
  }

  private async printNow(text: string): Promise<void> {
    await this.write(`${this.clearPrefix()}${normalizedPrint(text)}`)
    this.rendered = undefined
    await this.render()
  }

  private clearPrefix(): string {
    const rendered = this.rendered
    if (!rendered) return ''
    const up = rendered.cursorRow > 0 ? `\u001b[${rendered.cursorRow}A` : ''
    return `${up}\r\u001b[J`
  }

  private async write(text: string): Promise<void> {
    await Promise.resolve(this.terminal.write(text))
  }
}

export function readline(options: ReadlineOptions = {}): Extension<ReadlineApi> {
  return {
    name: 'readline',
    setup(scope) {
      let renderer: ReadlineRenderer | undefined
      const session = new ReadSession(options, (event) => renderer?.handle(event))
      renderer = new ReadlineRenderer(scope.terminal, session, options.onError)
      scope.own(() => {
        renderer?.dispose()
        session.dispose()
      })

      const api: ReadlineApi = {
        get active() {
          return session.active
        },
        get history() {
          return session.model.history
        },
        read(readOptions) {
          const pending = session.read(readOptions)
          void pending.then(
            (result) => renderer?.finish(result),
            () => {
              if (!session.active) renderer?.finish({ kind: 'interrupt' })
            },
          )
          return pending
        },
        print(text) {
          renderer?.print(text)
        },
      }

      return {
        api,
        input: (event) => {
          if (!session.active) return 'pass'
          const command = commandFromInput(event)
          if (!command) return 'pass'
          void session
            .dispatch(command)
            .catch((cause: unknown) => options.onError?.(cause, 'readline.input'))
          return 'claim'
        },
      }
    },
  }
}
