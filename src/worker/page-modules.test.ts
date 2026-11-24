import { afterEach, expect, it, vi } from 'vitest'
import { compileWorkerModules } from './page-modules.js'

// The smallest valid module: magic and version only.
const emptyModule = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

function wasmResponse(): Response {
  return new Response(emptyModule, { headers: { 'Content-Type': 'application/wasm' } })
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
  const fetch = vi.fn(async () => wasmResponse())
  vi.stubGlobal('fetch', fetch)
  const modules = await compileWorkerModules({
    wasm: 'https://host/ghostty-vt.wasm',
    bridge: 'https://host/bridge.wasm',
  })
  expect(modules?.wasm).toBeInstanceOf(WebAssembly.Module)
  expect(modules?.bridge).toBeInstanceOf(WebAssembly.Module)
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    'https://host/ghostty-vt.wasm',
    'https://host/bridge.wasm',
  ])
})

it('rejects when either download fails so the worker fetches the assets itself', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL) =>
      url.pathname.endsWith('bridge.wasm') ? new Response('', { status: 503 }) : wasmResponse(),
    ),
  )
  await expect(
    compileWorkerModules({
      wasm: 'https://host/ghostty-vt.wasm',
      bridge: 'https://host/bridge.wasm',
    }),
  ).rejects.toThrow('HTTP 503')
})
