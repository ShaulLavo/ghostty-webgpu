import { randomBytes, timingSafeEqual } from 'node:crypto'

export const DEFAULT_DEMO_HOSTNAME = '127.0.0.1'
export const DEFAULT_DEMO_PORT = 4173
export const DEMO_TOKEN_PLACEHOLDER = '__GHOSTTY_DEMO_TOKEN__'
export const PTY_PATH = '/pty'

export interface DemoAuthority {
  readonly hostname: string
  readonly host: string
  readonly origin: string
  readonly port: number
  readonly token: string
}

export interface DemoAuthorityOptions {
  readonly hostname?: string
  readonly port?: number
  readonly token?: string
}

export type AuthorizationResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code:
        | 'connection'
        | 'host'
        | 'key'
        | 'method'
        | 'origin'
        | 'path'
        | 'query'
        | 'token'
        | 'upgrade'
        | 'version'
      readonly status: 400 | 403 | 405
    }

const AUTHORIZED = Object.freeze({ ok: true } as const)
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function createDemoToken(): string {
  return randomBytes(32).toString('base64url')
}

export function createDemoAuthority(options: DemoAuthorityOptions = {}): DemoAuthority {
  const hostname = options.hostname ?? DEFAULT_DEMO_HOSTNAME
  const port = options.port ?? DEFAULT_DEMO_PORT
  const token = options.token ?? createDemoToken()
  validateHostname(hostname)
  validatePort(port)
  validateToken(token)

  const url = new URL(`http://${formatHostname(hostname)}:${port}`)
  return Object.freeze({ hostname, host: url.host, origin: url.origin, port, token })
}

export function authorizeSameOriginRequest(
  request: Request,
  authority: DemoAuthority,
): AuthorizationResult {
  if (request.headers.get('host') !== authority.host) return denied('host', 403)

  const origin = request.headers.get('origin')
  if (origin !== null && origin !== authority.origin) return denied('origin', 403)
  return AUTHORIZED
}

export function authorizeWebSocketUpgrade(
  request: Request,
  authority: DemoAuthority,
): AuthorizationResult {
  if (request.method !== 'GET') return denied('method', 405)

  const sameOrigin = authorizeSameOriginRequest(request, authority)
  if (!sameOrigin.ok) return sameOrigin
  if (request.headers.get('origin') !== authority.origin) return denied('origin', 403)

  const url = new URL(request.url)
  if (url.pathname !== PTY_PATH) return denied('path', 400)
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return denied('upgrade', 400)
  }
  if (!hasHeaderToken(request.headers.get('connection'), 'upgrade')) {
    return denied('connection', 400)
  }
  if (request.headers.get('sec-websocket-version') !== '13') {
    return denied('version', 400)
  }
  if (!isValidWebSocketKey(request.headers.get('sec-websocket-key'))) {
    return denied('key', 400)
  }

  const entries = [...url.searchParams.entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== 'token') return denied('query', 403)
  if (!tokensEqual(entries[0][1], authority.token)) return denied('token', 403)
  return AUTHORIZED
}

export function injectDemoToken(html: string, token: string): string {
  validateToken(token)
  const pieces = html.split(DEMO_TOKEN_PLACEHOLDER)
  if (pieces.length !== 2) {
    throw new TypeError('Demo HTML must contain the token placeholder exactly once')
  }
  return `${pieces[0]}${token}${pieces[1]}`
}

export function createSecurityHeaders(contentType: string): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'none'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "form-action 'none'",
      "object-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
    ].join('; '),
    'Content-Type': contentType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  })
}

function denied(
  code: Exclude<AuthorizationResult, { readonly ok: true }>['code'],
  status: 400 | 403 | 405,
): AuthorizationResult {
  return { ok: false, code, status }
}

function formatHostname(hostname: string): string {
  if (!hostname.includes(':')) return hostname
  return `[${hostname}]`
}

function hasHeaderToken(header: string | null, expected: string): boolean {
  if (header === null) return false
  return header.split(',').some((token) => token.trim().toLowerCase() === expected)
}

function isValidWebSocketKey(value: string | null): boolean {
  if (value === null || !/^[A-Za-z0-9+/]{22}==$/.test(value)) return false
  return Buffer.from(value, 'base64').byteLength === 16
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual)
  const expectedBytes = Buffer.from(expected)
  if (actualBytes.byteLength !== expectedBytes.byteLength) return false
  return timingSafeEqual(actualBytes, expectedBytes)
}

function validateHostname(hostname: string): void {
  if (hostname.length === 0 || !/^[A-Za-z0-9.:-]+$/.test(hostname)) {
    throw new TypeError('Demo hostname must be a non-empty host name or IP address')
  }
  if (hostname.startsWith('[') || hostname.endsWith(']')) {
    throw new TypeError('Demo hostname must not include IPv6 brackets')
  }
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('Demo port must be an integer from 1 through 65535')
  }
}

function validateToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new TypeError('Demo token must be 32 bytes encoded as base64url')
  }
}
