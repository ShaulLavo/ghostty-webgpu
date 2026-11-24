import { afterEach, expect, it, vi } from 'vitest'
import { compileWorkerModules } from './page-modules.js'

// The smallest valid module: magic and version only.
const emptyModule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

function wasmResponse(): Response {
  return new Response(emptyModule, { headers: { 'Content-Type': 'application/wasm' } })
}

// Compiles are shared per URL for the page's lifetime, so every test uses its own host.
function assets() {
  const host = `https://${crypto.randomUUID()}.test`
  return { wasm: `${host}/ghostty-vt.wasm`, bridge: `${host}/bridge.wasm` }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('leaves relative, blob and data asset URLs to the worker', () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(compileWorkerModules({ wasm: './ghostty-vt.wasm', bridge: './bridge.wasm' })).toBe(
    undefined,
  )
  expect(
    compileWorkerModules({ wasm: 'blob:https://host/id', bridge: 'https://host/bridge.wasm' }),
  ).toBe(undefined)
  expect(compileWorkerModules({ wasm: 'https://host/ghostty-vt.wasm', bridge: 'data:,' })).toBe(
    undefined,
  )
  expect(fetch).not.toHaveBeenCalled()
})

it('compiles both absolute assets on the page', async () => {
  const fetch = vi.fn(async (_url: string | URL) => wasmResponse())
  vi.stubGlobal('fetch', fetch)
  const urls = assets()
  const modules = await compileWorkerModules(urls)
  expect(modules?.wasm).toBeInstanceOf(WebAssembly.Module)
  expect(modules?.bridge).toBeInstanceOf(WebAssembly.Module)
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([urls.wasm, urls.bridge])
})

it('shares one download and compile per asset between concurrent workers', async () => {
  const fetch = vi.fn(async (_url: string | URL) => wasmResponse())
  vi.stubGlobal('fetch', fetch)
  const urls = assets()
  const results = await Promise.all([
    compileWorkerModules(urls),
    compileWorkerModules(urls),
    compileWorkerModules(urls),
  ])
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const modules of results) {
    expect(modules?.wasm).toBe(results[0]?.wasm)
    expect(modules?.bridge).toBe(results[0]?.bridge)
  }
})

it('rejects a failed download and downloads again for the next worker', async () => {
  let failBridge = true
  const fetch = vi.fn(async (url: URL) => {
    if (url.pathname.endsWith('bridge.wasm') && failBridge) return new Response('', { status: 503 })
    return wasmResponse()
  })
  vi.stubGlobal('fetch', fetch)
  const urls = assets()
  await expect(compileWorkerModules(urls)).rejects.toThrow('HTTP 503')
  failBridge = false
  const modules = await compileWorkerModules(urls)
  expect(modules?.bridge).toBeInstanceOf(WebAssembly.Module)
  expect(fetch.mock.calls.map(([url]) => url.pathname)).toEqual([
    '/ghostty-vt.wasm',
    '/bridge.wasm',
    '/bridge.wasm',
  ])
})
