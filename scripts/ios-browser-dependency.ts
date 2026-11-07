import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const frameworkRelease = Object.freeze({
  version: '0.0.111',
  source: '96acfb246bb565cd008ad498e08230829c3a773a',
  url: 'https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.111/waffle-0.0.111.tgz',
  bytes: 3000013,
  sha256: '072f38c510b0044ab396f3f532a561a7a985527e72634e8bba031c34e86f072b',
})

export async function checkFrameworkArchive(path: string): Promise<void> {
  const bytes = await readFile(path)
  if (
    bytes.byteLength !== frameworkRelease.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== frameworkRelease.sha256
  )
    throw new Error('Expected the published Waffle 0.0.111 runtime archive')
}
