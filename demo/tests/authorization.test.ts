import { describe, expect, it } from 'vitest'

import {
  DEMO_TOKEN_PLACEHOLDER,
  authorizeSameOriginRequest,
  authorizeWebSocketUpgrade,
  createDemoAuthority,
  createDemoToken,
  createSecurityHeaders,
  injectDemoToken,
} from '../src/authorization.js'

const TOKEN = 'A'.repeat(43)
const WEBSOCKET_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

describe('demo authorization', () => {
  it('creates independent 256-bit base64url tokens', () => {
    const first = createDemoToken()
    const second = createDemoToken()

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second).not.toBe(first)
  })

  it('requires the exact Host and rejects a foreign Origin when present', () => {
    const authority = createDemoAuthority({ port: 4321, token: TOKEN })

    expect(authorizeSameOriginRequest(pageRequest(authority), authority)).toEqual({ ok: true })
    expect(
      authorizeSameOriginRequest(pageRequest(authority, { origin: authority.origin }), authority),
    ).toEqual({ ok: true })
    expect(
      authorizeSameOriginRequest(pageRequest(authority, { host: 'localhost:4321' }), authority),
    ).toMatchObject({ ok: false, code: 'host' })
    expect(
      authorizeSameOriginRequest(
        pageRequest(authority, { origin: 'http://attacker.test' }),
        authority,
      ),
    ).toMatchObject({ ok: false, code: 'origin' })
  })

  it('uses the canonical HTTP authority for the configured port', () => {
    const authority = createDemoAuthority({ port: 80, token: TOKEN })

    expect(authority.host).toBe('127.0.0.1')
    expect(authority.origin).toBe('http://127.0.0.1')
    expect(authority.port).toBe(80)
  })

  it('accepts only the complete same-origin WebSocket handshake', () => {
    const authority = createDemoAuthority({ port: 4321, token: TOKEN })

    expect(authorizeWebSocketUpgrade(webSocketRequest(authority), authority)).toEqual({ ok: true })
  })

  it.each([
    ['non-GET method', { method: 'POST' }, 'method'],
    ['missing Origin', { origin: null }, 'origin'],
    ['foreign Origin', { origin: 'http://attacker.test' }, 'origin'],
    ['wrong Host', { host: 'localhost:4321' }, 'host'],
    ['wrong path', { path: '/other' }, 'path'],
    ['missing Upgrade', { upgrade: null }, 'upgrade'],
    ['missing Connection', { connection: null }, 'connection'],
    ['wrong version', { version: '12' }, 'version'],
    ['invalid key', { key: 'invalid' }, 'key'],
    ['wrong token', { token: 'B'.repeat(43) }, 'token'],
    ['missing token', { query: '' }, 'query'],
    ['additional query', { query: `token=${TOKEN}&extra=1` }, 'query'],
    ['repeated token', { query: `token=${TOKEN}&token=${TOKEN}` }, 'query'],
  ] as const)('rejects %s', (_name, overrides, code) => {
    const authority = createDemoAuthority({ port: 4321, token: TOKEN })
    const result = authorizeWebSocketUpgrade(webSocketRequest(authority, overrides), authority)

    expect(result).toMatchObject({ ok: false, code })
  })

  it('injects the token into one HTML placeholder only', () => {
    const html = `<meta name="ghostty-demo-token" content="${DEMO_TOKEN_PLACEHOLDER}">`

    expect(injectDemoToken(html, TOKEN)).toBe(`<meta name="ghostty-demo-token" content="${TOKEN}">`)
    expect(() => injectDemoToken('<html></html>', TOKEN)).toThrow(TypeError)
    expect(() => injectDemoToken(`${html}${html}`, TOKEN)).toThrow(TypeError)
  })

  it('sets same-origin security headers without enabling CORS', () => {
    const headers = createSecurityHeaders('text/html; charset=utf-8')

    expect(headers.get('cache-control')).toBe('no-store')
    expect(headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(headers.get('content-security-policy')).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(headers.get('content-security-policy')).not.toMatch(/(?:^|[ ;])'unsafe-eval'(?:[ ;]|$)/)
    expect(headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(headers.has('access-control-allow-origin')).toBe(false)
  })
})

interface RequestOverrides {
  readonly connection?: string | null
  readonly host?: string
  readonly key?: string
  readonly method?: string
  readonly origin?: string | null
  readonly path?: string
  readonly query?: string
  readonly token?: string
  readonly upgrade?: string | null
  readonly version?: string
}

function pageRequest(
  authority: ReturnType<typeof createDemoAuthority>,
  overrides: Pick<RequestOverrides, 'host' | 'origin'> = {},
): Request {
  const headers = new Headers({ host: overrides.host ?? authority.host })
  if (overrides.origin !== null && overrides.origin !== undefined) {
    headers.set('origin', overrides.origin)
  }
  return new Request(`${authority.origin}/`, { headers })
}

function webSocketRequest(
  authority: ReturnType<typeof createDemoAuthority>,
  overrides: RequestOverrides = {},
): Request {
  const token = overrides.token ?? authority.token
  const query = overrides.query ?? `token=${token}`
  const path = overrides.path ?? '/pty'
  const headers = new Headers({
    connection: overrides.connection ?? 'keep-alive, Upgrade',
    host: overrides.host ?? authority.host,
    origin: overrides.origin ?? authority.origin,
    'sec-websocket-key': overrides.key ?? WEBSOCKET_KEY,
    'sec-websocket-version': overrides.version ?? '13',
    upgrade: overrides.upgrade ?? 'websocket',
  })
  deleteNullableHeader(headers, 'connection', overrides.connection)
  deleteNullableHeader(headers, 'origin', overrides.origin)
  deleteNullableHeader(headers, 'upgrade', overrides.upgrade)
  const suffix = query.length === 0 ? '' : `?${query}`
  return new Request(`${authority.origin}${path}${suffix}`, {
    headers,
    method: overrides.method,
  })
}

function deleteNullableHeader(
  headers: Headers,
  name: string,
  value: string | null | undefined,
): void {
  if (value === null) headers.delete(name)
}
