export interface TerminalAddon<TTerminal> {
  activate(terminal: TTerminal): void
  dispose(): void
}

export type AddonManagerOperation = 'dispose'

export type AddonManagerErrorSink<TTerminal> = (
  cause: unknown,
  operation: AddonManagerOperation,
  addon: TerminalAddon<TTerminal>,
) => unknown

interface LoadedAddon<TTerminal> {
  readonly addon: TerminalAddon<TTerminal>
  disposed: boolean
  readonly originalDispose: () => void
  wrapper: () => void
}

function ignoreRejection(result: unknown): void {
  if (!result || typeof (result as PromiseLike<void>).then !== 'function') return
  void Promise.resolve(result).catch(() => {})
}

function validateAddon<TTerminal>(addon: TerminalAddon<TTerminal>): void {
  if (!addon || typeof addon !== 'object') throw new TypeError('Terminal addon must be an object')
  if (typeof addon.activate !== 'function') {
    throw new TypeError('Terminal addon activate must be a function')
  }
  if (typeof addon.dispose !== 'function') {
    throw new TypeError('Terminal addon dispose must be a function')
  }
}

export class AddonManager<TTerminal> {
  private disposed = false
  private readonly loaded: LoadedAddon<TTerminal>[] = []

  constructor(
    private readonly terminal: TTerminal,
    private readonly onError: AddonManagerErrorSink<TTerminal> = () => {},
  ) {
    if (typeof onError !== 'function') {
      throw new TypeError('Addon manager error sink must be a function')
    }
  }

  get loadedCount(): number {
    return this.loaded.length
  }

  load(addon: TerminalAddon<TTerminal>): void {
    if (this.disposed) throw new Error('Addon manager is disposed')
    validateAddon(addon)
    const entry = this.createEntry(addon)
    addon.dispose = entry.wrapper
    this.loaded.push(entry)
    addon.activate(this.terminal)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const entries = [...this.loaded].reverse()
    for (const entry of entries) this.disposeOwned(entry)
  }

  private createEntry(addon: TerminalAddon<TTerminal>): LoadedAddon<TTerminal> {
    const entry: LoadedAddon<TTerminal> = {
      addon,
      disposed: false,
      originalDispose: addon.dispose,
      wrapper: () => {},
    }
    entry.wrapper = () => this.disposeEntry(entry)
    return entry
  }

  private disposeEntry(entry: LoadedAddon<TTerminal>): void {
    if (entry.disposed) return
    entry.disposed = true
    this.remove(entry)
    entry.originalDispose.call(entry.addon)
  }

  private disposeOwned(entry: LoadedAddon<TTerminal>): void {
    try {
      entry.wrapper()
    } catch (cause) {
      this.reportError(cause, 'dispose', entry.addon)
    }
  }

  private remove(entry: LoadedAddon<TTerminal>): void {
    const index = this.loaded.indexOf(entry)
    if (index < 0) return
    this.loaded.splice(index, 1)
  }

  private reportError(
    cause: unknown,
    operation: AddonManagerOperation,
    addon: TerminalAddon<TTerminal>,
  ): void {
    try {
      ignoreRejection(this.onError(cause, operation, addon))
    } catch {
      return
    }
  }
}
