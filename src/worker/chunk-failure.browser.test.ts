import { afterEach, expect, it, onTestFinished } from 'vitest'
import type { TerminalApi } from '../../dist/dom/terminal-api.js'
import { Terminal as WorkerTerminal } from '../../dist/worker/index.js'
import { requireWorkerWebGl } from '../render/tests/worker-webgl-capability.js'
import { testFontUrl } from '../tests/fonts.js'

const family = 'WorkerChunkFailureTest'
const assets = {
  wasm: new URL('../../ghostty-vt.wasm', import.meta.url).href,
  bridge: new URL('../../bridge.wasm', import.meta.url).href,
}
const active: TerminalApi[] = []
const containers: HTMLElement[] = []

afterEach(async () => {
  for (const terminal of active.splice(0)) await terminal.dispose()
  for (const container of containers.splice(0)) container.remove()
})

function hostContainer(): HTMLDivElement {
  const value = document.createElement('div')
  value.style.cssText = 'width:480px;height:160px;position:relative'
  document.body.append(value)
  containers.push(value)
  return value
}

async function setChunkFailure(
  scenario: string,
  fail: 'all-renderers' | 'none' | 'webgl' | 'webgpu',
): Promise<void> {
  const response = await fetch(`/__ghostty_worker_chunk__/${scenario}?control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fail }),
  })
  expect(response.status).toBe(204)
}

async function readChunkStatus(
  scenario: string,
): Promise<{ readonly requests: readonly string[]; readonly failed: readonly string[] }> {
  const response = await fetch(`/__ghostty_worker_chunk__/${scenario}?status`)
  expect(response.status).toBe(200)
  return (await response.json()) as {
    readonly requests: readonly string[]
    readonly failed: readonly string[]
  }
}

async function clearChunkScenario(scenario: string): Promise<void> {
  await fetch(`/__ghostty_worker_chunk__/${scenario}?control`, { method: 'DELETE' })
}

async function eventually(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await condition())) {
    if (Date.now() > deadline) expect.fail('Submitted worker frame did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

it('opens cleanly after a transient renderer chunk 503 during worker startup', async () => {
  await requireWorkerWebGl()
  const scenario = `startup-503-${crypto.randomUUID()}`
  onTestFinished(() => clearChunkScenario(scenario))
  await setChunkFailure(scenario, 'all-renderers')

  const terminal = await WorkerTerminal.create({
    assets,
    appearance: { font: { family, size: 16 }, cursor: { blink: false } },
    backend: 'webgl',
    workerUrl: new URL(`/__ghostty_worker_chunk__/${scenario}/entry.js`, location.href),
    fonts: [{ family, source: { url: testFontUrl } }],
  })
  active.push(terminal)

  // Startup must not poison Chromium's ESM module map with a failed renderer import.
  const duringStart = await readChunkStatus(scenario)
  expect(duringStart.failed).toEqual([])

  await setChunkFailure(scenario, 'none')
  await terminal.open(hostContainer())
  await terminal.write('chunk retry ok')
  await eventually(() => terminal.visibleLines()[0]?.includes('chunk retry ok') === true)

  expect(terminal.diagnostics.rendererBackend).toBe('webgl2')
  const afterOpen = await readChunkStatus(scenario)
  expect(afterOpen.requests).toEqual(['webgl'])
  expect(afterOpen.failed).toEqual([])
})

it('falls back to WebGL and destroys the unused GPUDevice when the WebGPU chunk returns 503 in auto mode', async () => {
  await requireWorkerWebGl()
  const scenario = `auto-webgpu-503-${crypto.randomUUID()}`
  const channel = new BroadcastChannel(`worker-chunk-${scenario}`)
  const events: string[] = []
  channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (typeof data === 'string') events.push(data)
  }
  onTestFinished(async () => {
    channel.close()
    await clearChunkScenario(scenario)
  })
  await setChunkFailure(scenario, 'webgpu')

  const terminal = await WorkerTerminal.create({
    assets,
    appearance: { font: { family, size: 16 }, cursor: { blink: false } },
    backend: 'auto',
    workerUrl: new URL(`/__ghostty_worker_chunk__/${scenario}/macos-entry.js`, location.href),
    fonts: [{ family, source: { url: testFontUrl } }],
  })
  active.push(terminal)

  await terminal.open(hostContainer())
  await terminal.write('auto webgl fallback')
  await eventually(() => terminal.visibleLines()[0]?.includes('auto webgl fallback') === true)

  expect(terminal.diagnostics.rendererBackend).toBe('webgl2')
  const status = await readChunkStatus(scenario)
  expect(status.failed).toEqual(['webgpu'])
  expect(status.requests).toEqual(['webgpu', 'webgl'])
  await expect.poll(() => events).toEqual(['device', 'destroyed'])
})
