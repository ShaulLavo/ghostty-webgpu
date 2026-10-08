import { Terminal, attachTerminalHotkeys } from 'ghostty-webgpu'

export async function mountEcho(host: HTMLElement) {
  const terminal = await Terminal.create()
  const { r, g, b } = terminal.appearance.theme.background
  host.style.backgroundColor = `rgb(${r}, ${g}, ${b})`
  attachTerminalHotkeys(terminal)
  await terminal.open(host)
  terminal.writeln('Hello from Ghostty. Type here to echo your keys.')
  terminal.onData((bytes) => terminal.write(bytes))
  terminal.focus()
  return () => terminal.dispose()
}
