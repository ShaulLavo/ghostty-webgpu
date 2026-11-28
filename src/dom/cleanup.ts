export type Cleanup = () => void

export function invokeCleanup(cleanup: Cleanup, onError: (cause: unknown) => void): void {
  try {
    cleanup()
  } catch (cause) {
    onError(cause)
  }
}

export class CleanupStack {
  private disposed = false
  private readonly entries: Cleanup[] = []

  add(cleanup: Cleanup): void {
    if (this.disposed) throw new Error('Cleanup stack is disposed')
    this.entries.push(cleanup)
  }

  dispose(onError: (cause: unknown) => void): void {
    if (this.disposed) return
    this.disposed = true
    while (this.entries.length > 0) {
      const cleanup = this.entries.pop()
      if (!cleanup) continue
      invokeCleanup(cleanup, onError)
    }
  }
}
