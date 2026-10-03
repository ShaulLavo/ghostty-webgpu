import { expect, it } from 'vitest'
import { qualifyDeviceReplacement } from './adapter-qualification.js'

const hardware = {
  architecture: 'ampere',
  description: '',
  isFallbackAdapter: false,
  vendor: 'nvidia',
}
const swiftShader = {
  architecture: 'swiftshader',
  description: '',
  isFallbackAdapter: true,
  vendor: 'google',
}

it.each(['Linux', 'Windows NT 10.0', 'Macintosh'])(
  'runs replacement coverage on identified hardware with a %s user agent',
  (userAgent) => {
    expect(qualifyDeviceReplacement(hardware, userAgent)).toEqual({ kind: 'run' })
  },
)

it('skips positively identified Linux SwiftShader with the teardown limitation', () => {
  expect(qualifyDeviceReplacement(swiftShader, 'Linux')).toEqual({
    kind: 'skip',
    reason: 'Linux SwiftShader cannot configure an independent replacement device.',
  })
})

it.each(['Windows NT 10.0', 'Macintosh'])(
  'preserves SwiftShader coverage with a %s user agent',
  (userAgent) => {
    expect(qualifyDeviceReplacement(swiftShader, userAgent)).toEqual({ kind: 'run' })
  },
)

it('recognizes SwiftShader when only the driver description identifies it', () => {
  expect(
    qualifyDeviceReplacement(
      { ...swiftShader, architecture: '', description: 'SwiftShader Device (Subzero)' },
      'Linux',
    ).kind,
  ).toBe('skip')
})

it.each(['amd', 'intel', 'apple', 'arm', 'qualcomm', 'imagination', 'broadcom', 'samsung'])(
  'runs coverage on a non-fallback %s adapter',
  (vendor) => {
    expect(qualifyDeviceReplacement({ ...hardware, vendor }, 'Linux')).toEqual({ kind: 'run' })
  },
)

it.each([
  undefined,
  { architecture: '', description: '', isFallbackAdapter: false, vendor: '' },
  { ...hardware, vendor: 'unknown' },
  { ...hardware, isFallbackAdapter: true },
  { ...hardware, isFallbackAdapter: undefined },
  { architecture: 'software', description: 'llvmpipe', isFallbackAdapter: true, vendor: 'mesa' },
])('reports unresolved adapter identity without granting a software skip', (info) => {
  const qualification = qualifyDeviceReplacement(info, 'Linux')
  expect(qualification.kind).toBe('unresolved')
  expect(qualification).toHaveProperty(
    'reason',
    'WebGPU adapter info does not identify a non-fallback hardware adapter or SwiftShader.',
  )
})
