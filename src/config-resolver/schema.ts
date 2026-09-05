import { canonicalObjectBytes, canonicalObjectSha256 } from './canonicalize.js'
import {
  GHOSTTY_CONFIG_UPSTREAM_REVISION,
  type GhosttyConfigAppearance,
  type GhosttyConfigAppearancePreimage,
  type GhosttyConfigDegradedFeature,
  type GhosttyConfigProfile,
  type GhosttyConfigRgb,
  type NativeBlur,
  type NativeColor,
  type NativeProfile,
  type NativeResolverPayload,
  type NativeRgb,
} from './types.js'

export const NATIVE_OUTPUT_LIMIT_BYTES = 128 * 1024
export const GHOSTTY_CONFIG_DEGRADED_FEATURES = [
  'background-blur',
  'background-opacity-cells',
  'cursor-color-cell-reference',
  'cursor-text-cell-reference',
  'selection-background-cell-reference',
  'selection-foreground-cell-reference',
  'display-p3',
  'macos-glass',
] as const satisfies readonly GhosttyConfigDegradedFeature[]

const HASH_PATTERN = /^[0-9a-f]{64}$/
const decoder = new TextDecoder('utf-8', { fatal: true })

type JsonObject = Record<string, unknown>

export class ResolverSchemaError extends Error {}

export function parseCanonicalNativePayload(bytes: Uint8Array): NativeResolverPayload {
  if (bytes.length === 0 || bytes.length > NATIVE_OUTPUT_LIMIT_BYTES) {
    throw new ResolverSchemaError('native payload length is invalid')
  }
  const text = decodeNativeUtf8(bytes)
  const value = parseNativeJson(text)
  const payload = validateNativeResolverPayload(value)
  const canonical = canonicalObjectBytes(payload)
  if (!Buffer.from(bytes).equals(canonical)) {
    throw new ResolverSchemaError('native payload is not canonical JSON plus one LF')
  }
  return payload
}

function decodeNativeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes)
  } catch {
    throw new ResolverSchemaError('native payload is not valid UTF-8')
  }
}

function parseNativeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ResolverSchemaError('native payload is not JSON')
  }
}

export function validateNativeResolverPayload(value: unknown): NativeResolverPayload {
  const payload = objectValue(value, 'native payload')
  exactKeys(
    payload,
    ['diagnosticCount', 'nativeSchemaVersion', 'profiles', 'upstreamRevision'],
    'native payload',
  )
  if (payload.nativeSchemaVersion !== 1) fail('native schema version does not match')
  if (payload.upstreamRevision !== GHOSTTY_CONFIG_UPSTREAM_REVISION) {
    fail('native upstream revision does not match')
  }
  integerValue(payload.diagnosticCount, 0, 65_535, 'native diagnostic count')
  const profiles = objectValue(payload.profiles, 'native profiles')
  exactKeys(profiles, ['dark', 'light'], 'native profiles')
  validateNativeProfile(profiles.dark, 'native dark profile')
  validateNativeProfile(profiles.light, 'native light profile')
  return payload as unknown as NativeResolverPayload
}

function validateNativeProfile(value: unknown, label: string): NativeProfile {
  const profile = objectValue(value, label)
  exactKeys(
    profile,
    [
      'background',
      'cursorColor',
      'cursorText',
      'foreground',
      'minimumContrast',
      'palette',
      'selectionBackground',
      'selectionForeground',
      'surface',
      'windowColorspace',
    ],
    label,
  )
  validateRgb(profile.background, `${label} background`)
  validateNativeColor(profile.cursorColor, `${label} cursorColor`)
  validateNativeColor(profile.cursorText, `${label} cursorText`)
  validateRgb(profile.foreground, `${label} foreground`)
  finiteValue(profile.minimumContrast, 1, 21, `${label} minimumContrast`)
  validatePalette(profile.palette, `${label} palette`)
  validateNativeColor(profile.selectionBackground, `${label} selectionBackground`)
  validateNativeColor(profile.selectionForeground, `${label} selectionForeground`)
  validateNativeSurface(profile.surface, `${label} surface`)
  enumValue(profile.windowColorspace, ['display-p3', 'srgb'], `${label} windowColorspace`)
  return profile as unknown as NativeProfile
}

