import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Terminal } from '../../../dist/index.js'
import { rendererPlatforms } from '../../render/tests/platforms.js'
import { restoreRendererNavigator, stubRendererNavigator } from '../../render/tests/navigator.js'

// Main-entry startup order against scripts/startup-fixture.ts. Its own file keeps the renderer
// modules unloaded until a test asks for them.
const linux = rendererPlatforms.find((platform) => platform.name === 'Linux client hints')!
const defaultRendererModules = [
  '/render/shared/fallback.js',
  '/render/webgl/renderer.js',
  '/render/canvas/renderer.js',
]
const terminals: Terminal[] = []

afterEach(async () => {
  for (const terminal of terminals.splice(0)) await terminal.dispose()
  restoreRendererNavigator()
})

function controlUrl(scenario: string, query: 'control' | 'status'): string {
  return new URL(`/__ghostty_startup__/${scenario}?${query}`, location.href).href
}

async function heldScenario(): Promise<{ scenario: string; release: () => Promise<void> }> {
  const scenario = `main-${crypto.randomUUID()}`
  const control = (body: Record<string, boolean>) =>
    fetch(controlUrl(scenario, 'control'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  onTestFinished(async () => {
    await fetch(controlUrl(scenario, 'control'), { method: 'DELETE' })
  })
  await control({ holdWasm: true })
  return { scenario, release: async () => void (await control({ holdWasm: false })) }
}

async function events(scenario: string): Promise<string[]> {
  const response = await fetch(controlUrl(scenario, 'status'))
  return ((await response.json()) as { events: string[] }).events
}

function runtime(scenario: string) {
  const base = `/__ghostty_startup__/${scenario}/`
  return {
    kind: 'owned' as const,
    options: {
      wasm: new URL(`${base}ghostty-vt.wasm`, location.href).href,
      bridge: new URL(`${base}bridge.wasm`, location.href).href,
    },
  }
}

function requestedRendererModules(): string[] {
  return performance
    .getEntriesByType('resource')
    .map((entry) => new URL(entry.name).pathname)
    .filter((path) => defaultRendererModules.some((module) => path.endsWith(module)))
}

it('starts no default renderer download for a custom renderer factory', async () => {
  stubRendererNavigator(linux.navigator)
  const { scenario, release } = await heldScenario()
  const created = Terminal.create({
    runtime: runtime(scenario),
    rendererFactory: () => Promise.reject(new Error('This test does not open the terminal')),
  })
  await expect.poll(async () => (await events(scenario)).includes('page:bridge.wasm')).toBe(true)
  // Any prefetch starts synchronously in create(); a few tasks later it would be in flight.
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(requestedRendererModules()).toEqual([])
  await release()
  terminals.push(await created)
  expect(requestedRendererModules()).toEqual([])
})

it('downloads the selected renderer while the core wasm is still held', async () => {
  stubRendererNavigator(linux.navigator)
  const { scenario, release } = await heldScenario()
  const fetches = vi.spyOn(globalThis, 'fetch')
  onTestFinished(() => fetches.mockRestore())
  const created = Terminal.create({ runtime: runtime(scenario) })
  expect(fetches.mock.calls.some(([input]) => String(input).includes('canvas-compose.wasm'))).toBe(
    true,
  )
  await expect
    .poll(() =>
      requestedRendererModules().some((path) => path.endsWith('/render/webgl/renderer.js')),
    )
    .toBe(true)
  expect(await events(scenario)).not.toContain('sent:ghostty-vt.wasm')
  await release()
  const terminal = await created
  terminals.push(terminal)
  const element = document.createElement('div')
  element.style.cssText = 'width:320px;height:120px'
  document.body.append(element)
  onTestFinished(() => element.remove())
  await terminal.open(element)
  terminal.write('prefetched renderer')
  await expect.poll(() => terminal.visibleLines()[0]?.includes('prefetched renderer')).toBe(true)
})
