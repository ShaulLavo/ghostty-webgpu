export interface RendererPlatform {
  readonly platform: string
  readonly userAgent: string
  readonly userAgentData?: { readonly platform: string }
}

export const rendererPlatforms: readonly {
  readonly name: string
  readonly navigator: RendererPlatform
  readonly backend: 'webgpu' | 'webgl2'
}[] = [
  {
    name: 'Linux client hints',
    navigator: { platform: 'Linux x86_64', userAgent: '', userAgentData: { platform: 'Linux' } },
    backend: 'webgl2',
  },
  {
    name: 'Linux legacy platform',
    navigator: { platform: 'Linux x86_64', userAgent: '' },
    backend: 'webgl2',
  },
  {
    name: 'macOS',
    navigator: { platform: 'MacIntel', userAgent: '', userAgentData: { platform: 'macOS' } },
    backend: 'webgpu',
  },
  {
    name: 'Windows',
    navigator: { platform: 'Win32', userAgent: '', userAgentData: { platform: 'Windows' } },
    backend: 'webgpu',
  },
  {
    name: 'Android client hints',
    navigator: { platform: 'Linux armv8l', userAgent: '', userAgentData: { platform: 'Android' } },
    backend: 'webgpu',
  },
  {
    name: 'Android legacy platform',
    navigator: { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 16)' },
    backend: 'webgpu',
  },
  {
    name: 'ChromeOS client hints',
    navigator: {
      platform: 'Linux x86_64',
      userAgent: '',
      userAgentData: { platform: 'Chrome OS' },
    },
    backend: 'webgpu',
  },
  {
    name: 'ChromeOS legacy platform',
    navigator: { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0)' },
    backend: 'webgpu',
  },
  {
    name: 'client hints precedence',
    navigator: { platform: 'Linux x86_64', userAgent: '', userAgentData: { platform: 'Windows' } },
    backend: 'webgpu',
  },
  {
    name: 'unknown platform',
    navigator: { platform: '', userAgent: '' },
    backend: 'webgpu',
  },
]
