import { describe, expect, it } from 'vitest'
import {
  validateXtermPackagePin,
  validateXtermSubmoduleSnapshot,
  XtermReferenceError,
  type XtermPackagePin,
  type XtermPackagePinSnapshot,
  type XtermSubmoduleSnapshot,
} from '../../../scripts/xterm-reference.js'

const source = Object.freeze({
  commit: '08ad9a4de9252f387cc5fbf68aa3d98e0ba8a0b7',
  url: 'https://github.com/xtermjs/xterm.js.git',
})

const submodule = Object.freeze<XtermSubmoduleSnapshot>({
  configuredPath: 'references/xterm.js',
  configuredUrl: source.url,
  dirty: '',
  headCommit: source.commit,
  headRef: 'HEAD',
  indexCommit: source.commit,
  originUrl: source.url,
})

const packagePin = Object.freeze<XtermPackagePin>({
  commit: 'f447274f430fd22513f6adbf9862d19524471c04',
  name: '@xterm/xterm',
  version: '6.0.0',
})

function submoduleSnapshot(overrides: Partial<XtermSubmoduleSnapshot>): XtermSubmoduleSnapshot {
  return { ...submodule, ...overrides }
}

function packageSnapshot(overrides: Partial<XtermPackagePinSnapshot>): XtermPackagePinSnapshot {
  return { ...packagePin, ...overrides }
}

describe('xterm submodule identity validation', () => {
  it('accepts a clean snapshot at the pinned source', () => {
    expect(() => validateXtermSubmoduleSnapshot(submodule, source)).not.toThrow()
  })

  it.each([
    ['configured URL', 'configuredUrl', 'submodule URL'],
    ['origin URL', 'originUrl', 'submodule origin'],
  ] as const)('rejects the wrong %s', (_case, field, label) => {
    const snapshot = submoduleSnapshot({ [field]: 'https://example.com/wrong.git' })

    expect(() => validateXtermSubmoduleSnapshot(snapshot, source)).toThrow(
      `${label}: expected ${source.url}, received https://example.com/wrong.git`,
    )
  })

  it.each([
    ['source HEAD', 'headCommit', 'submodule HEAD'],
    ['source index commit', 'indexCommit', 'submodule index commit'],
  ] as const)('rejects the wrong %s', (_case, field, label) => {
    const snapshot = submoduleSnapshot({ [field]: '0000000000000000000000000000000000000000' })

    expect(() => validateXtermSubmoduleSnapshot(snapshot, source)).toThrow(
      `${label}: expected ${source.commit}, received 0000000000000000000000000000000000000000`,
    )
  })

  it('rejects a dirty source snapshot', () => {
    const dirty = ' M typings/xterm.d.ts\n?? generated.txt'

    expect(() => validateXtermSubmoduleSnapshot(submoduleSnapshot({ dirty }), source)).toThrow(
      `xterm reference is dirty:\n${dirty}`,
    )
  })

  it('rejects a branch-attached source snapshot', () => {
    expect(() =>
      validateXtermSubmoduleSnapshot(submoduleSnapshot({ headRef: 'master' }), source),
    ).toThrow('submodule HEAD ref: expected HEAD, received master')
  })
})

describe('xterm package pin validation', () => {
  it('accepts the installed package identity at the release pin', () => {
    expect(() => validateXtermPackagePin(packageSnapshot({}), packagePin)).not.toThrow()
  })

  it('rejects the wrong released package commit', () => {
    const snapshot = packageSnapshot({ commit: source.commit })

    expect(() => validateXtermPackagePin(snapshot, packagePin)).toThrow(
      `${packagePin.name} release commit: expected ${packagePin.commit}, received ${source.commit}`,
    )
  })

  it('rejects the wrong installed package version', () => {
    const snapshot = packageSnapshot({ version: '5.5.0' })

    expect(() => validateXtermPackagePin(snapshot, packagePin)).toThrow(
      `${packagePin.name} version: expected ${packagePin.version}, received 5.5.0`,
    )
  })

  it('uses the reference error type for identity failures', () => {
    expect(() =>
      validateXtermPackagePin(packageSnapshot({ version: '5.5.0' }), packagePin),
    ).toThrow(XtermReferenceError)
  })
})
