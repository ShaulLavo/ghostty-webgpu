// Packs the ghostty.org home animation into one gzipped asset.
// Usage: bun site/scripts/pack-ghost-frames.ts <path-to-website-repo>
// Source: https://github.com/ghostty-org/website (MIT), terminals/home/animation_frames.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const GLOW_START = String.fromCharCode(1)
const GLOW_END = String.fromCharCode(2)
const FRAME_SEPARATOR = String.fromCharCode(12)
const MARKERS = new RegExp(`[${GLOW_START}${GLOW_END}]`, 'g')

const websiteRoot = process.argv[2]
if (!websiteRoot) throw new Error('Pass the path to a checkout of ghostty-org/website')
const framesDir = join(websiteRoot, 'terminals/home/animation_frames')
const outFile = fileURLToPath(new URL('../ghost-frames.txt.gz', import.meta.url))

const names = (await readdir(framesDir)).filter((name) => name.endsWith('.txt')).sort()
const frames: string[][] = []
for (const name of names) {
  const html = await readFile(join(framesDir, name), 'utf8')
  const lines = html
    .replace(/<span class="b">/g, GLOW_START)
    .replace(/<\/span>/g, GLOW_END)
    .replace(/<[^>]+>/g, '')
    .split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  frames.push(lines)
}

function visible(line: string): string {
  return line.replace(MARKERS, '')
}

let left = Number.POSITIVE_INFINITY
let right = 0
for (const frame of frames) {
  for (const line of frame) {
    const text = visible(line)
    if (text.trim() === '') continue
    left = Math.min(left, text.length - text.trimStart().length)
    right = Math.max(right, text.trimEnd().length)
  }
}

function trimLine(line: string): string {
  // Drop `left` visible columns from the start while keeping the markers.
  let out = ''
  let seen = 0
  for (const char of line) {
    if (char === GLOW_START || char === GLOW_END) {
      out += char
      continue
    }
    seen += 1
    if (seen > left) out += char
  }
  return out.trimEnd()
}

const width = right - left
const rows = Math.max(...frames.map((frame) => frame.length))
const header = `${width} ${rows} ${frames.length}\n`
const body = frames.map((frame) => frame.map(trimLine).join('\n')).join(FRAME_SEPARATOR)
const packed = gzipSync(Buffer.from(header + body, 'utf8'), { level: 9 })
await Bun.write(outFile, packed)
console.log(`${frames.length} frames, ${width}x${rows}, ${packed.byteLength} bytes gzipped`)
