import { Terminal } from 'ghostty-webgpu'
import { attachTerminalHotkeys } from 'ghostty-webgpu/hotkeys'
import { readline, type ReadlineApi } from 'ghostty-webgpu-line-editor'

export async function mountEcho(host: HTMLElement) {
  const terminal = await Terminal.create({ accessibility: {} })
  attachTerminalHotkeys(terminal)
  const editor = terminal.use(readline())
  await terminal.open(host)
  terminal.writeln('Hello from Ghostty. Type a line and press Enter.')
  terminal.focus()
  // Disposing the terminal rejects the pending read, which ends the loop.
  echoLines(editor.api).catch(() => undefined)
  return () => terminal.dispose()
}

async function echoLines(editor: ReadlineApi) {
  for (;;) {
    const result = await editor.read({ prompt: '$ ' })
    if (result.kind === 'submit' && result.text) editor.print(result.text)
  }
}
