import { createTerminalElements } from '../src/dom/elements.js'
import { WorkerTerminalExecution } from '../src/worker/execution.js'
import type { RendererTextFrameSnapshot } from '../src/render/shared/types.js'

export async function createControl(
  columns: number,
  rows: number,
  onFrame: (snapshot: RendererTextFrameSnapshot) => void,
) {
  const execution = await WorkerTerminalExecution.create({
    assets: { wasm: '/ghostty-vt.wasm', bridge: '/bridge.wasm' },
    backend: 'webgl',
    faces: [{ family: 'JetBrains Mono', source: { url: '/fonts/JetBrainsMono-Regular.woff2' } }],
    appearance: {
      grid: { columns, rows },
      font: { family: 'JetBrains Mono', size: 13 },
      cursor: { blink: false },
    },
    workerUrl: '/control-worker.js',
  })
  const container = document.createElement('div')
  document.querySelector('main')!.append(container)
  const elements = createTerminalElements(container)
  execution.setFrameListener(onFrame)
  await execution.open(elements, {
    identity: 1,
    width: 2000,
    height: 1500,
    pixelRatio: devicePixelRatio,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    scrollbarWidth: 0,
    autoFit: false,
  })
  return { execution, elements }
}
