import { testFontUrl } from '../../tests/fonts.js'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../core/runtime.js'
import { Terminal as MainTerminal } from '../terminal.js'
import type { GhosttyWebGpuTerminalOptions } from '../types.js'
import type { TerminalApi } from '../terminal-api.js'
import { Terminal as WorkerTerminal } from '../../../dist/worker/index.js'

const terminals: TerminalApi[] = []
const hosts: HTMLElement[] = []
let runtime: GhosttyRuntime
beforeAll(async () => {
  runtime = await GhosttyRuntime.create()
})
afterEach(async () => {
  for (const terminal of terminals.splice(0).reverse()) await terminal.dispose()
  for (const host of hosts.splice(0)) host.remove()
  vi.restoreAllMocks()
})
afterAll(() => runtime.dispose())

function host(): HTMLDivElement {
  const value = document.createElement('div')
  value.style.cssText = 'width:480px;height:160px;position:relative'
  document.body.append(value)
  hosts.push(value)
  return value
}
function composeFetches(fetches: {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] }
}): number {
  return fetches.mock.calls.filter(([url]) => String(url).includes('canvas-compose.wasm')).length
}
async function createWorker(rendererMode?: GhosttyWebGpuTerminalOptions['rendererMode']) {
  const terminal = await WorkerTerminal.create({
    rendererMode,
    appearance: { cursor: { blink: false } },
    fonts: [
      {
        family: 'CanvasModeWorkerTest',
        source: {
          url: testFontUrl,
        },
      },
    ],
    workerUrl: new URL('../../../dist/worker/entry.js', import.meta.url),
    assets: {
      wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
      bridge: new URL('../../../bridge.wasm', import.meta.url).href,
    },
  })
  terminals.push(terminal)
  return terminal
}

it.for([undefined, 'auto', 'canvas2d-fill-text', 'canvas2d-pixels'] as const)(
  'routes public local mode %s through the native terminal owner',
  async (rendererMode, context) => {
    const fetches = vi.spyOn(globalThis, 'fetch')
    const terminal = await MainTerminal.create({
      rendererMode,
      appearance: { cursor: { blink: false }, font: { family: 'monospace', size: 16 } },
      runtime: { kind: 'borrowed', runtime },
    })
    terminals.push(terminal)
    await terminal.open(host())
    terminal.write('\x1b[?25l\x1b[?2027lÁ界👩‍💻\r\n\x1b[?2027h👩‍💻')
    await expect.poll(() => terminal.visibleLines()[0]?.includes('Á界')).toBe(true)
    await expect.poll(() => terminal.hasPendingFrame).toBe(false)
    expect(terminal.readLines(0, 1)[0]?.text).toContain('Á界')
    expect(composeFetches(fetches)).toBe(rendererMode === 'canvas2d-pixels' ? 1 : 0)
    await context.annotate(
      JSON.stringify({
        evidence: 'canvas-mode-correctness',
        actor: 'main',
        mode: rendererMode ?? 'default',
        backend: terminal.diagnostics.rendererBackend,
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
      }),
    )
    if (!rendererMode || rendererMode === 'auto') return
    expect(terminal.diagnostics.rendererBackend).toBe('canvas2d')
    await page.screenshot({
      element: terminal.canvas!,
      path: `../../../.artifacts/public-${rendererMode}.png`,
      scale: 'css',
    })
  },
)

it.for([undefined, 'auto'] as const)(
  'preserves public worker mode %s without compositor fetches',
  { timeout: 20_000 },
  async (rendererMode, context) => {
    const fetches = vi.spyOn(globalThis, 'fetch')
    const terminal = await createWorker(rendererMode)
    await terminal.open(host())
    await terminal.write('worker native owner')
    await expect.poll(() => terminal.visibleLines()[0]?.includes('worker native owner')).toBe(true)
    expect((await terminal.readLines(0, 1))[0]?.text).toContain('worker native owner')
    expect(['webgl2', 'webgpu']).toContain(terminal.diagnostics.rendererBackend)
    await context.annotate(
      JSON.stringify({
        evidence: 'canvas-mode-correctness',
        actor: 'worker',
        mode: rendererMode ?? 'default',
        backend: terminal.diagnostics.rendererBackend,
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
      }),
    )
    expect(composeFetches(fetches)).toBe(0)
  },
)

it.each(['canvas2d-fill-text', 'canvas2d-pixels'] as const)(
  'rejects public worker Canvas mode %s with an explicit capability error',
  async (rendererMode) => {
    const fetches = vi.spyOn(globalThis, 'fetch')
    const terminal = await createWorker(rendererMode)
    await expect(terminal.open(host())).rejects.toMatchObject({
      code: 'capability',
      operation: 'renderer.create',
      why: 'Canvas paint modes run in the main-thread terminal.',
      fix: 'Use the main terminal entry or automatic worker rendering.',
      internal: { actor: 'worker', capability: 'canvas2d' },
    })
    expect(terminal.lifecycle).toBe('disposed')
    expect(terminal.hasPendingFrame).toBe(false)
    expect(composeFetches(fetches)).toBe(0)
  },
  20_000,
)
