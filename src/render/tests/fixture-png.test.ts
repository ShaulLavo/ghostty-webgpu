import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { decodePngFixture } from './fixture-png.js'

it('decodes all native sprite PNGs to their original RGBA bytes without Canvas readback', async () => {
  const hash = createHash('sha256')
  for (let index = 0; index < 37; index++) {
    const bytes = await readFile(
      new URL(`../shared/atlas/sprite-fixtures/case-${index}.png`, import.meta.url),
    )
    const image = await decodePngFixture(bytes)
    expect(image.data.length).toBe(image.width * image.height * 4)
    hash.update(image.data)
  }
  // Independent Pillow RGBA decode of the unchanged native fixtures, in manifest order.
  expect(hash.digest('hex')).toBe(
    'bec79bf2acfd7ff527e5f9cb4e6eb2a551d6896fc37160611aebf44e1f78ee5c',
  )
})

it('rejects malformed PNG fixtures', async () => {
  await expect(decodePngFixture(new Uint8Array([1, 2, 3]))).rejects.toThrow()
})
