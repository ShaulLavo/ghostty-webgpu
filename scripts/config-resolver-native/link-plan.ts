import { NATIVE_BUILD_ROOT, type NativeTarget } from './constants'
import { NativeContractError } from './canonical'

const CACHE_KEY = /^[0-9a-f]{32}$/
const CACHE_TOKEN = /^\{\{zig-cache-key-([0-9]{4})\}\}$/
const CACHE_TOKEN_PREFIX = '{{zig-cache-key-'
const CACHE_MARKER = '/final-cache/o/'
const MAX_ARGUMENT_BYTES = 4096
const MAX_ARGUMENTS = 4096

export function projectObservedLinkArgv(
  rawArgv: readonly string[],
  target: NativeTarget,
  workRoot: string = NATIVE_BUILD_ROOT[target.startsWith('darwin-') ? 'darwin' : 'linux'],
): readonly string[] {
  validateRawArgv(rawArgv)
  const tokens = new Map<string, string>()
  const projected = rawArgv.map((argument) => projectArgument(argument, workRoot, tokens))
  validateLinkPlan(projected, workRoot)
  return projected
}

export function projectNativeLinkPlan(
  rawArgv: readonly string[],
  target: NativeTarget,
): readonly string[] {
  const root = NATIVE_BUILD_ROOT[target.startsWith('darwin-') ? 'darwin' : 'linux']
  return projectObservedLinkArgv(rawArgv, target, root).map((argument) =>
    tokenizeNativePath(argument, root),
  )
}

export function validateLinkPlan(linkPlan: readonly string[], workRoot = '$WORK'): void {
  validateStringArray(linkPlan, 'linkPlan')
  const seen = new Set<number>()
  for (const argument of linkPlan) validatePlanArgument(argument, workRoot, seen)
  if (seen.size === 0) throw new NativeContractError('linkPlan has no Zig cache key tokens')
}

export function tokenizeNativePath(value: string, workRoot: string): string {
  if (value === workRoot) return '$WORK'
  if (value.startsWith(`${workRoot}/`)) return `$WORK${value.slice(workRoot.length)}`
  const assignment = value.indexOf('=')
  if (assignment >= 0) {
    const suffix = value.slice(assignment + 1)
    if (suffix === workRoot || suffix.startsWith(`${workRoot}/`)) {
      return `${value.slice(0, assignment + 1)}$WORK${suffix.slice(workRoot.length)}`
    }
  }
  for (const prefix of ['-F', '-I', '-L']) {
    if (!value.startsWith(`${prefix}${workRoot}`)) continue
    const suffix = value.slice(prefix.length)
    if (suffix !== workRoot && !suffix.startsWith(`${workRoot}/`)) continue
    return `${prefix}$WORK${suffix.slice(workRoot.length)}`
  }
  return value
}

export function expandNativeToken(value: string, tokens: Readonly<Record<string, string>>): string {
  let expanded = value
  for (const [token, replacement] of Object.entries(tokens)) {
    expanded = expanded.replaceAll(token, replacement)
  }
  if (/\$[A-Z][A-Z0-9_]*/.test(expanded)) {
    throw new NativeContractError(`unresolved path token in ${value}`)
  }
  return expanded
}

function validateRawArgv(argv: readonly string[]): void {
  validateStringArray(argv, 'linkArgv')
  if (argv.some((argument) => argument.includes(CACHE_TOKEN_PREFIX))) {
    throw new NativeContractError('raw linkArgv contains a cache placeholder')
  }
}

function validateStringArray(values: readonly string[], label: string): void {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_ARGUMENTS) {
    throw new NativeContractError(`${label} has an invalid argument count`)
  }
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new NativeContractError(`${label} contains a non-string or empty argument`)
    }
    if (
      Buffer.byteLength(value) > MAX_ARGUMENT_BYTES ||
      value.includes('\0') ||
      value.includes('\r') ||
      value.includes('\n')
    ) {
      throw new NativeContractError(`${label} contains an invalid argument`)
    }
  }
}

function projectArgument(argument: string, workRoot: string, tokens: Map<string, string>): string {
  const component = cacheComponent(argument, workRoot, 'linkArgv')
  if (!component) return argument
  if (!CACHE_KEY.test(component.value)) {
    throw new NativeContractError('linkArgv has a malformed Zig cache key component')
  }
  let token = tokens.get(component.value)
  if (!token) {
    if (tokens.size > 9_999) throw new NativeContractError('linkArgv has too many cache keys')
    token = `{{zig-cache-key-${String(tokens.size).padStart(4, '0')}}}`
    tokens.set(component.value, token)
  }
  return `${argument.slice(0, component.start)}${token}${argument.slice(component.end)}`
}

function validatePlanArgument(argument: string, workRoot: string, seen: Set<number>): void {
  const component = cacheComponent(argument, workRoot, 'linkPlan')
  const tokenCount = offsets(argument, CACHE_TOKEN_PREFIX).length
  if (!component && tokenCount === 0) return
  if (!component || tokenCount !== 1 || !CACHE_TOKEN.test(component.value)) {
    throw new NativeContractError('linkPlan cache path must contain one exact cache token')
  }
  const match = CACHE_TOKEN.exec(component.value)
  if (!match) throw new NativeContractError('linkPlan has a malformed cache token')
  const index = Number(match[1])
  if (seen.has(index)) return
  if (index !== seen.size) throw new NativeContractError('linkPlan cache tokens are not contiguous')
  seen.add(index)
}

function cacheComponent(
  argument: string,
  workRoot: string,
  label: string,
): { readonly start: number; readonly end: number; readonly value: string } | null {
  const root = `${workRoot}${CACHE_MARKER}`
  const starts = offsets(argument, root)
  if (starts.length === 0) return null
  if (starts.length !== 1)
    throw new NativeContractError(`${label} argument has multiple cache roots`)
  const rootStart = starts[0]
  if (rootStart === undefined) throw new NativeContractError(`${label} cache root is missing`)
  assertRootBoundary(argument, rootStart, label)
  const start = rootStart + root.length
  const slash = argument.indexOf('/', start)
  const end = slash < 0 ? argument.length : slash
  if (end === start) throw new NativeContractError(`${label} cache component is empty`)
  const remainder = argument.slice(end)
  if (remainder.includes(CACHE_MARKER) || remainder.includes(CACHE_TOKEN_PREFIX)) {
    throw new NativeContractError(`${label} argument has multiple cache components`)
  }
  return { start, end, value: argument.slice(start, end) }
}

function assertRootBoundary(argument: string, start: number, label: string): void {
  if (start === 0) return
  const prefix = argument.slice(0, start)
  if (prefix.endsWith('=') || prefix === '-I' || prefix === '-L' || prefix === '-F') return
  throw new NativeContractError(`${label} cache root is not a complete path value`)
}

function offsets(value: string, needle: string): readonly number[] {
  const result: number[] = []
  let offset = 0
  while (offset <= value.length - needle.length) {
    const found = value.indexOf(needle, offset)
    if (found < 0) return result
    result.push(found)
    offset = found + needle.length
  }
  return result
}
