type AdapterInfo = Pick<GPUAdapterInfo, 'vendor' | 'architecture' | 'description'> &
  Partial<Pick<GPUAdapterInfo, 'isFallbackAdapter'>>

export type DeviceReplacementQualification =
  | { kind: 'run' }
  | { kind: 'skip'; reason: string }
  | { kind: 'unresolved'; reason: string }

const hardwareVendors = new Set([
  'amd',
  'nvidia',
  'intel',
  'apple',
  'arm',
  'qualcomm',
  'imagination',
  'broadcom',
  'samsung',
])

export function qualifyDeviceReplacement(
  info: AdapterInfo | undefined,
  userAgent: string,
): DeviceReplacementQualification {
  const swiftShader =
    info?.architecture.toLowerCase() === 'swiftshader' ||
    /\bswiftshader\b/i.test(info?.description ?? '')
  if (swiftShader) {
    if (!userAgent.includes('Linux')) return { kind: 'run' }
    return {
      kind: 'skip',
      reason: 'Linux SwiftShader cannot configure an independent replacement device.',
    }
  }
  if (info?.isFallbackAdapter === false && hardwareVendors.has(info.vendor.toLowerCase())) {
    return { kind: 'run' }
  }
  return {
    kind: 'unresolved',
    reason: 'WebGPU adapter info does not identify a non-fallback hardware adapter or SwiftShader.',
  }
}
