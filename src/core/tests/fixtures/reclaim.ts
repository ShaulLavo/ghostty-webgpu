import { GhosttyRuntime } from '../../runtime.js'
import { TerminalSession } from '../../../term/session.js'

const pause = () => new Promise((resolve) => setTimeout(resolve, 10))
const finalized = new Set<string>()
const finalization = new FinalizationRegistry<string>((label) => finalized.add(label))

async function collectMemories(expected: number): Promise<void> {
  // A full GC can finish before weak targets are swept and finalizers run.
  const deadline = performance.now() + 10_000
  while (finalized.size < expected) {
    if (performance.now() >= deadline) {
      throw new Error(`Only ${finalized.size} of ${expected} WASM memories were finalized`)
    }
    Bun.gc(true)
    await pause()
  }
}

interface BorrowedCase {
  readonly baselineBytes: number
  readonly live: boolean
  readonly peakBytes: number
  readonly reference: WeakRef<WebAssembly.Memory>
}

async function ownedCase(): Promise<WeakRef<WebAssembly.Memory>[]> {
  const references: WeakRef<WebAssembly.Memory>[] = []
  for (let index = 0; index < 8; index += 1) {
    const session = await TerminalSession.create()
    references.push(new WeakRef(session.runtime.exports.memory))
    finalization.register(session.runtime.exports.memory, `owned-${index}`)
    session.dispose()
    await pause()
  }
  return references
}

async function borrowedCase(): Promise<BorrowedCase> {
  const runtime = await GhosttyRuntime.create()
  const reference = new WeakRef(runtime.exports.memory)
  finalization.register(runtime.exports.memory, 'borrowed')
  let baselineBytes = 0
  let peakBytes = 0
  for (let index = 0; index < 40; index += 1) {
    const session = await TerminalSession.create({
      runtime: { kind: 'borrowed', runtime },
    })
    session.dispose()
    const bytes = runtime.exports.memory.buffer.byteLength
    if (index === 7) baselineBytes = bytes
    if (index >= 8) peakBytes = Math.max(peakBytes, bytes)
    await pause()
  }
  const live = reference.deref() !== undefined
  runtime.dispose()
  return { baselineBytes, live, peakBytes, reference }
}

const owned = await ownedCase()
const borrowed = await borrowedCase()
await collectMemories(owned.length + 1)
console.log(
  JSON.stringify({
    owned: owned.filter((reference) => reference.deref()).length,
    borrowed: borrowed.reference.deref() !== undefined,
    borrowedLive: borrowed.live,
    borrowedBaselineBytes: borrowed.baselineBytes,
    borrowedPeakBytes: borrowed.peakBytes,
  }),
)
