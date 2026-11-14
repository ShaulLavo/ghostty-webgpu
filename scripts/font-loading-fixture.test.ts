import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { expect, test, type TestContext } from 'vitest'
import { fontLoadingFixture } from './font-loading-fixture.ts'

type Middleware = (request: IncomingMessage, response: ServerResponse, next: () => void) => void
const prefix = '/__ghostty_font_loading__/'
const font = readFileSync(
  new URL('../src/dom/tests/fixtures/font-resource/before.woff2', import.meta.url),
)

async function start(context: TestContext) {
  const fixture = fontLoadingFixture()
  let middleware: Middleware | undefined
  assert.ok(typeof fixture.configureServer === 'function')
  Reflect.apply(fixture.configureServer, undefined, [
    {
      middlewares: {
        use(value: Middleware) {
          middleware = value
        },
      },
    },
  ])
  const waiting = new Map<string, ReturnType<typeof Promise.withResolvers<ServerResponse>>>()
  const clients = new Set<ReturnType<typeof request>>()
  const server = createServer((request, response) => {
    assert.ok(middleware)
    middleware(request, response, () => response.writeHead(404).end())
    const path = request.url ?? ''
    waiting.get(path)?.resolve(response)
    waiting.delete(path)
  })
  function closeFixture() {
    assert.ok(typeof fixture.closeBundle === 'function')
    Reflect.apply(fixture.closeBundle, undefined, [])
  }
  context.onTestFinished(async () => {
    closeFixture()
    for (const client of clients) client.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`

  async function send(path: string, method = 'GET') {
    const response = await fetch(`${origin}${path}`, { method })
    const bytes = Buffer.from(await response.arrayBuffer())
    return { status: response.status, bytes, headers: response.headers }
  }
  async function held(key: string) {
    const path = `${prefix}${key}`
    const seen = Promise.withResolvers<ServerResponse>()
    waiting.set(path, seen)
    const client = request(`${origin}${path}`)
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('error', () => {})
    const finished = Promise.withResolvers<Buffer>()
    client.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => finished.resolve(Buffer.concat(chunks)))
    })
    client.end()
    return { client, response: await seen.promise, finished: finished.promise }
  }
  return {
    send,
    held,
    closeFixture,
    control: (key: string, method: string) => send(`${prefix}${key}?control`, method),
  }
}

test('holds the real font response until release and removes the gate', async (context) => {
  const fixture = await start(context)
  expect((await fixture.control('success', 'POST')).status).toBe(204)
  const held = await fixture.held('success')
  expect(held.response.headersSent).toBe(false)
  expect(held.response.writableEnded).toBe(false)
  expect((await fixture.control('success', 'DELETE')).status).toBe(204)
  expect(await held.finished).toEqual(font)
  expect((await fixture.send(`${prefix}success`)).status).toBe(404)
  expect((await fixture.control('success', 'DELETE')).status).toBe(204)
})

test('removes an armed gate when setup is cancelled before GET', async (context) => {
  const fixture = await start(context)
  await fixture.control('cancelled', 'POST')
  await fixture.control('cancelled', 'DELETE')
  expect((await fixture.send(`${prefix}cancelled`)).status).toBe(404)
})

test('removes an armed gate when the held font request is aborted', async (context) => {
  const fixture = await start(context)
  await fixture.control('aborted', 'POST')
  const held = await fixture.held('aborted')
  const closed = once(held.response, 'close')
  held.client.destroy()
  await closed
  expect((await fixture.send(`${prefix}aborted`)).status).toBe(404)
})

test('rejects duplicate arms without orphaning the first response', async (context) => {
  const fixture = await start(context)
  await fixture.control('duplicate', 'POST')
  const held = await fixture.held('duplicate')
  expect((await fixture.control('duplicate', 'POST')).status).toBe(409)
  await fixture.control('duplicate', 'DELETE')
  expect(await held.finished).toEqual(font)
})

test('shutdown releases held responses and removes unused arms', async (context) => {
  const fixture = await start(context)
  await fixture.control('held', 'POST')
  await fixture.control('unused', 'POST')
  const held = await fixture.held('held')
  expect((await fixture.control('held', 'POST')).status).toBe(409)
  fixture.closeFixture()
  expect(await held.finished).toEqual(font)
  expect((await fixture.send(`${prefix}held`)).status).toBe(404)
  expect((await fixture.send(`${prefix}unused`)).status).toBe(404)
})

test('late response cleanup preserves a newly armed gate at the same path', async (context) => {
  const fixture = await start(context)
  await fixture.control('reused', 'POST')
  const old = await fixture.held('reused')
  const cleanup = old.response.listeners('close')
  await fixture.control('reused', 'DELETE')
  expect(await old.finished).toEqual(font)
  await fixture.control('reused', 'POST')
  for (const listener of cleanup) Reflect.apply(listener, old.response, [])
  const current = await fixture.held('reused')
  expect(current.response.headersSent).toBe(false)
  await fixture.control('reused', 'DELETE')
  expect(await current.finished).toEqual(font)
})

test('validates control methods, query markers and gate names', async (context) => {
  const fixture = await start(context)
  const invalid = [
    ['POST', `${prefix}invalid`],
    ['DELETE', `${prefix}invalid?wrong`],
    ['GET', `${prefix}invalid?control`],
    ['PUT', `${prefix}invalid?control`],
    ['POST', `${prefix}invalid?control=1`],
    ['POST', `${prefix}invalid?control&extra`],
    ['POST', `${prefix}?control`],
    ['POST', `${prefix}nested/path?control`],
    ['POST', `${prefix}${'a'.repeat(129)}?control`],
  ]
  for (const [method, path] of invalid) {
    assert.ok(method && path)
    expect((await fixture.send(path, method)).status).toBe(400)
  }
  expect((await fixture.send(`${prefix}invalid`)).status).toBe(404)
  expect((await fixture.send('/outside-font-fixture')).status).toBe(404)
  expect((await fixture.control('valid-name_1', 'POST')).headers.get('Cache-Control')).toBe(
    'no-store',
  )
  await fixture.control('valid-name_1', 'DELETE')
})
