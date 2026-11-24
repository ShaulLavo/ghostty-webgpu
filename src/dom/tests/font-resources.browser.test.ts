import { expect, it, vi } from 'vitest'
import { observeFontResources } from '../font-resources.js'

const resource = new URL('./fixtures/font-resource/replacement.woff2', import.meta.url).href

async function settle(): Promise<void> {
  await document.fonts.ready
  await new Promise(requestAnimationFrame)
  await new Promise(requestAnimationFrame)
}

it.each(['dispose', 'family-change'] as const)(
  'retires a pending font refresh after %s',
  async (retire) => {
    const family = `PendingResource-${retire}`
    let requested = family
    const lifecycle = new AbortController()
    const events = new AbortController()
    const refresh = vi.fn()
    // Hold the font response so the load is still pending when the loading event arrives.
    const barrier = `/__ghostty_font_loading__/${crypto.randomUUID()}`
    const control = `${barrier}?control`
    expect((await fetch(control, { method: 'POST' })).ok).toBe(true)
    const face = new FontFace(family, `url("${barrier}")`)
    observeFontResources({
      fonts: document.fonts,
      family: () => requested,
      refresh,
      signal: lifecycle.signal,
    })
    const loading = Promise.withResolvers<void>()
    const started = vi.fn(() => {
      expect(face.status).toBe('loading')
      if (retire === 'dispose') lifecycle.abort()
      if (retire === 'family-change') requested = 'UnrelatedResource'
      loading.resolve()
    })
    document.fonts.addEventListener('loading', started, { signal: events.signal, once: true })
    try {
      document.fonts.add(face)
      const loaded = face.load()
      await loading.promise
      // The loading event can precede the request; releasing an unseen gate would 404 it.
      await expect.poll(async () => (await fetch(`${barrier}?waiting`)).json()).toBe(true)
      expect((await fetch(control, { method: 'DELETE' })).ok).toBe(true)
      await loaded
      await settle()
      expect(started).toHaveBeenCalledOnce()
      expect(refresh).not.toHaveBeenCalled()
    } finally {
      await fetch(control, { method: 'DELETE' })
      lifecycle.abort()
      events.abort()
      document.fonts.delete(face)
    }
  },
)

it('refreshes a failed matching load when completion events are missing', async () => {
  const lifecycle = new AbortController()
  const events = new AbortController()
  const family = 'FailedResource'
  const refresh = vi.fn()
  const suppress = (event: Event) => event.stopImmediatePropagation()
  document.fonts.addEventListener('loadingdone', suppress, { signal: events.signal })
  document.fonts.addEventListener('loadingerror', suppress, { signal: events.signal })
  const face = new FontFace(family, 'url(data:font/woff2;base64,AAECAw==)')
  observeFontResources({
    fonts: document.fonts,
    family: () => family,
    refresh,
    signal: lifecycle.signal,
  })
  try {
    document.fonts.add(face)
    await expect(face.load()).rejects.toThrow()
    await settle()
    expect(face.status).toBe('error')
    expect(refresh).toHaveBeenCalledOnce()
  } finally {
    lifecycle.abort()
    events.abort()
    document.fonts.delete(face)
  }
})

it('recognizes a cached face that settled before its loading event was delivered', async () => {
  const lifecycle = new AbortController()
  const family = 'CachedResource'
  const face = new FontFace(family, `url("${resource}")`)
  const refresh = vi.fn()
  observeFontResources({
    fonts: document.fonts,
    family: () => family,
    refresh,
    signal: lifecycle.signal,
  })
  try {
    // Safari can deliver a cached start event after this load has resolved.
    await face.load()
    document.fonts.add(face)
    document.fonts.dispatchEvent(new Event('loading'))
    await settle()
    expect(refresh).toHaveBeenCalledOnce()
    document.fonts.dispatchEvent(new Event('loading'))
    await settle()
    expect(refresh).toHaveBeenCalledOnce()
  } finally {
    lifecycle.abort()
    document.fonts.delete(face)
  }
})

it('does not rediscover a known family after an ordinary family change', async () => {
  const lifecycle = new AbortController()
  const face = new FontFace('KnownResource', `url("${resource}")`)
  const unrelated = new FontFace('OtherResource', `url("${resource}")`)
  let requested = 'InitialResource'
  const refresh = vi.fn()
  try {
    document.fonts.add(await face.load())
    observeFontResources({
      fonts: document.fonts,
      family: () => requested,
      refresh,
      signal: lifecycle.signal,
    })
    requested = face.family
    document.fonts.add(await unrelated.load())
    document.fonts.dispatchEvent(new Event('loading'))
    await settle()
    expect(refresh).not.toHaveBeenCalled()
  } finally {
    lifecycle.abort()
    document.fonts.delete(face)
    document.fonts.delete(unrelated)
  }
})
