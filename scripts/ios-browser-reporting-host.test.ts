import { expect, test } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FrameworkHost } from 'waffle/testing/page-runner/framework'
import { createFrameworkControl } from 'waffle/testing/page-runner/framework'
import { runFrameworkNode } from './ios-browser-node.ts'

// Actual HostConsumers callback ownership, not an injected page fetch or native session.
test('bounded heartbeat failure reaches the host while an owned provider callback stays held', async () => {
  const root = await mkdtemp(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), 'ghostty-reporting-host-'),
  )
  const previous = process.env.STORAGE_SCRATCH_ROOT
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  let task: ReturnType<ReturnType<typeof createFrameworkControl>['run']> | undefined
  let settled = false
  let html = ''
  let host: ReturnType<typeof createFrameworkControl> | undefined
  const server = createServer((request, response) => {
    if (!host) {
      response.writeHead(503)
      response.end()
      return
    }
    host.middleware(request, response, () => {
      response.writeHead(404)
      response.end()
    })
  })
  process.env.STORAGE_SCRATCH_ROOT = root
  try {
    await runFrameworkNode(async () => {
      server.listen(19764, '127.0.0.1')
      await once(server, 'listening')
      host = createFrameworkControl(
        {
          suite: 'ghostty-owned-callback-control',
          native: { udid: 'not-allocated' },
          expected: [
            {
              file: 'synthetic-never-run.ts',
              fullName: 'not a browser lifecycle proof',
              sourceKey: 'synthetic-only',
              timeoutMs: 15000,
              retries: 0,
            },
          ],
          scope: {
            kind: 'root-selection',
            command: 'test:browser',
            files: ['synthetic-never-run.ts'],
          },
          resultPath: join(root, 'result.json'),
        },
        'http://127.0.0.1:19764/',
      )
      task = host.run((registerClose) => ownedExecution(host, registerClose))
      void task.then(markSettled, markSettled)
      await entered.promise
      const config = configuration(html)
      const doc = randomUUID()
      const hello = await fetch('http://127.0.0.1:19764/report', {
        method: 'POST',
        body: JSON.stringify({
          ...config,
          doc,
          seq: 0,
          kind: 'hello',
          role: 'orchestrator',
          url: 'http://127.0.0.1:19764/owned',
        }),
      })
      expect(hello.status).toBe(200)
      expect(await hello.json()).toEqual({ ackedThrough: 0 })
      const response = await fetch('http://127.0.0.1:19764/heartbeat', {
        method: 'POST',
        body: JSON.stringify({
          ...config,
          doc,
          kind: 'heartbeat',
          role: 'orchestrator',
          failure: 'capacity',
        }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ kind: 'cancelled' })
      await closing.promise
      const scratch = (await readdir(root)).filter((name) => name.startsWith('waffle-framework-'))
      expect(scratch).toHaveLength(1)
      expect(settled).toBe(false)
      expect((await stat(join(root, scratch[0] ?? 'missing'))).isDirectory()).toBe(true)
      release.resolve()
      const result = await task
      expect(result.exit).toBe(2)
      expect(
        result.failures.some(
          (item) => item.category === 'page-reporting' && item.detail === 'capacity',
        ),
      ).toBe(true)
      expect(result.cleanup.callbacks.status).toBe('confirmed')
      expect(result.cleanup.scratch.status).toBe('confirmed')
      expect(result.fileComplete).toBe(false)
      expect((await readdir(root)).some((name) => name.startsWith('waffle-framework-'))).toBe(false)
      const evidence = process.env.GHOSTTY_REPORTING_EVIDENCE
      if (evidence)
        await writeFile(
          join(evidence, 'host-root.json'),
          JSON.stringify(
            {
              result,
              closedBeforeHeldCallbackReleased: true,
              scratchRetainedWhileCallbackHeld: true,
              nativeCredit: false,
            },
            null,
            2,
          ),
        )
    })
  } finally {
    release.resolve()
    await task?.catch(() => {})
    server.closeAllConnections()
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    if (previous === undefined) delete process.env.STORAGE_SCRATCH_ROOT
    else process.env.STORAGE_SCRATCH_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
  function markSettled(): void {
    settled = true
  }
  async function ownedExecution(
    actual: FrameworkHost | undefined,
    registerClose: Parameters<Parameters<FrameworkHost['run']>[0]>[0],
  ) {
    if (!actual) throw new Error('Missing actual host')
    registerClose(async () => {
      closing.resolve()
    })
    html = actual.instrumentDocument({
      kind: 'orchestrator',
      url: 'http://127.0.0.1:19764/owned',
      html: '<html><head></head><body></body></html>',
    })
    await actual.provider('framework-cleanup', async () => {
      entered.resolve()
      await release.promise
    })
    return { status: 'passed' as const }
  }
}, 15000)

function configuration(html: string): { run: string; token: string } {
  const match = /window\.__waffleFrameworkConfiguration=(.*?);\n/.exec(html)
  const value: unknown = JSON.parse(match?.[1] ?? 'null')
  if (
    !value ||
    typeof value !== 'object' ||
    !('run' in value) ||
    typeof value.run !== 'string' ||
    !('token' in value) ||
    typeof value.token !== 'string'
  )
    throw new Error('Actual installed host configuration missing')
  return { run: value.run, token: value.token }
}
