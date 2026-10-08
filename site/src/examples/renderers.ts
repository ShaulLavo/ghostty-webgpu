import { Terminal } from 'ghostty-webgpu'

export async function mountRenderer(host: HTMLElement) {
  const terminal = await Terminal.create({ rendererMode: 'auto' })
  await terminal.open(host)
  terminal.writeln(`Renderer: ${terminal.diagnostics.rendererBackend}`)
  return () => terminal.dispose()
}
