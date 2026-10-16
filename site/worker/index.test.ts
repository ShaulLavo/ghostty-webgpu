import { expect, test } from 'bun:test'
import worker, { type Env } from './index'

const page =
  '<!doctype html><html lang="en"><body><script type="text/plain" id="scene-frame"></script></body></html>'
const scenes = [
  { name: 'tokyo-rain', theme: { ground: '#07060d', accent: '#ffc65e' } },
  { name: 'kyoto-dusk', theme: { ground: '#0b0a16', accent: '#e28fab' } },
]
const frame = '#07060d,#ffc65e|.oO\n O|01<>'

interface Stub extends Env {
  readonly seen: string[]
}

type Read = (input: Request | URL | string) => Promise<Response>

/** The built files, with an ETag on the page as Static Assets sends one; `fail` lists paths whose reads fail. */
function assets(fail: Record<string, number> = {}, frameText = frame): Stub {
  const seen: string[] = []
  const read: Read = async (input) => {
    const request = input instanceof Request ? input : new Request(input)
    const { pathname } = new URL(request.url)
    seen.push(pathname)
    if ((fail[pathname] ?? 0) > 0) {
      fail[pathname]! -= 1
      throw new TypeError('asset read failed')
    }
    if (pathname === '/scenes/index.json') return Response.json(scenes)
    if (pathname.startsWith('/scenes/')) return new Response(frameText)
    if (request.headers.get('if-none-match') === '"page"')
      return new Response(null, { status: 304 })
    return new Response(page, { headers: { 'content-type': 'text/html', etag: '"page"' } })
  }
  return { seen, ASSETS: { fetch: read } }
}

test('a revalidation gets the page written for this visit, with no file validator', async () => {
  const env = assets()
  const response = await worker.fetch(
    new Request('https://ghostty.test/?scene=kyoto-dusk', {
      headers: { 'if-none-match': '"page"' },
    }),
    env,
  )
  const html = await response.text()
  expect(response.status).toBe(200)
  expect(response.headers.get('etag')).toBeNull()
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(html).toContain('data-scene="kyoto-dusk"')
  expect(response.headers.get('set-cookie')).toStartWith('scene=kyoto-dusk;')
  expect(html).toContain(`id="scene-frame">${frame}</script>`)
})

test('other pages keep the cookie scene', async () => {
  const response = await worker.fetch(
    new Request('https://ghostty.test/docs/', { headers: { cookie: 'scene=tokyo-rain' } }),
    assets(),
  )
  expect(await response.text()).toContain('data-scene="tokyo-rain"')
})

test('a failed scene list leaves the page as built, and the next page reads it again', async () => {
  const env = assets({ '/scenes/index.json': 1 })
  const first = await worker.fetch(new Request('https://ghostty.test/?scene=tokyo-rain'), env)
  expect(first.status).toBe(200)
  expect(await first.text()).not.toContain('data-scene')
  const second = await worker.fetch(new Request('https://ghostty.test/?scene=tokyo-rain'), env)
  expect(await second.text()).toContain('data-scene="tokyo-rain"')
  expect(env.seen.filter((path) => path === '/scenes/index.json')).toHaveLength(2)
})

test('a frame outside the baked alphabet is left out', async () => {
  const response = await worker.fetch(
    new Request('https://ghostty.test/?scene=tokyo-rain'),
    assets({}, '</script><script>alert(1)</script>'),
  )
  expect(await response.text()).toContain('id="scene-frame"></script>')
})

test('files pass through untouched', async () => {
  const wasm: Env = {
    ASSETS: {
      fetch: async () =>
        new Response('wasm', { headers: { 'content-type': 'application/wasm', etag: '"w"' } }),
    },
  }
  const response = await worker.fetch(new Request('https://ghostty.test/x.wasm'), wasm)
  expect(response.headers.get('etag')).toBe('"w"')
})
