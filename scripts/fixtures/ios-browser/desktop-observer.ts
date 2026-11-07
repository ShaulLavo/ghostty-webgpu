import type { FrameworkObservation, Json } from 'waffle/testing/page-runner/framework-page'

// Local accessor test double. It does not implement admission, binding, or Waffle retirement.
const role = window === window.parent ? 'orchestrator' : 'tester'
let sequence = 0
const pending = new Set<Promise<void>>()
function send(event: string, detail: Json = null): Promise<void> {
  const task = fetch('/ghostty-local-event', {
    method: 'POST',
    body: JSON.stringify({ role, sequence: ++sequence, event, detail }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(await response.text())
  })
  pending.add(task)
  void task.then(
    () => pending.delete(task),
    () => pending.delete(task),
  )
  return task
}
function enqueue(event: string, detail: Json = null): void {
  void send(event, detail).catch((error) => console.error(error))
}
const observation: FrameworkObservation = {
  collected: (tasks) => send('collected', tasks),
  taskStarted: (id) => enqueue('task-started', id),
  taskUpdate: (updates) => enqueue('task-update', updates),
  caseSettled: (updates) => enqueue('case-settled', updates),
  error(error, source) {
    enqueue('error', { error, source })
    if (!Reflect.get(globalThis, Symbol.for('ghostty.local.observerThrows'))) return
    enqueue('observer-throw')
    throw new Error('LOCAL_OBSERVER_THREW')
  },
  executionFlushed: () => enqueue('execution-flushed'),
  testerCleanupSettled: () => enqueue('tester-cleanup-settled'),
  cleanupResponseReceived: () => enqueue('cleanup-response-received'),
  catcherInstalled: () => enqueue('catcher-installed'),
  async waitForInitialViewport() {
    await send('startup-wait', {
      width: document.body.style.getPropertyValue('--viewport-width'),
      height: document.body.style.getPropertyValue('--viewport-height'),
    })
    return { permit: 'LOCAL_DESKTOP_DOUBLE_ONLY', width: 414, height: 896 }
  },
  async waitForRetirement() {
    const iframe = document.querySelector('iframe[data-vitest]')
    if (!(iframe instanceof HTMLIFrameElement)) throw new Error('Missing final tester')
    const tester = iframe.contentWindow
    if (!tester) throw new Error('Missing tester window')
    const drain: unknown = Reflect.get(tester, Symbol.for('ghostty.local.drain'))
    if (typeof drain !== 'function') throw new Error('Missing local drain')
    await drain()
    await Promise.all(Array.from(pending))
    await send('local-retirement-gate', { testerConnected: iframe.isConnected })
  },
}
Reflect.set(globalThis, Symbol.for('waffle.framework.observation'), () => observation)
Reflect.set(globalThis, Symbol.for('ghostty.local.drain'), () => Promise.all(Array.from(pending)))
