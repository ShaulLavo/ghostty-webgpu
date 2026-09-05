import { describe, expect, it } from 'vitest'

import { canonicalObjectBytes } from '../canonicalize.js'
import { projectNativeAppearance } from '../projection.js'
import {
  ResolverSchemaError,
  parseCanonicalNativePayload,
  validateGhosttyConfigAppearance,
  validateNativeResolverPayload,
} from '../schema.js'
import type { NativeResolverPayload } from '../types.js'
import { canonicalNativePayload, nativePayload, nativeProfile, rgb } from './fixtures.js'

function clone<T>(value: T): T {
  return structuredClone(value)
}

describe('native resolver schema', () => {
  it('accepts only canonical strict native bytes', () => {
    const payload = nativePayload()
    expect(parseCanonicalNativePayload(canonicalNativePayload(payload))).toEqual(payload)
    const reordered = {
      upstreamRevision: payload.upstreamRevision,
      profiles: payload.profiles,
      nativeSchemaVersion: payload.nativeSchemaVersion,
      diagnosticCount: payload.diagnosticCount,
    }
    expect(() =>
      parseCanonicalNativePayload(Buffer.from(`${JSON.stringify(reordered)}\n`)),
    ).toThrow(ResolverSchemaError)
    expect(() =>
      parseCanonicalNativePayload(Buffer.from('{"nativeSchemaVersion":1}\n{}\n')),
    ).toThrow(ResolverSchemaError)
    expect(() => parseCanonicalNativePayload(Buffer.from([0xff]))).toThrow(ResolverSchemaError)
  })

  it('rejects duplicate keys even when JSON.parse would overwrite them', () => {
    const payload = canonicalNativePayload().toString('utf8')
    const duplicate = payload.replace(
      '"diagnosticCount":0',
      '"diagnosticCount":0,"diagnosticCount":0',
    )
    expect(() => parseCanonicalNativePayload(Buffer.from(duplicate))).toThrow(ResolverSchemaError)
  })

  it('rejects unknown keys and every bounded native shape violation', () => {
    const cases: ((value: Record<string, unknown>) => void)[] = [
      (value) => {
        value.extra = true
      },
      (value) => {
        value.diagnosticCount = 65_536
      },
      (value) => {
        value.nativeSchemaVersion = 2
      },
      (value) => {
        const payload = value as unknown as NativeResolverPayload
        ;(payload.profiles.light.palette as NativeResolverPayload['profiles']['light']['palette']) =
          payload.profiles.light.palette.slice(1)
      },
      (value) => {
        const payload = value as unknown as NativeResolverPayload
        ;(payload.profiles.light.background.r as number) = -1
      },
      (value) => {
        const payload = value as unknown as NativeResolverPayload
        ;(payload.profiles.light.minimumContrast as number) = Number.NaN
      },
      (value) => {
        const payload = value as unknown as NativeResolverPayload
        ;(payload.profiles.light.surface.backgroundOpacity as number) = 1.01
      },
      (value) => {
        const payload = value as unknown as NativeResolverPayload
        ;(payload.profiles.light.cursorColor as { kind: string }).kind = 'hex'
      },
    ]
    for (const mutate of cases) {
      const value = clone(nativePayload()) as unknown as Record<string, unknown>
      mutate(value)
      expect(() => validateNativeResolverPayload(value)).toThrow(ResolverSchemaError)
    }
  })

  it('accepts every inclusive native numeric boundary', () => {
    const low = nativeProfile({
      background: rgb(0, 0, 0),
      minimumContrast: 1,
      surface: {
        backgroundBlur: { kind: 'radius', value: 0 },
        backgroundOpacity: 0,
        backgroundOpacityCells: false,
      },
    })
    const high = nativeProfile({
      background: rgb(255, 255, 255),
      minimumContrast: 21,
      surface: {
        backgroundBlur: { kind: 'radius', value: 255 },
        backgroundOpacity: 1,
        backgroundOpacityCells: true,
      },
    })
    const payload = nativePayload({ dark: high, light: low }) as unknown as Record<string, unknown>
    payload.diagnosticCount = 65_535
    expect(validateNativeResolverPayload(payload)).toBeDefined()
    payload.diagnosticCount = 0
    expect(validateNativeResolverPayload(payload)).toBeDefined()
  })

  it('rejects every exclusive native numeric boundary and invalid palette length', () => {
    const cases: ((value: NativeResolverPayload) => void)[] = [
      (value) => void ((value.diagnosticCount as number) = -1),
      (value) => void ((value.diagnosticCount as number) = 65_536),
      (value) => void ((value.diagnosticCount as number) = 0.5),
      (value) => void ((value.profiles.light.background.r as number) = -1),
      (value) => void ((value.profiles.light.background.r as number) = 256),
      (value) => void ((value.profiles.light.background.r as number) = 0.5),
      (value) => void ((value.profiles.light.minimumContrast as number) = 0.999),
      (value) => void ((value.profiles.light.minimumContrast as number) = 21.001),
      (value) => void ((value.profiles.light.minimumContrast as number) = Number.NaN),
      (value) => void ((value.profiles.light.surface.backgroundOpacity as number) = -0.001),
      (value) => void ((value.profiles.light.surface.backgroundOpacity as number) = 1.001),
      (value) => void ((value.profiles.light.surface.backgroundOpacity as number) = Infinity),
      (value) => {
        const blur = value.profiles.light.surface.backgroundBlur as { value: number }
        blur.value = -1
      },
      (value) => {
        const blur = value.profiles.light.surface.backgroundBlur as { value: number }
        blur.value = 256
      },
      (value) => {
        const blur = value.profiles.light.surface.backgroundBlur as { value: number }
        blur.value = 1.5
      },
      (value) =>
        void ((value.profiles.light.palette as unknown[]) = value.profiles.light.palette.slice(1)),
      (value) =>
        void ((value.profiles.light.palette as unknown[]) = [
          ...value.profiles.light.palette,
          rgb(0, 0, 0),
        ]),
    ]
    for (const mutate of cases) {
      const payload = clone(
        nativePayload({
          dark: nativeProfile({
            surface: {
              backgroundBlur: { kind: 'radius', value: 20 },
              backgroundOpacity: 1,
              backgroundOpacityCells: false,
            },
          }),
          light: nativeProfile({
            surface: {
              backgroundBlur: { kind: 'radius', value: 20 },
              backgroundOpacity: 1,
              backgroundOpacityCells: false,
            },
          }),
        }),
      )
      mutate(payload)
      expect(() => validateNativeResolverPayload(payload)).toThrow(ResolverSchemaError)
    }
  })

  it('rejects unknown keys recursively throughout the native document', () => {
    const mutations: ((value: NativeResolverPayload) => void)[] = [
      (value) => void ((value.profiles as unknown as Record<string, unknown>).extra = true),
      (value) => void ((value.profiles.light as unknown as Record<string, unknown>).extra = true),
      (value) =>
        void ((value.profiles.light.background as unknown as Record<string, unknown>).extra = true),
      (value) =>
        void ((value.profiles.light.cursorColor as unknown as Record<string, unknown>).extra =
          true),
      (value) =>
        void ((value.profiles.light.surface as unknown as Record<string, unknown>).extra = true),
      (value) =>
        void ((value.profiles.light.palette[0] as unknown as Record<string, unknown>).extra = true),
    ]
    for (const mutate of mutations) {
      const payload = clone(nativePayload())
      mutate(payload)
      expect(() => validateNativeResolverPayload(payload)).toThrow(ResolverSchemaError)
    }
  })
})

