import { afterEach, expect, it, onTestFinished, vi, type TestContext } from 'vitest'
import type { TerminalApi } from '../../dist/dom/terminal-api.js'
import { Terminal as WorkerTerminal } from '../../dist/worker/index.js'
import { requireWebGpu } from '../render/tests/webgpu-capability.js'
import { requireWorkerWebGl } from '../render/tests/worker-webgl-capability.js'
import { testFontUrl } from '../tests/fonts.js'

// Worker startup against scripts/startup-fixture.ts, which records who fetched each file.
const family = 'WorkerStartupTest'
const active: TerminalApi[] = []
const containers: HTMLElement[] = []
const unhandled: unknown[] = []
const onUnhandled = (event: PromiseRejectionEvent) => {
  unhandled.push(event.reason)
  event.preventDefault()
}

afterEach(async () => {
  window.removeEventListener('unhandledrejection', onUnhandled)
  unhandled.length = 0
  vi.restoreAllMocks()
  for (const terminal of active.splice(0)) await terminal.dispose()
  for (const container of containers.splice(0)) container.remove()
})

function scenarioUrl(scenario: string, file: string): string {
  return new URL(`/__ghostty_startup__/${scenario}/${file}`, location.href).href
}

function controlUrl(scenario: string, query: 'control' | 'status'): string {
  return new URL(`/__ghostty_startup__/${scenario}?${query}`, location.href).href
}

async function newScenario(control: Record<string, boolean> = {}): Promise<string> {
  const scenario = `worker-${crypto.randomUUID()}`
  onTestFinished(async () => {
    await fetch(controlUrl(scenario, 'control'), { method: 'DELETE' })
  })
  await setControl(scenario, control)
  return scenario
}

async function setControl(scenario: string, control: Record<string, boolean>): Promise<void> {
  const response = await fetch(controlUrl(scenario, 'control'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(control),
  })
  expect(response.status).toBe(204)
}

async function events(scenario: string): Promise<string[]> {
  const response = await fetch(controlUrl(scenario, 'status'))
  return ((await response.json()) as { events: string[] }).events
}

function assets(scenario: string) {
  return {
    wasm: scenarioUrl(scenario, 'ghostty-vt.wasm'),
    bridge: scenarioUrl(scenario, 'bridge.wasm'),
  }
}

function container(): HTMLDivElement {
  const value = document.createElement('div')
  value.style.cssText = 'width:480px;height:160px;position:relative'
  document.body.append(value)
  containers.push(value)
  return value
}

function create(
  scenario: string,
  options: { backend?: 'webgl' | 'webgpu'; entry?: string; font?: string } = {},
) {
  return WorkerTerminal.create({
    assets: assets(scenario),
    appearance: { font: { family, size: 16 }, cursor: { blink: false } },
    backend: options.backend ?? 'webgl',
    workerUrl: scenarioUrl(scenario, options.entry ?? 'entry.js'),
    fonts: [{ family, source: { url: options.font ?? testFontUrl } }],
  })
}

async function openAndWrite(terminal: TerminalApi, text: string): Promise<void> {
  await terminal.open(container())
  await terminal.write(text)
  await expect.poll(() => terminal.visibleLines()[0]?.includes(text)).toBe(true)
}

function wasmRequests(log: readonly string[]): string[] {
  return log.filter((entry) => entry.endsWith('.wasm') && !entry.startsWith('sent:'))
}

function gpuChannel(scenario: string) {
  const channel = new BroadcastChannel(`startup-${scenario}`)
  const messages: string[] = []
  channel.onmessage = ({ data }: MessageEvent<unknown>) => {
    if (typeof data === 'string') messages.push(data)
  }
  onTestFinished(() => channel.close())
  return { channel, messages }
}

async function adapterAttempts(scenario: string): Promise<number> {
  return (await events(scenario)).filter((event) => event === 'worker:requestAdapter').length
}

async function requireRealAdapter(context: TestContext): Promise<void> {
  requireWebGpu(context)
  if (!(await navigator.gpu.requestAdapter())) context.skip('No WebGPU adapter')
}

it('requests the wasm from the page before the worker script arrives and starts from it', async () => {
  await requireWorkerWebGl()
  // The worker script is held until the page has requested both wasm files.
  const scenario = await newScenario({ gateEntry: true })
  const terminal = await create(scenario)
  active.push(terminal)
  await openAndWrite(terminal, 'page compiled wasm')
  const log = await events(scenario)
  expect(wasmRequests(log)).toEqual(['page:ghostty-vt.wasm', 'page:bridge.wasm'])
  expect(log.indexOf('sent:entry.js')).toBeGreaterThan(log.indexOf('page:bridge.wasm'))
})

