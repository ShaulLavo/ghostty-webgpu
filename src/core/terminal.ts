import { TerminalData } from './abi.js'
import { assertGhosttyResult, createGhosttyError } from './error.js'
import type { GhosttyRuntime } from './runtime.js'
import type { TerminalEffects, TerminalOptions, TerminalSize } from './types.js'

const defaultSize: TerminalSize = {
  cellHeight: 16,
  cellWidth: 8,
  columns: 80,
  rows: 24,
}

function validateDimension(name: string, value: number, maximum: number): number {
  if (Number.isInteger(value) && value > 0 && value <= maximum) return value
  throw createGhosttyError('terminal.new', `${name} must be an integer between 1 and ${maximum}`)
}

function normalizeSize(options: TerminalOptions): TerminalSize {
  return {
    cellHeight: validateDimension(
      'cellHeight',
      options.cellHeight ?? defaultSize.cellHeight,
      0xffffffff,
    ),
    cellWidth: validateDimension(
      'cellWidth',
      options.cellWidth ?? defaultSize.cellWidth,
      0xffffffff,
    ),
    columns: validateDimension('columns', options.columns ?? defaultSize.columns, 0xffff),
    rows: validateDimension('rows', options.rows ?? defaultSize.rows, 0xffff),
  }
}

export class GhosttyTerminal {
  readonly runtime: GhosttyRuntime
  private readonly effects: TerminalEffects
  private disposed = false
  private handleValue: number
  private sizeValue: TerminalSize

  constructor(runtime: GhosttyRuntime, options: TerminalOptions) {
    this.runtime = runtime
    this.effects = options.effects ?? {}
    this.sizeValue = normalizeSize(options)
    this.handleValue = this.createHandle()
    try {
      this.runtime.bridge.registerTerminal(this.handleValue, this.effects, this.sizeValue)
      this.resize(this.sizeValue)
    } catch (cause) {
      this.runtime.bridge.unregisterTerminal(this.handleValue)
      this.runtime.exports.ghostty_terminal_free(this.handleValue)
      throw cause
    }
  }

  get handle(): number {
    this.ensureActive()
    return this.handleValue
  }

  get size(): TerminalSize {
    return { ...this.sizeValue }
  }

  get title(): string {
    this.ensureActive()
    const pointer = this.runtime.memory.allocate(8)
    try {
      assertGhosttyResult(
        'ghostty_terminal_get(TITLE)',
        this.runtime.exports.ghostty_terminal_get(this.handleValue, TerminalData.Title, pointer),
      )
      return this.runtime.memory.readString(pointer)
    } finally {
      this.runtime.memory.free(pointer, 8)
    }
  }

  write(value: string | Uint8Array): void {
    this.ensureActive()
    const input = this.runtime.memory.allocateBytes(value)
    try {
      this.runtime.exports.ghostty_terminal_vt_write(this.handleValue, input.pointer, input.length)
    } finally {
      this.runtime.memory.freeBytes(input)
    }
  }

  resize(size: Partial<TerminalSize>): void {
    this.ensureActive()
    const next = normalizeSize({ ...this.sizeValue, ...size })
    assertGhosttyResult(
      'ghostty_terminal_resize',
      this.runtime.exports.ghostty_terminal_resize(
        this.handleValue,
        next.columns,
        next.rows,
        next.cellWidth,
        next.cellHeight,
      ),
    )
    this.sizeValue = next
    this.runtime.bridge.updateTerminalSize(this.handleValue, next)
  }

  reset(): void {
    this.ensureActive()
    this.runtime.exports.ghostty_terminal_reset(this.handleValue)
  }

  dispose(): void {
    if (this.disposed) return
    this.runtime.bridge.unregisterTerminal(this.handleValue)
    this.runtime.exports.ghostty_terminal_free(this.handleValue)
    this.runtime.releaseTerminal(this)
    this.disposed = true
    this.handleValue = 0
  }

  private createHandle(): number {
    const out = this.runtime.memory.allocateOpaque()
    try {
      assertGhosttyResult(
        'ghostty_terminal_new',
        this.runtime.exports.ghostty_terminal_new(
          0,
          out,
          this.sizeValue.columns,
          this.sizeValue.rows,
        ),
      )
      const handle = this.runtime.memory.readHandle(out)
      if (handle !== 0) return handle
      throw createGhosttyError(
        'ghostty_terminal_new',
        'libghostty-vt returned a null terminal handle',
      )
    } finally {
      this.runtime.memory.freeOpaque(out)
    }
  }

  private ensureActive(): void {
    this.runtime.ensureActive()
    if (!this.disposed) return
    throw createGhosttyError('terminal', 'The terminal has been disposed')
  }
}
