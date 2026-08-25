export interface TerminalAddon<TTerminal> {
  activate(terminal: TTerminal): void
  dispose(): void
}

interface LoadedAddon<TTerminal> {
  readonly addon: TerminalAddon<TTerminal>
  disposed: boolean
  readonly originalDispose: () => void
  wrapper: () => void
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
  private readonly loaded: LoadedAddon<TTerminal>[] = []

  constructor(private readonly terminal: TTerminal) {}

  get loadedCount(): number {
    return this.loaded.length
  }

  load(addon: TerminalAddon<TTerminal>): void {
    validateAddon(addon)
    const entry = this.createEntry(addon)
    this.loaded.push(entry)
    addon.dispose = entry.wrapper
    addon.activate(this.terminal)
  }

  dispose(): void {
    const entries = [...this.loaded].reverse()
    for (const entry of entries) entry.addon.dispose()
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
    entry.originalDispose.call(entry.addon)
    this.remove(entry)
  }

  private remove(entry: LoadedAddon<TTerminal>): void {
    const index = this.loaded.indexOf(entry)
    if (index < 0) return
    this.loaded.splice(index, 1)
  }
}