it('shares one page compile between concurrently created workers', async () => {
  await requireWorkerWebGl()
  const scenario = await newScenario()
  const terminals = await Promise.all([create(scenario), create(scenario), create(scenario)])
  active.push(...terminals)
  await Promise.all(terminals.map((terminal, index) => openAndWrite(terminal, `shared ${index}`)))
  expect(wasmRequests(await events(scenario))).toEqual(['page:ghostty-vt.wasm', 'page:bridge.wasm'])
})

it('lets the worker download the wasm when the compiled modules cannot be sent', async () => {
  await requireWorkerWebGl()
  window.addEventListener('unhandledrejection', onUnhandled)
  const postMessage = MessagePort.prototype.postMessage
  vi.spyOn(MessagePort.prototype, 'postMessage').mockImplementation(function (
    this: MessagePort,
    ...args: Parameters<MessagePort['postMessage']>
  ) {
    const message = args[0] as { type?: string; wasm?: unknown } | undefined
    if (message?.type === 'modules' && message.wasm)
      throw new DOMException('Injected clone failure', 'DataCloneError')
    return Reflect.apply(postMessage, this, args)
  })
  const scenario = await newScenario()
  const terminal = await create(scenario)
  active.push(terminal)
  await openAndWrite(terminal, 'worker downloaded wasm')
  expect(wasmRequests(await events(scenario))).toEqual(
    expect.arrayContaining(['worker:ghostty-vt.wasm', 'worker:bridge.wasm']),
  )
  expect(unhandled).toEqual([])
})

it('lets the worker download the wasm after a receive-side clone failure', async () => {
  await requireWorkerWebGl()
  const scenario = await newScenario()
  const terminal = await create(scenario, { entry: 'messageerror-entry.js' })
  active.push(terminal)
  await openAndWrite(terminal, 'clone failure fallback')
  expect(wasmRequests(await events(scenario))).toEqual(
    expect.arrayContaining(['worker:ghostty-vt.wasm', 'worker:bridge.wasm']),
  )
})

it('rejects a failed initialize send without leaving the page compile unhandled', async () => {
  window.addEventListener('unhandledrejection', onUnhandled)
  const postMessage = Worker.prototype.postMessage
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker['postMessage']>
  ) {
    if ((args[0] as { type?: string } | undefined)?.type === 'initialize')
      throw new DOMException('Injected send failure', 'DataCloneError')
    return Reflect.apply(postMessage, this, args)
  })
  const scenario = await newScenario({ failWasm: true })
  await expect(create(scenario)).rejects.toMatchObject({
    code: 'protocol',
    operation: 'initialize',
  })
  await expect
    .poll(
      async () => (await events(scenario)).filter((entry) => /^sent:.*\.wasm$/.test(entry)).length,
    )
    .toBe(2)
  // Rejections surface after the failed responses settle; give them a task to arrive.
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(unhandled).toEqual([])
})

it('retries a failed speculative adapter request when the worker opens', async (context) => {
  await requireRealAdapter(context)
  const scenario = await newScenario()
  const terminal = await create(scenario, {
    backend: 'webgpu',
    entry: 'gpu-entry.js?mode=late-adapter',
  })
  active.push(terminal)
  await expect.poll(() => adapterAttempts(scenario)).toBe(1)
  await openAndWrite(terminal, 'adapter after retry')
  expect(terminal.diagnostics.rendererBackend).toBe('webgpu')
  expect(await adapterAttempts(scenario)).toBe(2)
})

it('reports an adapter that stays unavailable after retrying at open', async () => {
  requireWebGpu()
  const scenario = await newScenario()
  const terminal = await create(scenario, {
    backend: 'webgpu',
    entry: 'gpu-entry.js?mode=no-adapter',
  })
  active.push(terminal)
  await expect.poll(() => adapterAttempts(scenario)).toBe(1)
  await expect(terminal.open(container())).rejects.toMatchObject({
    code: 'capability',
    operation: 'renderer.webgpu',
  })
  expect(await adapterAttempts(scenario)).toBe(2)
})

it('reports a font failure while the speculative device request is still pending', async (context) => {
  await requireRealAdapter(context)
  const scenario = await newScenario()
  const { channel, messages } = gpuChannel(scenario)
  // Observed at once: with the fix the failure can arrive before the adapter message does.
  const failure = create(scenario, {
    backend: 'webgpu',
    entry: 'gpu-entry.js?mode=held-adapter',
    font: scenarioUrl(scenario, 'missing-font.woff2'),
  }).then(
    () => undefined,
    (cause: unknown) => cause,
  )
  await expect.poll(() => messages.includes('adapter-1')).toBe(true)
  // The adapter request is still held here; before the fix the failure waited for it.
  expect(await failure).toMatchObject({ name: 'TerminalWorkerError' })
  expect(messages).not.toContain('device')
  expect(await failure).not.toMatchObject({ code: 'timeout' })
  channel.postMessage('release')
}, 12_000)
