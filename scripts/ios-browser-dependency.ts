import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const frameworkRelease = Object.freeze({
  version: '0.0.118',
  hostInterface: 2,
  integrity:
    'sha512-yBllnd7CBVIco2/xh8vezDR0bE+0aD3DIFIcuYDJLWKxxpssRjw0+/3r8nQ03u8sGhYeSdBBcduNtDg3RT8ljw==',
  source: '6e0608451a3f89c1fa0e4f17dacdc6edc5cbc900',
  url: 'https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.118/waffle-0.0.118.tgz',
  bytes: 3649408,
  sha256: '497fdc09ad477c96b2a8a8b8dbd8b7606863de014da7b62b8001ea91498ac55e',
})

export const frameworkRelayRelease = Object.freeze({
  version: '0.0.118',
  hostInterface: frameworkRelease.hostInterface,
  source: frameworkRelease.source,
  url: 'https://github.com/ShaulLavo/waffle/releases/download/waffle-v0.0.118/waffle-relay-0.0.118.tgz',
  bytes: 110373,
  sha256: 'df89924c8f1afbeb990e2943d2055dbd5af478884fc22ab09d45b4af6696d56e',
  integrity:
    'sha512-PzzSysjKoJ7v4otoRs0G/nINWEQZGd53lOnlEvvXsCP2miMJm+FQH4U6WPIbXxQgDDPVhxGGxv03SMpba529Jg==',
})

export const frameworkProgramsRelease = Object.freeze({
  version: '0.0.20',
  tag: 'programs-v0.0.20',
  hostInterface: frameworkRelease.hostInterface,
  source: '3050f69d810fe7c851e487135517698b5dfd93e5',
  toolSource: frameworkRelease.source,
  manifestSha256: '60854e4b421005a4f45b9435be9d0735b031351bb2e5338ef7e7eeddef77a3e9',
  checksumsSha256: '74f1c6c075cbf3feec00cc2252592697d09a242138c5f4d4388850818d33ccad',
})

export const frameworkBaseRelease = Object.freeze({
  version: frameworkProgramsRelease.version,
  hostInterface: frameworkProgramsRelease.hostInterface,
  source: frameworkProgramsRelease.source,
  url: 'https://github.com/ShaulLavo/waffle/releases/download/programs-v0.0.20/waffle-base-0.0.20.tgz',
  bytes: 1662,
  sha256: 'b1961e68569524423cd45c0e7c718b3353a9af6be5f86a50a560c7d5154452e2',
  integrity:
    'sha512-wxmoRgvEE6RFC6cEB/LCi1XCkL1kZV1l/muT09wgCSLYKimVngcc24iCZQj9nFFscnM+cjiEmNrUAblDpS1HrA==',
})

export async function checkFrameworkArchive(path: string): Promise<void> {
  const bytes = await readFile(path)
  if (
    bytes.byteLength !== frameworkRelease.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== frameworkRelease.sha256
  )
    throw new Error(`Expected the published Waffle ${frameworkRelease.version} runtime archive`)
}
