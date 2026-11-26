import { Terminal } from 'ghostty-webgpu'

export async function mountTerminal(host: HTMLElement) {
  const terminal = await Terminal.create()
  await terminal.open(host)
  terminal.writeln('Hello from Ghostty.')
  terminal.onData(({ bytes }) => {
    terminal.write(bytes)
  })
  terminal.focus()
  return () => terminal.dispose()
}
