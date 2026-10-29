import { Terminal } from 'ghostty-webgpu'
import { attachTerminalHotkeys } from 'ghostty-webgpu/hotkeys'

export async function mountEcho(host: HTMLElement) {
  const terminal = await Terminal.create({ accessibility: {} })
  const { r, g, b } = terminal.appearance.theme.background
  host.style.backgroundColor = `rgb(${r}, ${g}, ${b})`
  attachTerminalHotkeys(terminal)
  await terminal.open(host)
  terminal.writeln('Hello from Ghostty. Type here to echo your keys.')
  // A PTY turns Enter into a new line and Backspace into an erase; with no PTY, the echo does it.
  const decoder = new TextDecoder()
  terminal.onData(({ bytes }) =>
    terminal.write(
      decoder.decode(bytes, { stream: true }).replaceAll('\r', '\r\n').replaceAll('\x7f', '\b \b'),
    ),
  )
  terminal.focus()
  return () => terminal.dispose()
}
