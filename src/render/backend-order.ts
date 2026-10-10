export type GpuBackend = 'webgpu' | 'webgl'

export function isDesktopLinux(platform: string, userAgent: string): boolean {
  return /^Linux(?:\s|$)/.test(platform) && !/\b(?:Android|CrOS)\b/.test(userAgent)
}

export function automaticGpuBackends(): readonly [GpuBackend, GpuBackend] {
  const clientPlatform = (
    navigator as Navigator & {
      readonly userAgentData?: { readonly platform: string }
    }
  ).userAgentData?.platform
  return isDesktopLinux(clientPlatform ?? navigator.platform, navigator.userAgent)
    ? ['webgl', 'webgpu']
    : ['webgpu', 'webgl']
}
