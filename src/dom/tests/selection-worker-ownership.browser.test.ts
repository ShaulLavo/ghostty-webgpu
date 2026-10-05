import { afterEach, expect, it } from 'vitest'
import { Terminal } from '../../../dist/dom/terminal.js'
import { createTerminalSelectionController } from '../../../dist/dom/selection.js'
import { WorkerTerminalExecution } from '../../../dist/worker/execution.js'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it.each(['cancel', 'dispose', 'new press'] as const)(
  'keeps real packaged native ownership when %s interrupts a stale pending release',
  async (interruption) => {
    const family = 'PackagedSelectionOwnership'
    const execution = await WorkerTerminalExecution.create({
      assets: {
        wasm: new URL('../../../ghostty-vt.wasm', import.meta.url).href,
        bridge: new URL('../../../bridge.wasm', import.meta.url).href,
      },
      appearance: { font: { family, size: 16 } },
      backend: 'webgl',
      faces: [
        {
          family,
          source: {
            url: new URL(
              '../../../site/public/fonts/jetbrains-mono-latin-400-normal.woff2',
              import.meta.url,
            ).href,
          },
        },
      ],
    })
    cleanups.push(() => execution.dispose())
    const root = document.createElement('div')
    root.style.cssText = 'width:400px;height:100px;position:relative'
    document.body.append(root)
    cleanups.push(() => root.remove())
    const terminal = Terminal.fromWorker(execution, {})
    cleanups.push(() => terminal.dispose())
    await terminal.open(root)
    await terminal.write('native ownership')
    // A frame read fences native requests; the submitted identity is the projection source.
    await execution.request('refresh', [0, 1])
    const deadline = performance.now() + 5000
    let identity = await execution.selectionSnapshot()
    while (
      identity.revision !== execution.selectionIdentity?.revision ||
      identity.layout !== execution.selectionIdentity?.layout
    ) {
      if (performance.now() > deadline) expect.fail('Selection projection did not submit')
      await new Promise((resolve) => setTimeout(resolve, 10))
      identity = await execution.selectionSnapshot()
    }
    const summary = terminal.submittedFrame!
    const projection = {
      geometry: {
        cellWidth: summary.font.deviceCellWidth,
        columns: summary.grid.columns,
        paddingLeft: 0,
        screenHeight: 100,
      },
      position: { x: 0, y: 0 },
      viewport: { x: 0, y: 0 },
    }
    const controller = createTerminalSelectionController({
      getIdentity: () => identity,
      session: execution.selectionGesture,
      view: window,
    })
    cleanups.push(() => controller.dispose())
    await controller.press(projection)
    await terminal.write(' changed')
    const current = await execution.selectionSnapshot()
    window.dispatchEvent(new Event('resize'))
    const afterResize = await execution.selectionSnapshot()
    const pending = controller.release(projection)
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'execution',
      operation: 'selectionRelease',
    })
    expect(controller.active).toBe(false)
    if (interruption === 'dispose') controller.dispose()
    if (interruption === 'cancel') controller.cancel()
    // Native query identity is acknowledged authority, independent of the old display identity.
    identity = current
    const newer = interruption === 'dispose' ? undefined : controller.press(projection)
    await rejection
    await newer
    expect(afterResize).toEqual(current)
    identity = await execution.selectionSnapshot()
    const drag = { ...projection, position: { x: 60, y: 0 }, viewport: { x: 6, y: 0 } }
    if (interruption === 'dispose') {
      const update = await execution.selectionGesture.selectionDrag(drag)
      expect(update.selectionInstalled).toBe(false)
      return
    }
    expect(controller.active).toBe(true)
    const update = await controller.drag(drag, { captured: false, rectangle: false })
    expect(update?.selectionInstalled).toBe(true)
    expect((await execution.selectionSnapshot()).selection?.text).toBeDefined()
    await expect(
      execution.selectionSnapshot(undefined, { ...identity, generation: 0 }),
    ).rejects.toMatchObject({ code: 'execution' })
    root.style.width = '440px'
    window.dispatchEvent(new Event('resize'))
    const changed = await execution.selectionSnapshot()
    expect(changed.layout).toBeGreaterThan(identity.layout)
    expect(changed.revision).toBeGreaterThan(identity.revision)
    await expect(
      execution.selectionGesture.selectionPress(
        {
          position: { x: 0, y: 0 },
          viewport: { x: 0, y: 0 },
          repeatDistance: 10,
          repeatIntervalNanoseconds: 500_000_000n,
          timeNanoseconds: 1n,
        },
        identity,
      ),
    ).rejects.toMatchObject({ code: 'execution' })
  },
  15000,
)
