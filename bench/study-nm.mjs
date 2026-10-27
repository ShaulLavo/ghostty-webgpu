import { legacyText } from './comparison-legacy-text.js'
let ghostty
export async function createNm(host, settings) {
  const { Ghostty, Terminal } = await import('/nm-sdk.js')
  ghostty ??= await Ghostty.load('/nm.wasm')
  const terminal = new Terminal({
    ghostty,
    cols: settings.columns,
    rows: settings.rows,
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    scrollback: settings.scrollback,
    renderer: 'webgpu',
    cursorBlink: false,
    smoothScrollDuration: 0,
    theme: { foreground: '#ffffff', background: '#000000' },
  })
  await terminal.open(host)
  if (terminal.renderer?.backend !== 'webgpu') throw new Error('nm-webgpu backend required')
  const adapter = terminal.renderer.device.adapterInfo
  const text = () => legacyText(terminal)
  return {
    write: async (data) => terminal.write(data),
    text,
    history: () => terminal.buffer.active.baseY,
    focus: () => terminal.focus(),
    onData: (listener) => {
      terminal.onData(({ bytes }) => listener(bytes))
    },
    metadata: () => ({
      backend: terminal.renderer.backend,
      adapter: {
        vendor: adapter.vendor,
        architecture: adapter.architecture,
        description: adapter.description,
        fallback: adapter.isFallbackAdapter,
      },
      metrics: terminal.renderer.getMetrics(),
    }),
    dispose: () => terminal.dispose(),
  }
}
