import { describe, expect, it, vi } from 'vitest'

import type { NativeCompatibility, VerifiedResolverBundle } from '../manifest.js'
import { projectNativeAppearance } from '../projection.js'
import {
  resolveGhosttyConfigAppearanceWithDependencies,
  type ResolverDependencies,
} from '../resolve.js'
import { canonicalNativePayload, nativePayload } from './fixtures.js'

const staticLinux: NativeCompatibility = {
  dynamicDependencies: [],
  interpreter: null,
  libc: 'none',
  os: 'linux',
}
const bundle: VerifiedResolverBundle = {
  compatibility: staticLinux,
  cwd: '/package',
  executable: '/package/native/linux-x64/bin/resolver',
  resources: '/package/native/linux-x64/resources',
  target: 'linux-x64',
}

function dependencies(overrides: Partial<ResolverDependencies> = {}): ResolverDependencies {
  return {
    architecture: 'x64',
    environment: {},
    hostCompatible: () => true,
    loadBundle: async () => bundle,
    parse: () => nativePayload(),
    platform: 'linux',
    project: projectNativeAppearance,
    run: async () => ({ bytes: canonicalNativePayload(), kind: 'output' }),
    ...overrides,
  }
}

describe('resolveGhosttyConfigAppearance', () => {
  it('returns only the projected bounded appearance on success', async () => {
    const result = await resolveGhosttyConfigAppearanceWithDependencies(dependencies())
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') return
    expect(result.appearance).toEqual(projectNativeAppearance(nativePayload()))
  })

  it('does not inspect assets or spawn on unsupported hosts', async () => {
    const loadBundle = vi.fn(async () => bundle)
    const run = vi.fn(async () => ({ bytes: Buffer.alloc(0), kind: 'output' as const }))
    const result = await resolveGhosttyConfigAppearanceWithDependencies(
      dependencies({ architecture: 'ia32', loadBundle, platform: 'win32', run }),
    )
    expect(result).toEqual({ reason: 'unsupported-platform', status: 'unavailable' })
    expect(loadBundle).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('verifies host compatibility before spawning', async () => {
    const run = vi.fn(async () => ({ bytes: Buffer.alloc(0), kind: 'output' as const }))
    const result = await resolveGhosttyConfigAppearanceWithDependencies(
      dependencies({ hostCompatible: () => false, run }),
    )
    expect(result).toEqual({ reason: 'unsupported-platform', status: 'unavailable' })
    expect(run).not.toHaveBeenCalled()
  })

  it('preserves fixed process reasons and erases internal failures', async () => {
    const missing = await resolveGhosttyConfigAppearanceWithDependencies(
      dependencies({ run: async () => ({ kind: 'unavailable', reason: 'config-not-found' }) }),
    )
    expect(missing).toEqual({ reason: 'config-not-found', status: 'unavailable' })

    const loadFailure = await resolveGhosttyConfigAppearanceWithDependencies(
      dependencies({
        loadBundle: async () => {
          throw new Error('/private/PLAN066_SECRET_SENTINEL')
        },
      }),
    )
    expect(loadFailure).toEqual({ reason: 'resolver-failed', status: 'unavailable' })

    const runFailure = await resolveGhosttyConfigAppearanceWithDependencies(
      dependencies({
        run: async () => {
          throw new Error('native stderr must not escape')
        },
      }),
    )
    expect(runFailure).toEqual({ reason: 'resolver-failed', status: 'unavailable' })
  })

  it('maps malformed native bytes and projection failures to invalid-output', async () => {
    const parseFailure = await resolveGhosttyConfigAppearanceWithDependencies(
      dependencies({
        parse: () => {
          throw new Error('raw native output')
        },
      }),
    )
    expect(parseFailure).toEqual({ reason: 'invalid-output', status: 'unavailable' })

    const projectionFailure = await resolveGhosttyConfigAppearanceWithDependencies(
      dependencies({
        project: () => {
          throw new Error('projection failure')
        },
      }),
    )
    expect(projectionFailure).toEqual({ reason: 'invalid-output', status: 'unavailable' })
  })
})
