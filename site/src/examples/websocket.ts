import { Terminal, attachTerminalHotkeys } from 'ghostty-webgpu'

export async function connectShell(host: HTMLElement, url: string) {
  const terminal = await Terminal.create()
  attachTerminalHotkeys(terminal)
  await terminal.open(host)
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  const sendSize = () => {
    if (socket.readyState !== WebSocket.OPEN) return
    const { columns, rows } = terminal.geometry()
    socket.send(JSON.stringify({ type: 'resize', columns, rows }))
  }
  socket.addEventListener('open', sendSize)
  terminal.onResize(sendSize)
  terminal.onData((bytes) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array(bytes))
  })
  socket.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) terminal.write(new Uint8Array(data))
  })
  terminal.focus()
  return () => {
    socket.close()
    terminal.dispose()
  }
}
