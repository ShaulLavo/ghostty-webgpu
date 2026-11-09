import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const frameworkRelease = Object.freeze({
  version: '0.0.114',
  hostInterface: 2,
  integrity:
    'sha512-Jr0R1489EeEACWOTENmPfkS1tjxxezsxiS4tpPZ3VfN7T7u6fFd3kHjrojLcy5k0V8teFI0NPJR3Bu09DAcnCg==',
  source: '341bf1452d98e280a5c718af2775a839ff4042fa',
  url: 'https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.114/waffle-0.0.114.tgz',
  bytes: 3580810,
  sha256: '84a624f85f6843449ca2c96c113cb9609e8f4df634df17082e46246413f8245e',
})

export async function checkFrameworkArchive(path: string): Promise<void> {
  const bytes = await readFile(path)
  if (
    bytes.byteLength !== frameworkRelease.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== frameworkRelease.sha256
  )
    throw new Error('Expected the published Waffle 0.0.114 runtime archive')
}
