import { expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { GhosttyRuntime } from '../../../dist/core/runtime.js'
import { WebGpuTerminalRenderer } from '../../../dist/render/webgpu/renderer.js'
import { FrameCoordinator } from '../../../dist/render/shared/frame-coordinator.js'
import {
  observeDisplayedFrame,
  type DisplayedFrameOptions,
} from '../../../dist/render/shared/displayed-frame.js'
import type { WebGpuTerminalRendererOptions } from '../../../dist/render/shared/types.js'
import type { GhosttyTerminal } from '../../../dist/core/terminal.js'
import type { GhosttyRenderState } from '../../../dist/core/render-state.js'
import { probeFont } from '../dom/tests/probe.js'

async function fixture() {
  const runtime = await GhosttyRuntime.create({
    wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
    bridge: new URL('../../../bridge.wasm', import.meta.url).href,
  })
  const terminal = runtime.createTerminal({ columns: 16, rows: 3 })
  const first = runtime.createRenderState(terminal)
  const second = runtime.createRenderState(terminal)
  const host = document.createElement('div')
  host.style.cssText = 'width:160px;height:60px;position:relative'
  const canvas = document.createElement('canvas')
  host.append(canvas)
  document.body.append(host)
  let retained = ''
  try {
    const options = {
      canvas,
      columns: 16,
      rows: 3,
      font: probeFont,
      renderState: first,
      retainDisplayedText: true,
      needsFrameRows: () => false,
      [observeDisplayedFrame]: (frame) => {
        retained = frame.rows[0]?.text.trimEnd() ?? ''
      },
    } satisfies WebGpuTerminalRendererOptions & DisplayedFrameOptions
    const renderer = await WebGpuTerminalRenderer.create(options)
    return { runtime, terminal, first, second, host, renderer, readRetained: () => retained }
  } catch (cause) {
    runtime.dispose()
    host.remove()
    throw cause
  }
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function captureNewer(
  terminal: GhosttyTerminal,
  first: GhosttyRenderState,
  second: GhosttyRenderState,
  readLater: boolean,
) {
  terminal.write('\rNEW')
  second.update()
  second.acknowledge()
  if (readLater) first.readTextRows()
}

it.each([false, true])(
  'publishes encoded text and preserves newer damage at deferred commit with later read=%s',
  async (readLater) => {
    const { runtime, terminal, first, second, host, renderer, readRetained } = await fixture()
    try {
      terminal.write('\x1b[?25lold before')
      renderer.notifyWrite()
      await expect.poll(readRetained).toBe('old before')
      const reference = await page.screenshot({ element: host, save: false, scale: 'css' })
      terminal.write('\r\x1b[2Kold')
      renderer.notifyWrite()
      await expect.poll(readRetained).toBe('old')
      const coordinator: unknown = Reflect.get(renderer, 'coordinator')
      expect(coordinator).toBeInstanceOf(FrameCoordinator)
      if (!(coordinator instanceof FrameCoordinator)) throw new Error('Missing frame coordinator')
      terminal.write(' before')
      renderer.notifyWrite()
      coordinator.requestFrame(() => captureNewer(terminal, first, second, readLater))
      await nextFrame()
      expect(await page.screenshot({ element: host, save: false, scale: 'css' })).toBe(reference)
      expect(readRetained()).toBe('old before')
      expect(first.dirty).not.toBe(0)
      await page.screenshot({
        element: host,
        path: `.artifacts/b1-deferred-encoded-${readLater}.png`,
      })
      renderer.notifyWrite()
      await expect.poll(readRetained).toBe('NEW before')
      expect(first.dirty).toBe(0)
    } finally {
      await renderer.dispose()
      runtime.dispose()
      host.remove()
    }
  },
)

it('discards the staged retained frame when deferred submission fails and retries the damage', async () => {
  const { runtime, terminal, first, host, renderer, readRetained } = await fixture()
  let restore = () => {}
  try {
    terminal.write('old')
    renderer.notifyWrite()
    await expect.poll(readRetained).toBe('old')
    const device: unknown = Reflect.get(renderer, 'device')
    if (!(device instanceof GPUDevice)) throw new Error('Missing GPU device')
    const submit = vi.spyOn(device.queue, 'submit').mockImplementationOnce(() => {
      throw new Error('Injected submission failure')
    })
    restore = () => submit.mockRestore()
    terminal.write(' before')
    renderer.notifyWrite()
    await nextFrame()
    expect(readRetained()).toBe('old')
    expect(first.dirty).not.toBe(0)
    await expect.poll(readRetained).toBe('old before')
    expect(first.dirty).toBe(0)
  } finally {
    restore()
    await renderer.dispose()
    runtime.dispose()
    host.remove()
  }
})
