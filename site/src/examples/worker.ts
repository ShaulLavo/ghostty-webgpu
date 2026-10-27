import { Terminal } from 'ghostty-webgpu/worker'

export async function mountWorker(host: HTMLElement, fontUrl: string) {
  const terminal = await Terminal.create({
    backend: 'auto',
    fonts: [{ family: 'Terminal Mono', source: { url: fontUrl } }],
    appearance: { font: { family: 'Terminal Mono', size: 14 } },
  })
  await terminal.open(host)
  await terminal.writeln('The terminal core and GPU renderer run in a worker.')
  terminal.onData((bytes) => {
    void terminal.write(bytes)
  })
  terminal.focus()
  return () => terminal.dispose()
}
