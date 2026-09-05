import { describe, expect, it } from 'vitest'

import { convertDisplayP3Raw, displayP3ToSrgb, projectNativeAppearance } from '../projection.js'
import type { GhosttyConfigTheme, NativeColor, NativeProfile } from '../types.js'
import { nativePayload, nativeProfile, rgb } from './fixtures.js'

const COLOR_FIELDS = [
  ['cursorColor', 'cursor', 'cursor-color-cell-reference'],
  ['cursorText', 'cursorText', 'cursor-text-cell-reference'],
  ['selectionBackground', 'selectionBackground', 'selection-background-cell-reference'],
  ['selectionForeground', 'selectionForeground', 'selection-foreground-cell-reference'],
] as const

function expectedColor(
  color: NativeColor,
  unsetFallback: 'background' | 'foreground',
  theme: GhosttyConfigTheme,
) {
  if (color.kind === 'unset') return theme[unsetFallback]
  if (color.kind === 'rgb') return color.value
  if (color.kind === 'cell-foreground') return theme.foreground
  return theme.background
}

describe('native appearance projection', () => {
  it('uses exact unset fallbacks without marking degradation', () => {
    const appearance = projectNativeAppearance(nativePayload())
    const light = appearance.profiles.light

    expect(light.fidelity).toBe('exact')
    expect(light.degradedFeatures).toEqual([])
    expect(light.theme.cursor).toEqual(light.theme.foreground)
    expect(light.theme.cursorText).toEqual(light.theme.background)
    expect(light.theme.selectionBackground).toEqual(light.theme.foreground)
    expect(light.theme.selectionForeground).toEqual(light.theme.background)
    expect(appearance.revision).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('projects dynamic colors and surface values in fixed degradation order', () => {
    const profile = nativeProfile({
      cursorColor: { kind: 'cell-background' },
      cursorText: { kind: 'cell-foreground' },
      selectionBackground: { kind: 'cell-background' },
      selectionForeground: { kind: 'cell-foreground' },
      surface: {
        backgroundBlur: { kind: 'radius', value: 20 },
        backgroundOpacity: 0.9,
        backgroundOpacityCells: true,
      },
    })
    const appearance = projectNativeAppearance(nativePayload({ dark: profile, light: profile }))
    const light = appearance.profiles.light

    expect(light.degradedFeatures).toEqual([
      'background-blur',
      'background-opacity-cells',
      'cursor-color-cell-reference',
      'cursor-text-cell-reference',
      'selection-background-cell-reference',
      'selection-foreground-cell-reference',
    ])
    expect(light.theme.cursor).toEqual(light.theme.background)
    expect(light.theme.cursorText).toEqual(light.theme.foreground)
    expect(light.surface).toEqual({
      backgroundBlurRadius: 20,
      backgroundOpacity: 0.9,
      backgroundOpacityCells: true,
    })
  })

  it('projects unset, static RGB, and both dynamic tags for every color field', () => {
    const staticColor = rgb(12, 34, 56)
    const cases: readonly [NativeColor, boolean][] = [
      [{ kind: 'unset' }, false],
      [{ kind: 'rgb', value: staticColor }, false],
      [{ kind: 'cell-foreground' }, true],
      [{ kind: 'cell-background' }, true],
    ]
    for (const [index, [nativeField, publicField, degradation]] of COLOR_FIELDS.entries()) {
      const unsetFallback = index % 2 === 0 ? 'foreground' : 'background'
      for (const [color, degraded] of cases) {
        const profile = nativeProfile({ [nativeField]: color } as Partial<NativeProfile>)
        const appearance = projectNativeAppearance(nativePayload({ dark: profile, light: profile }))
        const projected = appearance.profiles.light
        expect(projected.theme[publicField]).toEqual(
          expectedColor(color, unsetFallback, projected.theme),
        )
        expect(projected.degradedFeatures).toEqual(degraded ? [degradation] : [])
      }
    }
  })

  it('converts every static P3 category before applying dynamic fallbacks', () => {
    const profile = nativeProfile({
      background: rgb(111, 85, 28),
      cursorColor: { kind: 'rgb', value: rgb(42, 35, 42) },
      cursorText: { kind: 'cell-foreground' },
      foreground: rgb(198, 135, 238),
      palette: Array.from({ length: 256 }, () => rgb(111, 85, 28)),
      selectionBackground: { kind: 'rgb', value: rgb(10, 10, 10) },
      selectionForeground: { kind: 'rgb', value: rgb(11, 11, 11) },
      windowColorspace: 'display-p3',
    })
    const appearance = projectNativeAppearance(nativePayload({ dark: profile, light: profile }))
    const projected = appearance.profiles.light

    expect(projected.theme.background).toEqual(displayP3ToSrgb(profile.background))
    expect(projected.theme.foreground).toEqual(displayP3ToSrgb(profile.foreground))
    expect(projected.theme.cursor).toEqual(displayP3ToSrgb(rgb(42, 35, 42)))
    expect(projected.theme.cursorText).toEqual(projected.theme.foreground)
    expect(projected.theme.selectionBackground).toEqual(rgb(10, 10, 10))
    expect(projected.theme.selectionForeground).toEqual(rgb(11, 11, 11))
    expect(projected.theme.palette[255]).toEqual(rgb(116, 84, 8))
    expect(projected.degradedFeatures).toEqual(['cursor-text-cell-reference', 'display-p3'])
  })

  it('reports macOS glass without pretending it is CSS blur', () => {
    const profile = nativeProfile({
      surface: {
        backgroundBlur: { kind: 'macos-glass', variant: 'clear' },
        backgroundOpacity: 1,
        backgroundOpacityCells: false,
      },
    })
    const appearance = projectNativeAppearance(nativePayload({ dark: profile, light: profile }))
    expect(appearance.profiles.light.surface.backgroundBlurRadius).toBe(0)
    expect(appearance.profiles.light.degradedFeatures).toEqual(['macos-glass'])
  })

  it.each([
    [rgb(0, 0, 0), rgb(0, 0, 0)],
    [rgb(255, 255, 255), rgb(255, 255, 255)],
    [rgb(255, 0, 0), rgb(255, 0, 0)],
    [rgb(0, 255, 0), rgb(0, 255, 0)],
    [rgb(0, 0, 255), rgb(0, 0, 255)],
    [rgb(128, 128, 128), rgb(128, 128, 128)],
    [rgb(10, 10, 10), rgb(10, 10, 10)],
    [rgb(11, 11, 11), rgb(11, 11, 11)],
    [rgb(111, 85, 28), rgb(116, 84, 8)],
  ])('matches the frozen Display-P3 vector %#', (input, expected) => {
    expect(displayP3ToSrgb(input)).toEqual(expected)
  })

  it('keeps the frozen half-up boundary vectors', () => {
    const below = convertDisplayP3Raw(rgb(42, 35, 42))[2]!
    const above = convertDisplayP3Raw(rgb(198, 135, 238))[2]!
    expect(below).toBeGreaterThan(42.4999)
    expect(below).toBeLessThan(42.5)
    expect(above).toBeGreaterThan(244.5)
    expect(above).toBeLessThan(244.5001)
  })
})
