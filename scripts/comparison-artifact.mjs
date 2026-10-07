import { parseChunked, stringifyChunked } from '@discoveryjs/json-ext'
import { createReadStream, createWriteStream } from 'node:fs'
import { appendFile, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

function requireCompleteRoot(_parsed, chunk, _pending, state) {
  // The parser can return a partial container at EOF; require its completed-root count.
  if (chunk !== null || state.rootValuesCount === 1) return
  throw new SyntaxError(
    `JSON stream ended with ${state.rootValuesCount} complete root values; expected one.`,
  )
}

export async function readComparisonArtifact(path, { gzip = false } = {}) {
  const decoded = gzip ? createGunzip() : new PassThrough()
  const transfer = pipeline(createReadStream(path), decoded)
  try {
    const [artifact] = await Promise.all([
      parseChunked(decoded, { onChunk: requireCompleteRoot }),
      transfer,
    ])
    return artifact
  } finally {
    decoded.destroy()
    await transfer.catch(() => {})
  }
}

export async function writeComparisonArtifact(path, artifact) {
  const temporary = await mkdtemp(join(dirname(path), '.comparison-json-'))
  try {
    const output = join(temporary, 'artifact.json')
    await pipeline(
      Readable.from(stringifyChunked(artifact, null, 2), { objectMode: false }),
      createWriteStream(output),
    )
    await appendFile(output, '\n')
    await rename(output, path)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
