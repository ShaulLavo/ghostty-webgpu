import { GhosttyRuntime } from '../../runtime.js'
import { TerminalSession } from '../../../term/session.js'

const pause = () => new Promise((resolve) => setTimeout(resolve, 10))

async function ownedCase(): Promise<WeakRef<WebAssembly.Memory>[]> {
  const references: WeakRef<WebAssembly.Memory>[] = []
  for (let index = 0; index < 8; index += 1) {
    const session = await TerminalSession.create()
    references.push(new WeakRef(session.runtime.exports.memory))
    session.dispose()
    await pause()
  }
  return references
}

async function borrowedCase(): Promise<WeakRef<WebAssembly.Memory>> {
  const runtime = await GhosttyRuntime.create()
  const reference = new WeakRef(runtime.exports.memory)
  for (let index = 0; index < 8; index += 1) {
    const session = await TerminalSession.create({
      runtime: { kind: 'borrowed', runtime },
    })
    session.dispose()
    await pause()
  }
  runtime.dispose()
  return reference
}

const owned = await ownedCase()
const borrowed = await borrowedCase()
for (let index = 0; index < 20; index += 1) {
  Bun.gc(true)
  await pause()
}
console.log(
  JSON.stringify({
    owned: owned.filter((reference) => reference.deref()).length,
    borrowed: borrowed.deref() !== undefined,
  }),
)
