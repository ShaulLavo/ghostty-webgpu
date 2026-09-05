import { validateNativeResolverPayload } from '../../src/config-resolver/schema'
import type { NativeResolverPayload } from '../../src/config-resolver/types'
import { NATIVE_UPSTREAM_REVISION } from './constants'

export function nativeProtocolGoldenPayload(): NativeResolverPayload {
  const palette = Array.from({ length: 256 }, (_, index) => ({
    r: index,
    g: 255 - index,
    b: index ^ 0xaa,
  }))
  const light = {
    background: { r: 247, g: 247, b: 247 },
    foreground: { r: 74, g: 69, b: 67 },
    cursorColor: { kind: 'cell-foreground' as const },
    cursorText: { kind: 'rgb' as const, value: { r: 247, g: 247, b: 247 } },
    selectionBackground: { kind: 'unset' as const },
    selectionForeground: { kind: 'cell-background' as const },
    minimumContrast: 4.5,
    palette,
    windowColorspace: 'display-p3' as const,
    surface: {
      backgroundOpacity: 0.0000001,
      backgroundOpacityCells: true,
      backgroundBlur: { kind: 'radius' as const, value: 20 },
    },
  }
  const dark = {
    ...light,
    background: { r: 33, g: 33, b: 33 },
    foreground: { r: 208, g: 208, b: 208 },
    surface: {
      backgroundOpacity: 0.000001,
      backgroundOpacityCells: false,
      backgroundBlur: { kind: 'macos-glass' as const, variant: 'regular' as const },
    },
  }
  return validateNativeResolverPayload({
    nativeSchemaVersion: 1,
    upstreamRevision: NATIVE_UPSTREAM_REVISION,
    diagnosticCount: 65_535,
    profiles: { light, dark },
  })
}
