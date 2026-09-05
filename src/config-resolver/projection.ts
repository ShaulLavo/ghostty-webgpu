import { canonicalObjectSha256 } from './canonicalize.js'
import { GHOSTTY_CONFIG_DEGRADED_FEATURES, validateGhosttyConfigAppearance } from './schema.js'
import {
  GHOSTTY_CONFIG_UPSTREAM_REVISION,
  type GhosttyConfigAppearance,
  type GhosttyConfigAppearancePreimage,
  type GhosttyConfigDegradedFeature,
  type GhosttyConfigProfile,
  type GhosttyConfigRgb,
  type NativeColor,
  type NativeProfile,
  type NativeResolverPayload,
  type NativeRgb,
} from './types.js'

type Matrix = readonly (readonly number[])[]
type ColorField =
  | 'cursor-color-cell-reference'
  | 'cursor-text-cell-reference'
  | 'selection-background-cell-reference'
  | 'selection-foreground-cell-reference'

const P3_TO_XYZ: Matrix = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
]
const XYZ_TO_SRGB: Matrix = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
]

export function projectNativeAppearance(payload: NativeResolverPayload): GhosttyConfigAppearance {
  const preimage: GhosttyConfigAppearancePreimage = {
    diagnosticCount: payload.diagnosticCount,
    profiles: {
      dark: projectProfile(payload.profiles.dark),
      light: projectProfile(payload.profiles.light),
    },
    schemaVersion: 1,
    upstreamRevision: GHOSTTY_CONFIG_UPSTREAM_REVISION,
  }
  const appearance: GhosttyConfigAppearance = {
    ...preimage,
    revision: canonicalObjectSha256(preimage),
  }
  return validateGhosttyConfigAppearance(appearance)
}

function projectProfile(profile: NativeProfile): GhosttyConfigProfile {
  const degraded = new Set<GhosttyConfigDegradedFeature>()
  const convert = profile.windowColorspace === 'display-p3'
  if (convert) degraded.add('display-p3')

  const background = projectRgb(profile.background, convert)
  const foreground = projectRgb(profile.foreground, convert)
  const cursor = projectColor(
    profile.cursorColor,
    foreground,
    background,
    foreground,
    'cursor-color-cell-reference',
    convert,
    degraded,
  )
  const cursorText = projectColor(
    profile.cursorText,
    foreground,
    background,
    background,
    'cursor-text-cell-reference',
    convert,
    degraded,
  )
  const selectionBackground = projectColor(
    profile.selectionBackground,
    foreground,
    background,
    foreground,
    'selection-background-cell-reference',
    convert,
    degraded,
  )
  const selectionForeground = projectColor(
    profile.selectionForeground,
    foreground,
    background,
    background,
    'selection-foreground-cell-reference',
    convert,
    degraded,
  )
  const backgroundBlurRadius = projectBlur(profile, degraded)
  if (profile.surface.backgroundOpacityCells) degraded.add('background-opacity-cells')
  const degradedFeatures = orderedDegradations(degraded)
  return {
    degradedFeatures,
    fidelity: degradedFeatures.length === 0 ? 'exact' : 'best-effort',
    surface: {
      backgroundBlurRadius,
      backgroundOpacity: profile.surface.backgroundOpacity,
      backgroundOpacityCells: profile.surface.backgroundOpacityCells,
    },
    theme: {
      background,
      cursor,
      cursorText,
      foreground,
      minimumContrast: profile.minimumContrast,
      palette: profile.palette.map((color) => projectRgb(color, convert)),
      selectionBackground,
      selectionForeground,
    },
  }
}

function projectColor(
  color: NativeColor,
  foreground: GhosttyConfigRgb,
  background: GhosttyConfigRgb,
  unset: GhosttyConfigRgb,
  degradation: ColorField,
  convert: boolean,
  degraded: Set<GhosttyConfigDegradedFeature>,
): GhosttyConfigRgb {
  if (color.kind === 'unset') return copyRgb(unset)
  if (color.kind === 'rgb') return projectRgb(color.value, convert)
  degraded.add(degradation)
  if (color.kind === 'cell-foreground') return copyRgb(foreground)
  return copyRgb(background)
}

function projectBlur(profile: NativeProfile, degraded: Set<GhosttyConfigDegradedFeature>): number {
  const blur = profile.surface.backgroundBlur
  if (blur.kind === 'none') return 0
  if (blur.kind === 'macos-glass') {
    degraded.add('macos-glass')
    return 0
  }
  if (blur.value > 0) degraded.add('background-blur')
  return blur.value
}

function orderedDegradations(
  values: ReadonlySet<GhosttyConfigDegradedFeature>,
): readonly GhosttyConfigDegradedFeature[] {
  return GHOSTTY_CONFIG_DEGRADED_FEATURES.filter((value) => values.has(value))
}

function projectRgb(value: NativeRgb, convert: boolean): GhosttyConfigRgb {
  if (!convert) return copyRgb(value)
  return displayP3ToSrgb(value)
}

function copyRgb(value: NativeRgb | GhosttyConfigRgb): GhosttyConfigRgb {
  return { b: value.b, g: value.g, r: value.r }
}

export function displayP3ToSrgb(input: NativeRgb): GhosttyConfigRgb {
  const encoded = convertDisplayP3Raw(input)
  return {
    b: roundHalfUp(encoded[2]!),
    g: roundHalfUp(encoded[1]!),
    r: roundHalfUp(encoded[0]!),
  }
}

export function convertDisplayP3Raw(input: NativeRgb): readonly number[] {
  const linearP3 = [input.r, input.g, input.b].map((channel) => decodeColor(channel / 255))
  const xyz = multiplyMatrix(P3_TO_XYZ, linearP3)
  const linearSrgb = multiplyMatrix(XYZ_TO_SRGB, xyz)
  return linearSrgb.map((channel) => encodeColor(clampColor(channel)) * 255)
}

function multiplyMatrix(matrix: Matrix, vector: readonly number[]): readonly number[] {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index]!, 0))
}

function decodeColor(channel: number): number {
  if (channel <= 0.04045) return channel / 12.92
  return ((channel + 0.055) / 1.055) ** 2.4
}

function encodeColor(channel: number): number {
  if (channel <= 0.0031308) return 12.92 * channel
  return 1.055 * channel ** (1 / 2.4) - 0.055
}

function clampColor(channel: number): number {
  return Math.max(0, Math.min(1, channel))
}

function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5)
}
