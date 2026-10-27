import { fitTerminalFont } from '../src/dom/fit.js'

export async function createWraith(host, settings) {
  const { Wraith } = await import('/wraith-sdk.js')
  const fitted = fitTerminalFont(
    document,
    {
      family: settings.fontFamily,
      size: settings.fontSize,
      lineHeight: settings.lineHeight,
      weight: 400,
      boldWeight: 700,
      letterSpacing: 0,
    },
    devicePixelRatio,
  )
  const terminal = await Wraith.mount(host, {
    cols: settings.columns,
    rows: settings.rows,
    font: '/font.ttf',
    fontSize: settings.fontSize,
    lineHeight: (fitted.deviceCellHeight - 0.01) / (settings.fontSize * devicePixelRatio),
    fit: false,
    ligatures: false,
    screenReaderMode: false,
    scrollback: settings.scrollback,
    theme: { foreground: '#ffffff', background: '#000000', cursor: '#ffffff' },
  })
  const errors = []
  let renderedFrames = 0
  terminal.onRender(({ frame }) => {
    renderedFrames = frame
  })
  let stats
  terminal.onStats((value) => {
    stats = value
  })
  terminal.onError((error) => errors.push(String(error)))
  return {
    write: (data) => terminal.write(data),
    complete: () => terminal.flush(),
    text: () => [],
    asyncText: async () => {
      await terminal.flush()
      if (errors.length) throw new Error(errors.join('; '))
      const lines = (await terminal.getText()).split('\n')
      return Array.from({ length: settings.rows }, (_, row) => lines[row] ?? '')
    },
    history: () => 0,
    focus: () => terminal.focus(),
    onData: (listener) => {
      terminal.onData(listener)
    },
    resize: (columns, rows) => terminal.resize(columns, rows),
    metadata: () => ({
      stats,
      renderedFrames,
      workerTopology: 'dedicated-worker-per-terminal',
      actualCell: {
        width: Reflect.get(terminal, 'cellWidth'),
        height: Reflect.get(terminal, 'cellHeight'),
      },
      requestedLineHeight:
        (fitted.deviceCellHeight - 0.01) / (settings.fontSize * devicePixelRatio),
      targetCell: { width: fitted.deviceCellWidth, height: fitted.deviceCellHeight },
      errors,
    }),
    dispose: () => {
      void terminal.dispose()
    },
  }
}
