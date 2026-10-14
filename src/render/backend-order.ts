export type GpuBackend = 'webgpu' | 'webgl'

export function isDesktopLinux(platform: string, userAgent: string): boolean {
  return /^Linux(?:\s|$)/.test(platform) && !/\b(?:Android|CrOS)\b/.test(userAgent)
}

export function automaticGpuBackends(
  presentation: 'frame' | 'immediate' = 'frame',
): readonly [GpuBackend, GpuBackend] {
  // Only WebGL2 and Canvas 2D contexts accept `desynchronized`.
  if (presentation === 'immediate') return ['webgl', 'webgpu']
  const clientPlatform = (
    navigator as Navigator & {
      readonly userAgentData?: { readonly platform: string }
    }
  ).userAgentData?.platform
  return isDesktopLinux(clientPlatform ?? navigator.platform, navigator.userAgent)
    ? ['webgl', 'webgpu']
    : ['webgpu', 'webgl']
}
