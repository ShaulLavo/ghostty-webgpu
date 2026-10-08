import { Terminal } from 'ghostty-webgpu'

export async function mountWithFont(host: HTMLElement, fontUrl: string) {
  const face = new FontFace('Terminal Mono', `url(${fontUrl})`)
  document.fonts.add(await face.load())
  const terminal = await Terminal.create({
    appearance: { font: { family: '"Terminal Mono", monospace', size: 14 } },
  })
  await terminal.open(host)
  terminal.writeln('Font loaded before measuring the grid.')
  return () => terminal.dispose()
}
