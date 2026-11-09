import { expect, test } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'undici'
import { createFrameworkControl } from 'waffle/testing/page-runner/framework'
import { ReportingNodeOwner } from './ios-browser-reporting-owner.ts'

test('real public host returns its original deadline and raw result before outer dispatcher close', async () => {
  const root = await mkdtemp(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), 'ghostty-trace-host-'),
  )
  const previous = process.env.STORAGE_SCRATCH_ROOT
  process.env.STORAGE_SCRATCH_ROOT = root
  const owner = new ReportingNodeOwner()
  let closes = 0
  const host = createFrameworkControl(
    {
      suite: 'CPU ownership only',
      native: { udid: 'not-allocated' },
      expected: [
        {
          file: 'never-imported.ts',
          fullName: 'CPU only',
          sourceKey: 'cpu',
          timeoutMs: 15000,
          retries: 0,
        },
      ],
      scope: { kind: 'root-selection', command: 'test:browser', files: ['never-imported.ts'] },
      resultPath: join(root, 'raw.json'),
    },
    'http://127.0.0.1:1/',
  )
  host.captureTesterTrace({ collectorResponse: async () => 'unchanged' })
  try {
    const result = await host.run((registerClose) =>
      owner.ownExecution(
        Promise.resolve().then(() => {
          owner.ownContext(
            {
              close: async () => {
                closes++
              },
            },
            'actual CPU close callback',
          )
          registerClose(owner.closeContext)
          void host.abort('CPU control without browser allocation')
          return { status: 'passed' }
        }),
        'actual public host callback',
      ),
    )
    const bytes = JSON.stringify(result)
    const ownership = await owner.finish(result)
    expect(result.exit).toBe(2)
    expect(result.trace.status).toBe('incomplete')
    expect(result.cleanup.session.status).toBe('not-created')
    expect(result.cleanup.context.status).toBe('confirmed')
    expect(result.cleanupDeadlineAt).toBeGreaterThan(performance.now())
    expect(closes).toBe(1)
    expect(ownership.status).toBe('confirmed')
    expect(JSON.stringify(result)).toBe(bytes)
    expect(await readdir(root)).toEqual(['raw.json'])
    if (process.env.GHOSTTY_REPORTING_EVIDENCE)
      await writeFile(
        join(process.env.GHOSTTY_REPORTING_EVIDENCE, 'cpu-sdk-and-owner.json'),
        JSON.stringify({ raw: result, ownership, nativeCredit: false }, null, 2),
      )
  } finally {
    if (previous === undefined) delete process.env.STORAGE_SCRATCH_ROOT
    else process.env.STORAGE_SCRATCH_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('actual dispatcher serves loopback DELETE until the host boundary and physically closes afterward', async () => {
  const server = createServer((req, res) => {
    res.end(req.method)
  })
  const owner = new ReportingNodeOwner()
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing loopback port')
    const deletion = owner.ownExecution(
      request(`http://127.0.0.1:${address.port}/cpu-only-resource`, { method: 'DELETE' }).then(
        async (response) => {
          expect(await response.body.text()).toBe('DELETE')
        },
      ),
      'actual loopback DELETE, not native',
    )
    await deletion
    const { createFrameworkControl: create } = await import('waffle/testing/page-runner/framework')
    const root = await mkdtemp(join(tmpdir(), 'ghostty-trace-delete-'))
    try {
      const host = create(
        {
          suite: 'CPU no allocation',
          native: { udid: 'not-allocated' },
          expected: [
            {
              file: 'never-imported.ts',
              fullName: 'CPU only',
              sourceKey: 'cpu',
              timeoutMs: 15000,
              retries: 0,
            },
          ],
          scope: { kind: 'root-selection', command: 'test:browser', files: ['never-imported.ts'] },
          resultPath: join(root, 'result.json'),
        },
        'http://127.0.0.1:1/',
      )
      const result = await host.abort('No browser')
      expect((await owner.finish(result)).status).toBe('confirmed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
