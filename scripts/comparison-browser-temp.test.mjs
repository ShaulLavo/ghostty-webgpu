import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareComparisonBrowserTemp } from './comparison-browser-temp.mjs'

test(
  'binds a short Unix socket while retaining browser files in a deep data root',
  {
    skip: process.platform === 'win32' && 'Windows uses named pipes',
  },
  async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'comparison-temp-'))
    const root = join(scratch, 'deep-root-'.repeat(12), 'tmp')
    const server = createServer()
    let temp
    try {
      temp = await prepareComparisonBrowserTemp(root)
      const directory = join(temp.temporary, 'org.chromium.Chromium.abcdef')
      const socket = join(directory, 'SingletonSocket')
      assert.ok(
        Buffer.byteLength(join(root, 'org.chromium.Chromium.abcdef', 'SingletonSocket')) > 108,
      )
      assert.ok(Buffer.byteLength(socket) < 104)
      await mkdir(directory)
      server.listen(socket)
      await once(server, 'listening')
      await writeFile(join(temp.temporary, 'browser-buffer'), 'disk-backed')
      assert.equal(await realpath(temp.temporary), await realpath(temp.directory))
      assert.equal(await readFile(join(temp.directory, 'browser-buffer'), 'utf8'), 'disk-backed')
      await new Promise((resolve) => server.close(resolve))
      await temp.remove()
      await assert.rejects(realpath(temp.temporary), { code: 'ENOENT' })
      await assert.rejects(realpath(temp.directory), { code: 'ENOENT' })
      await temp.remove()
    } finally {
      if (server.listening) await new Promise((resolve) => server.close(resolve))
      await temp?.remove()
      await rm(scratch, { recursive: true, force: true })
    }
  },
)

test('isolates concurrent browser directories and preserves caller data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comparison-isolation-'))
  const originalTmpdir = process.env.TMPDIR
  const temps = []
  try {
    await writeFile(join(root, 'keep'), 'caller')
    temps.push(
      ...(await Promise.all([
        prepareComparisonBrowserTemp(root),
        prepareComparisonBrowserTemp(root),
      ])),
    )
    assert.notEqual(temps[0].directory, temps[1].directory)
    assert.notEqual(temps[0].temporary, temps[1].temporary)
    assert.equal(process.env.TMPDIR, originalTmpdir)
    await temps[0].remove()
    await writeFile(join(temps[1].temporary, 'active'), 'second')
    assert.equal(await readFile(join(temps[1].directory, 'active'), 'utf8'), 'second')
    assert.equal(await readFile(join(root, 'keep'), 'utf8'), 'caller')
  } finally {
    for (const temp of temps) await temp.remove()
    await rm(root, { recursive: true, force: true })
  }
})

test('removes its data directory when IPC setup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comparison-failure-'))
  try {
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'caller')
    await assert.rejects(prepareComparisonBrowserTemp(root, file), { code: 'ENOTDIR' })
    assert.deepEqual(await readdir(root), ['not-a-directory'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
