import { NATIVE_UPSTREAM_REVISION } from './constants'

type JsonObject = Record<string, unknown>
export type Rgb = { readonly r: number; readonly g: number; readonly b: number }
export type NativeColor =
  | { readonly kind: 'unset' }
  | { readonly kind: 'rgb'; readonly value: Rgb }
  | { readonly kind: 'cell-foreground' }
  | { readonly kind: 'cell-background' }
export type NativeProfile = {
  readonly background: Rgb
  readonly foreground: Rgb
  readonly cursorColor: NativeColor
  readonly cursorText: NativeColor
  readonly selectionBackground: NativeColor
  readonly selectionForeground: NativeColor
  readonly minimumContrast: number
  readonly palette: readonly Rgb[]
  readonly windowColorspace: 'display-p3' | 'srgb'
  readonly surface: {
    readonly backgroundOpacity: number
    readonly backgroundOpacityCells: boolean
    readonly backgroundBlur:
      | { readonly kind: 'none' }
      | { readonly kind: 'radius'; readonly value: number }
      | { readonly kind: 'macos-glass'; readonly variant: 'clear' | 'regular' }
  }
}
export type NativeResult = {
  readonly nativeSchemaVersion: 1
  readonly upstreamRevision: string
  readonly diagnosticCount: number
  readonly profiles: {
    readonly light: NativeProfile
    readonly dark: NativeProfile
  }
}
export class NativeVerifyFailure extends Error {}

export function validateResult(value: unknown): NativeResult {
  const result = asObject(value, 'result')
  if (result.nativeSchemaVersion !== 1) throw new NativeVerifyFailure('schema version mismatch')
  if (result.upstreamRevision !== NATIVE_UPSTREAM_REVISION)
    throw new NativeVerifyFailure('revision mismatch')
  assertKeys(
    result,
    ['diagnosticCount', 'nativeSchemaVersion', 'profiles', 'upstreamRevision'],
    'ready result',
  )
  assertInteger(result.diagnosticCount, 0, 65_535, 'diagnostic count')
  const profiles = asObject(result.profiles, 'profiles')
  assertKeys(profiles, ['dark', 'light'], 'profiles')
  validateProfile(profiles.light)
  validateProfile(profiles.dark)
  return result as NativeResult
}

function validateProfile(value: unknown): NativeProfile {
  const profile = asObject(value, 'profile')
  assertKeys(
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
    'profile',
  )
  validateRgb(profile.background)
  validateRgb(profile.foreground)
  validateColor(profile.cursorColor)
  validateColor(profile.cursorText)
  validateColor(profile.selectionBackground)
  validateColor(profile.selectionForeground)
  assertFinite(profile.minimumContrast, 1, 21, 'minimum contrast')
  if (!Array.isArray(profile.palette) || profile.palette.length !== 256) {
    throw new NativeVerifyFailure('palette length mismatch')
  }
  for (const color of profile.palette) validateRgb(color)
  if (profile.windowColorspace !== 'srgb' && profile.windowColorspace !== 'display-p3') {
    throw new NativeVerifyFailure('window colorspace mismatch')
  }
  validateSurface(profile.surface)
  return profile as NativeProfile
}

function validateRgb(value: unknown): Rgb {
  const color = asObject(value, 'RGB')
  assertKeys(color, ['b', 'g', 'r'], 'RGB')
  for (const channel of ['r', 'g', 'b'] as const) {
    assertInteger(color[channel], 0, 255, `RGB ${channel}`)
  }
  return color as Rgb
}

function validateColor(value: unknown): NativeColor {
  const color = asObject(value, 'color')
  if (color.kind === 'rgb') {
    assertKeys(color, ['kind', 'value'], 'RGB color')
    validateRgb(color.value)
    return color as NativeColor
  }
  assertKeys(color, ['kind'], 'dynamic color')
  if (!['unset', 'cell-foreground', 'cell-background'].includes(color.kind as string)) {
    throw new NativeVerifyFailure('color kind mismatch')
  }
  return color as NativeColor
}

function validateSurface(value: unknown): void {
  const surface = asObject(value, 'surface')
  assertKeys(surface, ['backgroundBlur', 'backgroundOpacity', 'backgroundOpacityCells'], 'surface')
  assertFinite(surface.backgroundOpacity, 0, 1, 'background opacity')
  if (typeof surface.backgroundOpacityCells !== 'boolean') {
    throw new NativeVerifyFailure('background opacity cells mismatch')
  }
  const blur = asObject(surface.backgroundBlur, 'background blur')
  if (blur.kind === 'none') {
    assertKeys(blur, ['kind'], 'none blur')
    return
  }
  if (blur.kind === 'radius') {
    assertKeys(blur, ['kind', 'value'], 'radius blur')
    assertInteger(blur.value, 0, 255, 'blur radius')
    return
  }
  if (blur.kind !== 'macos-glass') throw new NativeVerifyFailure('blur kind mismatch')
  assertKeys(blur, ['kind', 'variant'], 'glass blur')
  if (blur.variant !== 'clear' && blur.variant !== 'regular') {
    throw new NativeVerifyFailure('glass variant mismatch')
  }
}

export function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NativeVerifyFailure(`${label} must be an object`)
  }
  return value as JsonObject
}

export function assertKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const sortedExpected = expected.toSorted()
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new NativeVerifyFailure(`${label} keys mismatch`)
  }
}

function assertInteger(value: unknown, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new NativeVerifyFailure(`${label} must be a bounded integer`)
  }
}

function assertFinite(value: unknown, minimum: number, maximum: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new NativeVerifyFailure(`${label} must be a bounded number`)
  }
}
