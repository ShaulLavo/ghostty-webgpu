import { Terminal, attachTerminalHotkeys } from 'ghostty-webgpu'

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