function validateNativeColor(value: unknown, label: string): NativeColor {
  const color = objectValue(value, label)
  if (color.kind === 'rgb') {
    exactKeys(color, ['kind', 'value'], label)
    validateRgb(color.value, `${label} value`)
    return color as unknown as NativeColor
  }
  exactKeys(color, ['kind'], label)
  enumValue(color.kind, ['cell-background', 'cell-foreground', 'unset'], `${label} kind`)
  return color as unknown as NativeColor
}

function validateNativeSurface(value: unknown, label: string): void {
  const surface = objectValue(value, label)
  exactKeys(surface, ['backgroundBlur', 'backgroundOpacity', 'backgroundOpacityCells'], label)
  validateNativeBlur(surface.backgroundBlur, `${label} backgroundBlur`)
  finiteValue(surface.backgroundOpacity, 0, 1, `${label} backgroundOpacity`)
  booleanValue(surface.backgroundOpacityCells, `${label} backgroundOpacityCells`)
}

function validateNativeBlur(value: unknown, label: string): NativeBlur {
  const blur = objectValue(value, label)
  if (blur.kind === 'none') {
    exactKeys(blur, ['kind'], label)
    return blur as unknown as NativeBlur
  }
  if (blur.kind === 'radius') {
    exactKeys(blur, ['kind', 'value'], label)
    integerValue(blur.value, 0, 255, `${label} value`)
    return blur as unknown as NativeBlur
  }
  if (blur.kind !== 'macos-glass') fail(`${label} kind is unsupported`)
  exactKeys(blur, ['kind', 'variant'], label)
  enumValue(blur.variant, ['clear', 'regular'], `${label} variant`)
  return blur as unknown as NativeBlur
}

export function validateGhosttyConfigAppearance(value: unknown): GhosttyConfigAppearance {
  const appearance = objectValue(value, 'appearance')
  exactKeys(
    appearance,
    ['diagnosticCount', 'profiles', 'revision', 'schemaVersion', 'upstreamRevision'],
    'appearance',
  )
  if (appearance.schemaVersion !== 1) fail('appearance schema version does not match')
  if (appearance.upstreamRevision !== GHOSTTY_CONFIG_UPSTREAM_REVISION) {
    fail('appearance upstream revision does not match')
  }
  integerValue(appearance.diagnosticCount, 0, 65_535, 'appearance diagnosticCount')
  patternValue(appearance.revision, HASH_PATTERN, 'appearance revision')
  const profiles = objectValue(appearance.profiles, 'appearance profiles')
  exactKeys(profiles, ['dark', 'light'], 'appearance profiles')
  validatePublicProfile(profiles.dark, 'appearance dark profile')
  validatePublicProfile(profiles.light, 'appearance light profile')
  const result = appearance as unknown as GhosttyConfigAppearance
  if (appearanceRevision(result) !== result.revision) fail('appearance revision does not match')
  return result
}

export function appearanceRevision(value: GhosttyConfigAppearance): string {
  return canonicalObjectSha256(appearancePreimage(value))
}

export function appearancePreimage(
  value: GhosttyConfigAppearance,
): GhosttyConfigAppearancePreimage {
  return {
    diagnosticCount: value.diagnosticCount,
    profiles: value.profiles,
    schemaVersion: value.schemaVersion,
    upstreamRevision: value.upstreamRevision,
  }
}

function validatePublicProfile(value: unknown, label: string): GhosttyConfigProfile {
  const profile = objectValue(value, label)
  exactKeys(profile, ['degradedFeatures', 'fidelity', 'surface', 'theme'], label)
  const features = validateDegradedFeatures(profile.degradedFeatures, `${label} degradedFeatures`)
  enumValue(profile.fidelity, ['best-effort', 'exact'], `${label} fidelity`)
  if (features.length === 0 && profile.fidelity !== 'exact') {
    fail(`${label} fidelity does not match degradedFeatures`)
  }
  if (features.length > 0 && profile.fidelity !== 'best-effort') {
    fail(`${label} fidelity does not match degradedFeatures`)
  }
  validatePublicSurface(profile.surface, `${label} surface`)
  validatePublicTheme(profile.theme, `${label} theme`)
  return profile as unknown as GhosttyConfigProfile
}

