import { Terminal, TerminalWorkerPool } from 'ghostty-webgpu/worker'

// One pool for the page; its terminals share a few workers instead of one worker each.
const pool = new TerminalWorkerPool()

export async function mountPooledWorker(host: HTMLElement, fontUrl: string) {
  const terminal = await Terminal.create({
    pool,
    backend: 'auto',
    fonts: [{ family: 'Terminal Mono', source: { url: fontUrl } }],
    appearance: { font: { family: 'Terminal Mono', size: 14 } },
  })
  await terminal.open(host)
  return () => terminal.dispose()
}
