import { canonicalObjectBytes } from '../canonicalize.js'
import {
  GHOSTTY_CONFIG_UPSTREAM_REVISION,
  type NativeProfile,
  type NativeResolverPayload,
  type NativeRgb,
} from '../types.js'

export function rgb(r: number, g: number, b: number): NativeRgb {
  return { b, g, r }
}

export function nativeProfile(overrides: Partial<NativeProfile> = {}): NativeProfile {
  return {
    background: rgb(9, 8, 7),
    cursorColor: { kind: 'unset' },
    cursorText: { kind: 'unset' },
    foreground: rgb(240, 241, 242),
    minimumContrast: 1,
    palette: Array.from({ length: 256 }, (_, index) => rgb(index, index, index)),
    selectionBackground: { kind: 'unset' },
    selectionForeground: { kind: 'unset' },
    surface: {
      backgroundBlur: { kind: 'none' },
      backgroundOpacity: 1,
      backgroundOpacityCells: false,
    },
    windowColorspace: 'srgb',
    ...overrides,
  }
}

export function nativePayload(
  profiles: NativeResolverPayload['profiles'] = {
    dark: nativeProfile(),
    light: nativeProfile(),
  },
): NativeResolverPayload {
  return {
    diagnosticCount: 0,
    nativeSchemaVersion: 1,
    profiles,
    upstreamRevision: GHOSTTY_CONFIG_UPSTREAM_REVISION,
  }
}

export function canonicalNativePayload(payload = nativePayload()): Buffer {
  return canonicalObjectBytes(payload)
}