function validateDegradedFeatures(
  value: unknown,
  label: string,
): readonly GhosttyConfigDegradedFeature[] {
  if (!Array.isArray(value) || value.length > GHOSTTY_CONFIG_DEGRADED_FEATURES.length) {
    fail(`${label} length is invalid`)
  }
  let previous = -1
  for (const entry of value) {
    const index = GHOSTTY_CONFIG_DEGRADED_FEATURES.indexOf(entry as GhosttyConfigDegradedFeature)
    if (index < 0) fail(`${label} contains an unsupported value`)
    if (index <= previous) fail(`${label} is not unique and canonically ordered`)
    previous = index
  }
  return value as readonly GhosttyConfigDegradedFeature[]
}

function validatePublicSurface(value: unknown, label: string): void {
  const surface = objectValue(value, label)
  exactKeys(surface, ['backgroundBlurRadius', 'backgroundOpacity', 'backgroundOpacityCells'], label)
  integerValue(surface.backgroundBlurRadius, 0, 255, `${label} backgroundBlurRadius`)
  finiteValue(surface.backgroundOpacity, 0, 1, `${label} backgroundOpacity`)
  booleanValue(surface.backgroundOpacityCells, `${label} backgroundOpacityCells`)
}

function validatePublicTheme(value: unknown, label: string): void {
  const theme = objectValue(value, label)
  exactKeys(
    theme,
    [
      'background',
      'cursor',
      'cursorText',
      'foreground',
      'minimumContrast',
      'palette',
      'selectionBackground',
      'selectionForeground',
    ],
    label,
  )
  validateRgb(theme.background, `${label} background`)
  validateRgb(theme.cursor, `${label} cursor`)
  validateRgb(theme.cursorText, `${label} cursorText`)
  validateRgb(theme.foreground, `${label} foreground`)
  finiteValue(theme.minimumContrast, 1, 21, `${label} minimumContrast`)
  validatePalette(theme.palette, `${label} palette`)
  validateRgb(theme.selectionBackground, `${label} selectionBackground`)
  validateRgb(theme.selectionForeground, `${label} selectionForeground`)
}

function validatePalette(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length !== 256) fail(`${label} length must be 256`)
  for (const [index, entry] of value.entries()) validateRgb(entry, `${label}[${index}]`)
}

function validateRgb(value: unknown, label: string): NativeRgb | GhosttyConfigRgb {
  const color = objectValue(value, label)
  exactKeys(color, ['b', 'g', 'r'], label)
  integerValue(color.b, 0, 255, `${label} b`)
  integerValue(color.g, 0, 255, `${label} g`)
  integerValue(color.r, 0, 255, `${label} r`)
  return color as unknown as NativeRgb
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} is not a JSON object`)
  return value as JsonObject
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length) fail(`${label} keys do not match`)
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== sortedExpected[index]) fail(`${label} keys do not match`)
  }
}

function integerValue(value: unknown, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value)) fail(`${label} is not an integer`)
  if ((value as number) < minimum || (value as number) > maximum) {
    fail(`${label} is outside its bound`)
  }
}

function finiteValue(value: unknown, minimum: number, maximum: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} is not finite`)
  if (value < minimum || value > maximum) fail(`${label} is outside its bound`)
}

function booleanValue(value: unknown, label: string): void {
  if (typeof value !== 'boolean') fail(`${label} is not boolean`)
}

function patternValue(value: unknown, pattern: RegExp, label: string): void {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} does not match`)
}

function enumValue(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} is unsupported`)
}

function fail(message: string): never {
  throw new ResolverSchemaError(message)
}
