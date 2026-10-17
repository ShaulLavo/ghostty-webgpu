/*
 * The site's Worker: serves the built files and writes the visitor's scene into each page, so the first paint already
 * has the scene's colours, and the landing page's hero its first frame. The landing page draws a new scene each
 * visit; other pages keep the visitor's scene through a session cookie. ?scene=name pins one anywhere. When the scene
 * files cannot be read, the page goes out as built and picks its scene in the browser.
 */

interface Fetcher {
  fetch(input: Request | URL | string): Promise<Response>
}

interface Element {
  setAttribute(name: string, value: string): void
  setInnerContent(content: string, options?: { html: boolean }): void
}

declare class HTMLRewriter {
  on(selector: string, handlers: { element(element: Element): void }): HTMLRewriter
  transform(response: Response): Response
}

export interface Env {
  readonly ASSETS: Fetcher
}

interface Scene {
  readonly name: string
  readonly label: string
  readonly theme: Readonly<Record<string, string>>
}

// A baked frame holds palette hex, dots, separators and colour indices from '0' to 'o': never the / that ends a tag.
const FRAME = /^[#,|\n .0-o]*$/
const VALIDATORS = ['if-none-match', 'if-modified-since'] as const

/** The scene list, read from the built files for each page; a failed read leaves that page as built. */
async function sceneList(env: Env, origin: URL): Promise<Scene[] | undefined> {
  const response = await env.ASSETS.fetch(new URL('/scenes/index.json', origin)).catch(
    () => undefined,
  )
  if (!response?.ok) return undefined
  const list = (await response.json().catch(() => undefined)) as Scene[] | undefined
  return Array.isArray(list) && list.length > 0 ? list : undefined
}

async function sceneFrame(env: Env, origin: URL, name: string): Promise<string> {
  const response = await env.ASSETS.fetch(new URL(`/scenes/${name}.txt`, origin)).catch(
    () => undefined,
  )
  if (!response?.ok) return ''
  const text = await response.text()
  return FRAME.test(text) ? text : ''
}

function cookieScene(request: Request): string | null {
  return /(?:^|;\s*)scene=([a-z-]+)/.exec(request.headers.get('cookie') ?? '')?.[1] ?? null
}

function pick(list: readonly Scene[], url: URL, request: Request): Scene {
  const asked =
    url.searchParams.get('scene') ?? (url.pathname === '/' ? null : cookieScene(request))
  return (
    list.find((scene) => scene.name === asked) ?? list[Math.floor(Math.random() * list.length)]!
  )
}

/** The page file in full: its validator describes the file, and the visitor gets a page written for them. */
function unconditional(request: Request): Request {
  const headers = new Headers(request.headers)
  for (const name of VALIDATORS) headers.delete(name)
  return new Request(request.url, { method: request.method, headers, redirect: request.redirect })
}

function personal(response: Response): Response {
  const result = new Response(response.body, response)
  result.headers.delete('etag')
  result.headers.delete('last-modified')
  // Each response carries its own scene, so no cache may keep one.
  result.headers.set('cache-control', 'private, no-store')
  return result
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await env.ASSETS.fetch(unconditional(request))
    if (!(response.headers.get('content-type') ?? '').startsWith('text/html')) return response

    const url = new URL(request.url)
    const list = await sceneList(env, url)
    if (!list) return personal(response)
    const scene = pick(list, url, request)
    const style = Object.entries(scene.theme)
      .map(([name, value]) => `--${name}:${value}`)
      .concat([`--scene-label:${JSON.stringify(scene.label)}`])
      .join(';')
    const frame = url.pathname === '/' ? await sceneFrame(env, url, scene.name) : ''

    const page = new HTMLRewriter()
      .on('html', {
        element(element) {
          element.setAttribute('data-scene', scene.name)
          element.setAttribute('style', style)
        },
      })
      .on('#scene-frame', {
        element(element) {
          if (frame) element.setInnerContent(frame, { html: true })
        },
      })
      .transform(response)
    const result = personal(page)
    result.headers.append('set-cookie', `scene=${scene.name}; Path=/; SameSite=Lax; Secure`)
    return result
  },
}
