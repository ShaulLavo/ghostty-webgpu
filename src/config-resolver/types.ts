export const GHOSTTY_CONFIG_UPSTREAM_REVISION = 'c8554f28e0efe2f5595f32020371c34b25ec628f' as const

export interface GhosttyConfigRgb {
  readonly b: number
  readonly g: number
  readonly r: number
}

export type GhosttyConfigDegradedFeature =
  | 'background-blur'
  | 'background-opacity-cells'
  | 'cursor-color-cell-reference'
  | 'cursor-text-cell-reference'
  | 'selection-background-cell-reference'
  | 'selection-foreground-cell-reference'
  | 'display-p3'
  | 'macos-glass'

export interface GhosttyConfigTheme {
  readonly background: GhosttyConfigRgb
  readonly cursor: GhosttyConfigRgb
  readonly cursorText: GhosttyConfigRgb
  readonly foreground: GhosttyConfigRgb
  readonly minimumContrast: number
  readonly palette: readonly GhosttyConfigRgb[]
  readonly selectionBackground: GhosttyConfigRgb
  readonly selectionForeground: GhosttyConfigRgb
}

export interface GhosttyConfigSurface {
  readonly backgroundBlurRadius: number
  readonly backgroundOpacity: number
  readonly backgroundOpacityCells: boolean
}

export interface GhosttyConfigProfile {
  readonly degradedFeatures: readonly GhosttyConfigDegradedFeature[]
  readonly fidelity: 'best-effort' | 'exact'
  readonly surface: GhosttyConfigSurface
  readonly theme: GhosttyConfigTheme
}

export interface GhosttyConfigAppearance {
  readonly diagnosticCount: number
  readonly profiles: {
    readonly dark: GhosttyConfigProfile
    readonly light: GhosttyConfigProfile
  }
  readonly revision: string
  readonly schemaVersion: 1
  readonly upstreamRevision: typeof GHOSTTY_CONFIG_UPSTREAM_REVISION
}

export type GhosttyConfigUnavailableReason =
  | 'config-not-found'
  | 'invalid-output'
  | 'output-limit'
  | 'resolver-failed'
  | 'timeout'
  | 'unsupported-platform'

export type GhosttyConfigResolveResult =
  | { readonly appearance: GhosttyConfigAppearance; readonly status: 'ready' }
  | { readonly reason: GhosttyConfigUnavailableReason; readonly status: 'unavailable' }

export interface NativeRgb {
  readonly b: number
  readonly g: number
  readonly r: number
}

export type NativeColor =
  | { readonly kind: 'unset' }
  | { readonly kind: 'rgb'; readonly value: NativeRgb }
  | { readonly kind: 'cell-foreground' }
  | { readonly kind: 'cell-background' }

export type NativeBlur =
  | { readonly kind: 'none' }
  | { readonly kind: 'radius'; readonly value: number }
  | { readonly kind: 'macos-glass'; readonly variant: 'clear' | 'regular' }

export interface NativeProfile {
  readonly background: NativeRgb
  readonly cursorColor: NativeColor
  readonly cursorText: NativeColor
  readonly foreground: NativeRgb
  readonly minimumContrast: number
  readonly palette: readonly NativeRgb[]
  readonly selectionBackground: NativeColor
  readonly selectionForeground: NativeColor
  readonly surface: {
    readonly backgroundBlur: NativeBlur
    readonly backgroundOpacity: number
    readonly backgroundOpacityCells: boolean
  }
  readonly windowColorspace: 'display-p3' | 'srgb'
}

export interface NativeResolverPayload {
  readonly diagnosticCount: number
  readonly nativeSchemaVersion: 1
  readonly profiles: { readonly dark: NativeProfile; readonly light: NativeProfile }
  readonly upstreamRevision: typeof GHOSTTY_CONFIG_UPSTREAM_REVISION
}

export type GhosttyConfigAppearancePreimage = Omit<GhosttyConfigAppearance, 'revision'>