describe('public appearance schema', () => {
  it('binds the complete strict output to its canonical revision', () => {
    const appearance = projectNativeAppearance(nativePayload())
    expect(validateGhosttyConfigAppearance(appearance)).toEqual(appearance)

    const changed = clone(appearance) as unknown as Record<string, unknown>
    changed.diagnosticCount = 1
    expect(() => validateGhosttyConfigAppearance(changed)).toThrow(ResolverSchemaError)
  })

  it('rejects unknown keys, duplicate/out-of-order degradations, and fidelity mismatch', () => {
    const appearance = projectNativeAppearance(nativePayload())
    const unknown = clone(appearance) as unknown as Record<string, unknown>
    unknown.extra = true
    expect(() => validateGhosttyConfigAppearance(unknown)).toThrow(ResolverSchemaError)

    const duplicate = clone(appearance)
    const profile = duplicate.profiles.light as unknown as Record<string, unknown>
    profile.degradedFeatures = ['display-p3', 'display-p3']
    profile.fidelity = 'best-effort'
    expect(() => validateGhosttyConfigAppearance(duplicate)).toThrow(ResolverSchemaError)

    const inconsistent = clone(appearance)
    ;(inconsistent.profiles.light as unknown as Record<string, unknown>).fidelity = 'best-effort'
    expect(() => validateGhosttyConfigAppearance(inconsistent)).toThrow(ResolverSchemaError)
  })

  it('rejects unknown keys recursively throughout the public document', () => {
    const mutations: ((value: ReturnType<typeof projectNativeAppearance>) => void)[] = [
      (value) => void ((value.profiles as unknown as Record<string, unknown>).extra = true),
      (value) => void ((value.profiles.light as unknown as Record<string, unknown>).extra = true),
      (value) =>
        void ((value.profiles.light.theme as unknown as Record<string, unknown>).extra = true),
      (value) =>
        void ((value.profiles.light.surface as unknown as Record<string, unknown>).extra = true),
      (value) =>
        void ((value.profiles.light.theme.background as unknown as Record<string, unknown>).extra =
          true),
      (value) =>
        void ((value.profiles.light.theme.palette[0] as unknown as Record<string, unknown>).extra =
          true),
    ]
    for (const mutate of mutations) {
      const appearance = clone(projectNativeAppearance(nativePayload()))
      mutate(appearance)
      expect(() => validateGhosttyConfigAppearance(appearance)).toThrow(ResolverSchemaError)
    }
  })

  it('does not accept a noncanonical native payload after reserialization', () => {
    const payload = nativePayload()
    const reordered = Buffer.from(
      `${JSON.stringify({
        upstreamRevision: payload.upstreamRevision,
        profiles: payload.profiles,
        nativeSchemaVersion: payload.nativeSchemaVersion,
        diagnosticCount: payload.diagnosticCount,
      })}\n`,
    )
    expect(reordered.equals(canonicalObjectBytes(payload))).toBe(false)
    expect(() => parseCanonicalNativePayload(reordered)).toThrow(ResolverSchemaError)
  })
})
