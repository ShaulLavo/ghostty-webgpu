import { createTerminalElements } from '../src/dom/elements.js'
import { WorkerTerminalExecution } from '../src/worker/execution.js'
import type { RendererTextFrameSnapshot } from '../src/render/shared/types.js'

export async function createControl(
  mode: 'control' | 'delta',
  columns: number,
  rows: number,
  ordinal: number,
  onFrame: (snapshot: RendererTextFrameSnapshot) => void,
) {
  const backend =
    new URL(location.href).searchParams.get('backend') === 'webgpu' ? 'webgpu' : 'webgl'
  const execution = await WorkerTerminalExecution.create({
    assets: { wasm: '/ghostty-vt.wasm', bridge: '/bridge.wasm' },
    backend,
    faces: [{ family: 'JetBrains Mono', source: { url: '/fonts/JetBrainsMono-Regular.woff2' } }],
    appearance: {
      grid: { columns, rows },
      font: { family: 'JetBrains Mono', size: 13 },
      cursor: { blink: false },
    },
    workerUrl: `/${mode}-worker.js?ordinal=${ordinal}`,
  })
  const events: unknown[] = []
  for (const name of [
    'appearance',
    'bell',
    'data',
    'error',
    'resize',
    'scroll',
    'selection',
    'title',
  ] as const)
    execution.on(name, (value) => events.push({ name, value }))
  const container = document.createElement('div')
  document.querySelector('main')!.append(container)
  const elements = createTerminalElements(container)
  execution.setFrameListener(onFrame)
  const font = await execution.open(elements, {
    identity: 1,
    width: 2000,
    height: 1500,
    pixelRatio: devicePixelRatio,
    padding: { top: 0, right: 0, bottom: 0, left: 0 },
    scrollbarWidth: 0,
    autoFit: false,
  })
  elements.canvas.style.width = `${columns * font.cssCellWidth}px`
  elements.canvas.style.height = `${rows * font.cssCellHeight}px`
  return { execution, elements, events }
}
