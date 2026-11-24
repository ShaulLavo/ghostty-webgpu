import { expect, it, onTestFinished, vi } from 'vitest'
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
    const face = new FontFace(family, `url("${barrier}")`)
    expect((await fetch(control, { method: 'POST' })).ok).toBe(true)
    // Vitest runs this after a timeout too; DOM teardown goes first so a failed release cannot skip it.
    onTestFinished(async () => {
      lifecycle.abort()
      events.abort()
      document.fonts.delete(face)
      await fetch(control, { method: 'DELETE' })
    })
    observeFontResources({
      fonts: document.fonts,
      family: () => requested,
      refresh,
      signal: lifecycle.signal,
    })
    const started = new Promise<FontFaceLoadStatus>((resolve) => {
      const retireOnLoading = () => {
        const status = face.status
        if (retire === 'dispose') lifecycle.abort()
        if (retire === 'family-change') requested = 'UnrelatedResource'
        resolve(status)
      }
      document.fonts.addEventListener('loading', retireOnLoading, {
        signal: events.signal,
        once: true,
      })
    })
    document.fonts.add(face)
    const loaded = face.load()
    expect(await started).toBe('loading')
    // The loading event can precede the request; releasing an unseen gate would 404 it.
    await expect.poll(async () => (await fetch(`${barrier}?waiting`)).json()).toBe(true)
    expect((await fetch(control, { method: 'DELETE' })).ok).toBe(true)
    await loaded
    await settle()
    expect(refresh).not.toHaveBeenCalled()
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
