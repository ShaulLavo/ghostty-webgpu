import { PNG } from 'pngjs'
import { studyCanvases } from './study-qualification.mjs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const root = resolve(process.argv[2])
const results = JSON.parse(await readFile(join(root, 'results.json'), 'utf8'))
await mkdir(join(root, 'pixels'), { recursive: true })
const rows = []
const heatmaps = new Map()
const plasmas = new Map()
for (const run of results.runs) {
  if (run.repetition !== 0 || run.count !== 1 || run.status !== 'complete') continue
  const crop = await readCrop(run, 'ntcharts-heatmap')
  heatmaps.set(run.variant, crop)
  let ink = 0
  for (let index = 0; index < crop.data.length; index += 4)
    if (crop.data[index] || crop.data[index + 1] || crop.data[index + 2]) ink++
  rows.push({
    variant: run.variant,
    width: crop.width,
    height: crop.height,
    coloredPixels: ink,
    pixelCount: crop.width * crop.height,
    sha256: createHash('sha256').update(crop.data).digest('hex'),
  })
  await writeFile(join(root, 'pixels', `${run.variant}-heatmap.png`), PNG.sync.write(crop))
  const plasma = await readCrop(run, 'opentui-plasma')
  plasmas.set(run.variant, plasma)
  await writeFile(join(root, 'pixels', `${run.variant}-plasma.png`), PNG.sync.write(plasma))
}
const checks = { rows }
if (heatmaps.has('ghostty-webgpu') && heatmaps.has('wraith-native')) {
  checks.heatmapDifference = difference(
    heatmaps.get('ghostty-webgpu'),
    heatmaps.get('wraith-native'),
  )
  checks.plasmaInteriors = interiors(plasmas.get('ghostty-webgpu'), plasmas.get('wraith-native'))
}
await writeFile(join(root, 'pixels', 'checks.json'), JSON.stringify(checks, null, 2))
console.log(checks)

async function readCrop(run, fixture) {
  const path = join(root, `${run.variant}-1-${fixture}.png`)
  const png = PNG.sync.read(await readFile(path))
  const canvas = studyCanvases(run.info, run.variant, run.count)[0]
  const crop = new PNG({ width: canvas.width, height: canvas.height })
  const bounds = canvas.bounds ?? { x: 0, y: 0 }
  PNG.bitblt(
    png,
    crop,
    Math.round(bounds.x * run.info.dpr),
    Math.round(bounds.y * run.info.dpr),
    crop.width,
    crop.height,
    0,
    0,
  )
  return crop
}

function channelDifference(a, b, index) {
  return Math.max(
    Math.abs(a[index] - b[index]),
    Math.abs(a[index + 1] - b[index + 1]),
    Math.abs(a[index + 2] - b[index + 2]),
  )
}

function difference(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Crop geometry differs')
  let pixels = 0
  let maxChannelDifference = 0
  for (let index = 0; index < a.data.length; index += 4) {
    const delta = channelDifference(a.data, b.data, index)
    if (delta) pixels++
    maxChannelDifference = Math.max(maxChannelDifference, delta)
  }
  return { pixels, pixelCount: a.width * a.height, maxChannelDifference }
}

function interiors(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Crop geometry differs')
  const width = a.width / 100
  const height = a.height / 30
  let exact = 0
  let maxChannelDifference = 0
  for (let cell = 0; cell < 3000; cell++) {
    for (const offset of [0.25, 0.75]) {
      const x = (cell % 100) * width + Math.floor(width / 2)
      const y = Math.floor(cell / 100) * height + Math.floor(height * offset)
      const delta = channelDifference(a.data, b.data, (y * a.width + x) * 4)
      exact += Number(delta === 0)
      maxChannelDifference = Math.max(maxChannelDifference, delta)
    }
  }
  return { samples: 6000, exact, maxChannelDifference }
}
