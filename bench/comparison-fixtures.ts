export const variants = [
  { id: 'ghostty-webgpu', library: 'ghostty-webgpu', renderer: 'webgpu' },
  { id: 'xterm-webgl', library: '@xterm/xterm', renderer: 'webgl' },
  { id: 'xterm-dom', library: '@xterm/xterm', renderer: 'dom' },
  { id: 'ghostty-web', library: 'ghostty-web', renderer: 'canvas2d' },
] as const

export type Variant = (typeof variants)[number]['id']
export type WritePath = 'bytes' | 'string'
export const fixtureNames = ['ascii', 'sgr', 'unicode', 'cursor', 'logs'] as const
export type FixtureName = (typeof fixtureNames)[number]

export const settings = {
  columns: 40,
  rows: 12,
  fontFamily: 'Bench Mono',
  fontSize: 12,
  lineHeight: 1.2,
  dpr: 2,
  viewport: { width: 1600, height: 1400 },
  scrollback: 10_000,
  ghosttyScrollbackBytes: 64 * 1024 * 1024,
  counts: [1, 8, 17],
  repetitions: 3,
  latencySamples: 12,
  burstFrames: 32,
  idleMilliseconds: 1000,
  outputFrames: 60,
  chunkBytes: 4096,
  corpusBytes: 1024 * 1024,
} as const

export interface ComparisonCase {
  variant: Variant
  path: WritePath
  count: number
}

export function fixtureText(name: FixtureName, logs: string): string {
  if (name === 'ascii') return '0123456789 plain ASCII terminal output\r\n'
  if (name === 'sgr')
    return '\x1b[31mred\x1b[0m \x1b[38;2;50;180;240mtruecolor\x1b[0m \x1b[1;4mstyle\x1b[0m\r\n'
  if (name === 'unicode') return '日本語 中文 é café 👩‍💻 👨‍👩‍👧‍👦 🧪\r\n'
  if (name === 'cursor')
    return '\x1b[H\x1b[2Kstatus: redraw\x1b[3;2H\x1b[32mvalue\x1b[0m\x1b[6;1H\x1b[Kprogress 42%\x1b[1;1H'
  return logs.replaceAll('\n', '\r\n')
}

export function corpus(text: string, minimumBytes: number): string {
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes === 0) throw new RangeError('Fixture must contain text')
  return text.repeat(Math.ceil(minimumBytes / bytes))
}

export const spotCheck =
  '\x1b[2J\x1b[HASCII abc 123\r\n\x1b[31mred\x1b[32m green\x1b[0m\r\n' +
  'wide 日本語 é\r\nZWJ 👩‍💻 👨‍👩‍👧‍👦\r\n\x1b[7;1Hoverwrite old\x1b[7;11Hnew\x1b[K'

export const marker = (color: 'red' | 'green') =>
  `\x1b[H\x1b[38;2;${color === 'red' ? '255;0;0' : '0;255;0'}m########\x1b[0m`
