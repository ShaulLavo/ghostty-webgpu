export const variants = [
  { id: 'ghostty-webgpu', library: 'ghostty-webgpu', renderer: 'webgpu' },
  { id: 'ghostty-webgl', library: 'ghostty-webgpu', renderer: 'webgl2' },
  { id: 'ghostty-canvas', library: 'ghostty-webgpu', renderer: 'canvas2d' },
  { id: 'ghostty-dom', library: 'ghostty-webgpu', renderer: 'dom' },
  { id: 'xterm-webgl', library: '@xterm/xterm', renderer: 'webgl' },
  { id: 'xterm-dom', library: '@xterm/xterm', renderer: 'dom' },
  { id: 'ghostty-web', library: 'ghostty-web', renderer: 'canvas2d' },
] as const

export type Variant = (typeof variants)[number]['id']
export type WritePath = 'bytes' | 'string'
export const fixtureNames = [
  'ascii',
  'sgr',
  'unicode',
  'cursor',
  'logs',
  'rolling-logs',
  'rolling-unicode-logs',
] as const
export type RollingFixtureName = 'rolling-logs' | 'rolling-unicode-logs'
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
  repetitions: 4,
  latencySamples: 240,
  presentationDrainMilliseconds: 100,
  presentationValidationSamples: 24,
  presentationValidationDelayFrames: 1,
  macIdleLoadAverage: 4,
  gpuIdleUtilizationPercent: 5,
  gpuWindowUtilizationPercent: 80,
  gpuComputeMemoryMiB: 1024,
  gpuSampleMilliseconds: 250,
  gpuMeasuredSampleMilliseconds: 1000,
  gpuIdleConsecutiveSamples: 3,
  gpuIdleWaitMilliseconds: 30_000,
  gpuCommandTimeoutMilliseconds: 2000,
  gpuTraceCommandTimeoutMilliseconds: 10_000,
  adapterAttempts: 3,
  adapterRetryMilliseconds: 100,
  burstFrames: 32,
  idleMilliseconds: 1000,
  outputFrames: 2700,
  minimumCpuTicks: 100,
  caseDeadlineMilliseconds: 10 * 60_000,
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
  if (name === 'rolling-unicode-logs') return unicodePromptLogs(logs).replaceAll('\n', '\r\n')
  return logs.replaceAll('\n', '\r\n')
}

export function unicodePromptLogs(logs: string): string {
  return logs
    .split('\n')
    .map((line, index) => {
      const lines = [line]
      if ((index + 1) % 4 === 0) lines.push('❯ git log --oneline')
      if ((index + 1) % 16 === 0) lines.push('┌─ 状態: 日本語 中文 ─┐')
      return lines.join('\n')
    })
    .join('\n')
}

export function corpus(text: string, minimumBytes: number): string {
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes === 0) throw new RangeError('Fixture must contain text')
  return text.repeat(Math.ceil(minimumBytes / bytes))
}

export interface RollingFixture {
  bytes: Uint8Array
  chunks: readonly Uint8Array[]
}

export function rollingFixture(
  logs: string,
  minimumBytes: number = settings.corpusBytes,
  chunkBytes: number = settings.chunkBytes,
  name: RollingFixtureName = 'rolling-logs',
): RollingFixture {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 4)
    throw new RangeError('Rolling chunk size must fit a UTF-8 codepoint')
  const bytes = new TextEncoder().encode(corpus(fixtureText(name, logs), minimumBytes))
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(offset + chunkBytes, bytes.length)
    // Each frame ends between codepoints, so string and byte paths deliver identical bytes.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    chunks.push(bytes.subarray(offset, end))
    offset = end
  }
  return { bytes, chunks }
}

export function rollingInputs(
  fixture: RollingFixture,
  path: WritePath,
): readonly (string | Uint8Array)[] {
  if (path === 'bytes') return fixture.chunks
  const decoder = new TextDecoder('utf-8', { fatal: true })
  return fixture.chunks.map((chunk) => decoder.decode(chunk))
}

export function rollingByteCount(fixture: RollingFixture, frames: number): number {
  const cycles = Math.floor(frames / fixture.chunks.length)
  const remainder = frames % fixture.chunks.length
  return (
    cycles * fixture.bytes.length +
    fixture.chunks.slice(0, remainder).reduce((total, chunk) => total + chunk.length, 0)
  )
}

export const spotCheck =
  '\x1b[2J\x1b[HASCII abc 123\r\n\x1b[31mred\x1b[32m green\x1b[0m\r\n' +
  'wide 日本語 é\r\nZWJ 👩‍💻 👨‍👩‍👧‍👦\r\n\x1b[7;1Hoverwrite old\x1b[7;11Hnew\x1b[K'

export const marker = (color: 'red' | 'green') =>
  `\x1b[H\x1b[38;2;${color === 'red' ? '255;0;0' : '0;255;0'}m########\x1b[0m`
