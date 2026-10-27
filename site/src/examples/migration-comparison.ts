export const migrationComparison = [
  { from: 'new Terminal(opts)', to: 'await Terminal.create(opts)' },
  { from: 'term.onData(str => send(str))', to: 'term.onData(bytes => send(bytes))' },
  { from: 'term.open(host)', to: 'await term.open(host)' },
  { from: 'term.resize(cols, rows)', to: 'term.setAppearance({ grid })' },
  { from: '@xterm/headless', to: 'await GhosttyRuntime.create()' },
] as const

export const migrationRendererOption = "{ rendererMode: 'canvas2d-pixels' }"

export const migrationContext = `import {
  Terminal, GhosttyRuntime,
  type GhosttyWebGpuTerminalOptions, type TerminalGrid,
} from 'ghostty-webgpu'
declare const opts: GhosttyWebGpuTerminalOptions
declare const term: Terminal
declare const host: HTMLElement
declare const grid: Pick<TerminalGrid, 'columns' | 'rows'>
declare function send(data: Uint8Array): void
`
