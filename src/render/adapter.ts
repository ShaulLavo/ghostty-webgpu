interface AdapterIdentity {
  readonly isFallbackAdapter?: boolean
  readonly info: {
    readonly isFallbackAdapter?: boolean
    readonly vendor?: string
    readonly architecture?: string
    readonly device?: string
    readonly description?: string
  }
}

export function isSoftwareWebGpuAdapter(adapter: AdapterIdentity): boolean {
  if (adapter.isFallbackAdapter || adapter.info.isFallbackAdapter) return true
  const { vendor, architecture, device, description } = adapter.info
  return /swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render driver|\bwarp\b/i.test(
    [vendor, architecture, device, description].join(' '),
  )
}
