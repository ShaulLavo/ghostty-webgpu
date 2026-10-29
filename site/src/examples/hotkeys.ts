import { Terminal } from 'ghostty-webgpu'
import { attachTerminalHotkeys } from 'ghostty-webgpu/hotkeys'

export async function mountHotkeys(host: HTMLElement) {
  const terminal = await Terminal.create()
  const connection = attachTerminalHotkeys(terminal, {
    mode: 'standalone',
    bindings: [{ keys: 'Ctrl+Q', command: 'terminal.clear', context: 'Terminal', source: 'user' }],
  })
  await terminal.open(host)
  return () => {
    connection.dispose()
    terminal.dispose()
  }
}
