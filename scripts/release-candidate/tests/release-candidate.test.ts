import {
  canonicalObjectBytes,
  canonicalSha256,
  sha256,
} from '../../config-resolver-native/canonical'
import {
  NATIVE_BOOTSTRAP_PATH,
  NATIVE_MANIFEST_PATH,
  NATIVE_TARGET_CONFIG,
  NATIVE_TARGETS,
} from '../../config-resolver-native/constants'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseReleaseCandidateArguments } from '../cli'
import { assertArtifactUnchanged, readArtifactSnapshot } from '../artifacts'
import {
  finalizeReleaseCandidate,
  packReleaseCandidate,
  requireExactDirectoryFiles,
  verifyReleaseCandidate,
} from '../core'
import {
  RELEASE_EVIDENCE_FILE,
  RELEASE_IDENTITY_FILE,
  RELEASE_PROVISIONAL_FILE,
  RELEASE_TARBALL_FILE,
} from '../constants'
import { constructReleaseCandidate } from '../bundle'
import { validateNpmPackJson, verifyPackedPackage } from '../package'
import { createReleaseSmokeProvenance, verifyReleaseRebuildProvenance } from '../provenance'
import { parseReleaseProvenanceArguments } from '../provenance-cli'
import {
  requireGeneratedOnlyPackageDiff,
  requireVerifierAtHead,
  type CommandResult,
  type CommandRunner,
} from '../repository'
import { inspectPackageTarball } from '../tar'
import {
  validateReleaseCandidateEvidence,
  validateReleaseCandidateIdentity,
  validateReleaseCandidateProvisional,
  validateReleaseSmokeProvenance,
} from '../validation'
import {
  PACKAGE_HEAD,
  RELEASE_RUN_ATTEMPT,
  RELEASE_RUN_ID,
  createReleaseFixture,
  createTar,
  type ReleaseFixture,
} from './fixtures'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true })
})

describe('release candidate strict schemas', () => {
  it('accepts exact provisional, smoke, evidence, and identity schemas', () => {
    const fixture = createReleaseFixture()
    const packed = verifyPackedPackage(fixture.tarball)
    const constructed = constructReleaseCandidate(
      fixture.provisional,
      canonicalSha256(fixture.provisional),
      packed,
      fixture.rebuild,
      fixture.smoke,
    )
    expect(validateReleaseCandidateProvisional(fixture.provisional)).toEqual(fixture.provisional)
    for (const target of NATIVE_TARGETS) {
      expect(validateReleaseSmokeProvenance(fixture.smoke[target])).toEqual(fixture.smoke[target])
    }
    expect(validateReleaseCandidateEvidence(constructed.evidence)).toEqual(constructed.evidence)
    expect(validateReleaseCandidateIdentity(constructed.identity)).toEqual(constructed.identity)
  })

  it('rejects recursively unknown fields and non-pass smoke evidence', () => {
    const fixture = createReleaseFixture()
    const provisional = structuredClone(fixture.provisional) as unknown as Record<string, unknown>
    provisional.extra = true
    expect(() => validateReleaseCandidateProvisional(provisional)).toThrow(/unknown or missing/)

    const nested = structuredClone(fixture.provisional) as unknown as {
      tarball: Record<string, unknown>
    }
    nested.tarball.extra = true
    expect(() => validateReleaseCandidateProvisional(nested)).toThrow(/unknown or missing/)

    const smoke = structuredClone(fixture.smoke['linux-x64']) as unknown as {
      checks: Record<string, unknown>
    }
    smoke.checks.privacy = 'fail'
    expect(() => validateReleaseSmokeProvenance(smoke)).toThrow(/does not match/)
  })

  it('binds all evidence and identity preimages', () => {
    const fixture = createReleaseFixture()
    const packed = verifyPackedPackage(fixture.tarball)
    const constructed = constructReleaseCandidate(
      fixture.provisional,
      canonicalSha256(fixture.provisional),
      packed,
      fixture.rebuild,
      fixture.smoke,
    )
    const missingTarget = structuredClone(constructed.evidence) as unknown as {
      releaseSmoke: Record<string, unknown>
    }
    delete missingTarget.releaseSmoke['darwin-arm64']
    expect(() => validateReleaseCandidateEvidence(missingTarget)).toThrow(/unknown or missing/)

    const identity = structuredClone(constructed.identity) as unknown as {
      provenanceSha256: { releaseSmoke: Record<string, unknown> }
    }
    identity.provenanceSha256.releaseSmoke['linux-x64'] = '0'.repeat(64)
    expect(() => validateReleaseCandidateIdentity(identity)).not.toThrow()
    expect(canonicalObjectBytes(identity)).not.toEqual(constructed.identityBytes)
  })

  it('rejects mutations to provisional, rebuild, smoke, and packed-list preimages', () => {
    const fixture = createReleaseFixture()
    const packed = verifyPackedPackage(fixture.tarball)
    const provisional = structuredClone(fixture.provisional)
    ;(provisional as unknown as { tarball: { sha256: string } }).tarball.sha256 = '0'.repeat(64)
    expect(() =>
      constructReleaseCandidate(
        provisional,
        canonicalSha256(provisional),
        packed,
        fixture.rebuild,
        fixture.smoke,
      ),
    ).toThrow(/tarball identity differs/)

    const rebuild = structuredClone(fixture.rebuild)
    ;(rebuild as unknown as { 'linux-x64': { archive: { sha256: string } } })[
      'linux-x64'
    ].archive.sha256 = '0'.repeat(64)
    expect(() =>
      constructReleaseCandidate(
        fixture.provisional,
        canonicalSha256(fixture.provisional),
        packed,
        rebuild,
        fixture.smoke,
      ),
    ).toThrow(/rebuild archive differs/)

    const smoke = structuredClone(fixture.smoke)
    ;(smoke as unknown as { 'darwin-arm64': { tarball: { sha256: string } } })[
      'darwin-arm64'
    ].tarball.sha256 = '0'.repeat(64)
    expect(() =>
      constructReleaseCandidate(
        fixture.provisional,
        canonicalSha256(fixture.provisional),
        packed,
        fixture.rebuild,
        smoke,
      ),
    ).toThrow(/smoke tarball differs/)

    const changedTarball = createTar([
      ...fixture.entries,
      { path: 'package/extra.txt', bytes: Buffer.from('extra'), mode: 0o644 },
    ])
    const changedPacked = verifyPackedPackage(changedTarball)
    expect(() =>
      constructReleaseCandidate(
        fixture.provisional,
        canonicalSha256(fixture.provisional),
        changedPacked,
        fixture.rebuild,
        fixture.smoke,
      ),
    ).toThrow(/packed file-list digest differs/)
  })

  it('freezes nested canonical bytes, UTF-8, integer boundaries, and arrays', () => {
    const value = {
      z: [9_007_199_254_740_991, { '\u00e9': '雪', a: -1 }],
      a: { y: true, x: null },
    }
    expect(canonicalObjectBytes(value).toString('utf8')).toBe(
      '{"a":{"x":null,"y":true},"z":[9007199254740991,{"a":-1,"\u00e9":"雪"}]}\n',
    )
  })

  it('matches the release canonical vectors in Bun and Node', () => {
    const directory = temporaryDirectory('ghostty-release-vectors-')
    const bundle = join(directory, 'canonical-vectors.mjs')
    const source = join(process.cwd(), 'scripts/release-candidate/canonical-vectors.ts')
    const built = spawnSync(
      'bun',
      ['build', source, '--target=node', '--format=esm', `--outfile=${bundle}`],
      { encoding: 'buffer' },
    )
    expect(built.status).toBe(0)
    const bun = spawnSync('bun', [source], { encoding: 'buffer' })
    const node = spawnSync('node', [bundle], { encoding: 'buffer' })
    expect({ bun: bun.status, node: node.status }).toEqual({ bun: 0, node: 0 })
    expect(bun.stderr).toHaveLength(0)
    expect(node.stderr).toHaveLength(0)
    expect(node.stdout).toEqual(bun.stdout)
    expect(JSON.parse(bun.stdout.toString('utf8'))).toEqual({
      schemaVersion: 1,
      status: 'pass',
      vectors: 2,
    })
  })
})

describe('read-only npm tar inspection', () => {
  it('records sorted regular files and accepts canonical directory rows', () => {
    const tarball = createTar([
      { path: 'package/z', bytes: Buffer.from('z'), mode: 0o644 },
      { path: 'package/a/', bytes: Buffer.alloc(0), mode: 0o755, type: '5' },
      { path: 'package/a/x', bytes: Buffer.from('x'), mode: 0o755 },
    ])
    const inspected = inspectPackageTarball(tarball)
    expect(inspected.fileList.files.map((file) => file.path)).toEqual(['a/x', 'z'])
    expect(inspected.directories).toEqual(['a'])
  })

  it.each([
    {
      name: 'traversal',
      entries: [{ path: 'package/../escape', bytes: Buffer.from('x'), mode: 0o644 as const }],
      trailing: Buffer.alloc(0),
    },
    {
      name: 'link',
      entries: [
        {
          path: 'package/link',
          bytes: Buffer.alloc(0),
          mode: 0o644 as const,
          type: '2' as const,
          linkname: 'target',
        },
      ],
      trailing: Buffer.alloc(0),
    },
    {
      name: 'duplicate',
      entries: [
        { path: 'package/a', bytes: Buffer.from('1'), mode: 0o644 as const },
        { path: 'package/a', bytes: Buffer.from('2'), mode: 0o644 as const },
      ],
      trailing: Buffer.alloc(0),
    },
    {
      name: 'mode',
      entries: [{ path: 'package/a', bytes: Buffer.from('x'), mode: 0o600 as 0o644 }],
      trailing: Buffer.alloc(0),
    },
    {
      name: 'trailing data',
      entries: [{ path: 'package/a', bytes: Buffer.from('x'), mode: 0o644 as const }],
      trailing: Buffer.from('x'),
    },
  ])('rejects $name', ({ entries, trailing }) => {
    expect(() => inspectPackageTarball(createTar(entries, trailing))).toThrow()
  })

  it.each(['1', '2', '3', '4', '6', 'x', 'g', 'L', 'K', 'S'])('rejects tar typeflag %s', (type) => {
    expect(() =>
      inspectPackageTarball(
        createTar([{ path: 'package/a', bytes: Buffer.alloc(0), mode: 0o644, type }]),
      ),
    ).toThrow(/entry type/)
  })

  it('rejects regular-file and descendant path conflicts in either order', () => {
    const parent = { path: 'package/a', bytes: Buffer.from('a'), mode: 0o644 as const }
    const child = { path: 'package/a/b', bytes: Buffer.from('b'), mode: 0o644 as const }
    expect(() => inspectPackageTarball(createTar([parent, child]))).toThrow(/beneath/)
    expect(() => inspectPackageTarball(createTar([child, parent]))).toThrow(/contains an existing/)
  })

  it('rejects changed manifest bytes, native asset bytes, and unexpected native paths', () => {
    const fixture = createReleaseFixture()
    const manifest = structuredClone(fixture.manifest)
    ;(
      manifest as unknown as {
        targets: { 'linux-x64': { assemblyProvenanceSha256: string } }
      }
    ).targets['linux-x64'].assemblyProvenanceSha256 = '0'.repeat(64)
    const changedManifest = replaceTarEntry(
      fixture.entries,
      'package/native/config-resolver/manifest.json',
      canonicalObjectBytes(manifest),
    )
    expect(() => verifyPackedPackage(createTar(changedManifest))).toThrow(/provenance digest/)

    const changedAsset = replaceTarEntry(
      fixture.entries,
      'package/native/config-resolver/linux-x64/bin/ghostty-config-resolver',
      Buffer.from('changed'),
    )
    expect(() => verifyPackedPackage(createTar(changedAsset))).toThrow(/identity differs/)

    expect(() =>
      verifyPackedPackage(
        createTar([
          ...fixture.entries,
          { path: 'package/native/unexpected', bytes: Buffer.from('x'), mode: 0o644 },
        ]),
      ),
    ).toThrow(/unexpected native file/)

    expect(() =>
      verifyPackedPackage(
        createTar([
          ...fixture.entries,
          { path: 'package/native', bytes: Buffer.from('conflict'), mode: 0o644 },
        ]),
      ),
    ).toThrow()
  })

  it('binds npm pack JSON to the exact tar identity and file list', () => {
    const fixture = createReleaseFixture()
    const packed = verifyPackedPackage(fixture.tarball)
    expect(() => validateNpmPackJson(fixture.npmJson, packed)).not.toThrow()
    const changed = JSON.parse(fixture.npmJson.toString('utf8')) as Array<{
      integrity: string
      files: Array<{ mode: number }>
    }>
    changed[0]!.integrity = `sha512-${'A'.repeat(86)}==`
    expect(() => validateNpmPackJson(Buffer.from(JSON.stringify(changed)), packed)).toThrow(
      /integrity/,
    )
    changed[0]!.integrity = packed.tarball.npmIntegrity
    changed[0]!.files[0]!.mode = 0o600
    expect(() => validateNpmPackJson(Buffer.from(JSON.stringify(changed)), packed)).toThrow(/mode/)
  })

  it('detects a read-only input mutation through stable file metadata and bytes', () => {
    const directory = temporaryDirectory('ghostty-release-readonly-')
    const path = join(directory, 'input.json')
    writeFileSync(path, canonicalObjectBytes({ schemaVersion: 1 }))
    const snapshot = readArtifactSnapshot(path, 1024)
    writeFileSync(path, canonicalObjectBytes({ schemaVersion: 2 }))
    expect(() => assertArtifactUnchanged(snapshot, 1024)).toThrow(/changed during verification/)
  })

  it('rejects a symlink at a read-only artifact boundary', () => {
    const directory = temporaryDirectory('ghostty-release-nofollow-')
    const target = join(directory, 'target')
    const link = join(directory, 'link')
    writeFileSync(target, 'bytes')
    symlinkSync(target, link)
    expect(() => readArtifactSnapshot(link, 1024)).toThrow(/regular file/)
  })
})

describe('release candidate modes', () => {
  it('packs once into an immutable candidate and writes only provisional metadata', () => {
    const fixture = createReleaseFixture()
    const repositoryRoot = syntheticRepository()
    const artifactsDirectory = join(repositoryRoot, '.artifacts')
    const calls = { pack: 0 }
    const runner = fixtureCommandRunner(repositoryRoot, fixture, calls)
    const result = packReleaseCandidate({
      repositoryRoot,
      artifactsDirectory,
      runId: RELEASE_RUN_ID,
      runAttempt: RELEASE_RUN_ATTEMPT,
      commandRunner: runner,
    })
    expect(calls.pack).toBe(1)
    expect(readFileSync(result.tarballPath)).toEqual(fixture.tarball)
    expect(readFileSync(result.provisionalPath)).toEqual(canonicalObjectBytes(result.provisional))
    expect(readdirSync(artifactsDirectory).sort()).toEqual(
      [RELEASE_PROVISIONAL_FILE, RELEASE_TARBALL_FILE].sort(),
    )
    expect(result.provisional).toEqual(fixture.provisional)
  })

  it('refuses a candidate collision before npm pack and preserves the existing file', () => {
    const fixture = createReleaseFixture()
    const repositoryRoot = syntheticRepository()
    const artifactsDirectory = join(repositoryRoot, '.artifacts')
    mkdirSync(artifactsDirectory)
    const candidate = join(artifactsDirectory, RELEASE_TARBALL_FILE)
    writeFileSync(candidate, 'owned')
    const calls = { pack: 0 }
    expect(() =>
      packReleaseCandidate({
        repositoryRoot,
        artifactsDirectory,
        runId: RELEASE_RUN_ID,
        runAttempt: RELEASE_RUN_ATTEMPT,
        commandRunner: fixtureCommandRunner(repositoryRoot, fixture, calls),
      }),
    ).toThrow(/already exists/)
    expect(calls.pack).toBe(0)
    expect(readFileSync(candidate, 'utf8')).toBe('owned')
  })

  it('does not overwrite a candidate created after the pack lock was acquired', () => {
    const fixture = createReleaseFixture()
    const repositoryRoot = syntheticRepository()
    const artifactsDirectory = join(repositoryRoot, '.artifacts')
    const calls = { pack: 0 }
    const base = fixtureCommandRunner(repositoryRoot, fixture, calls)
    const candidate = join(artifactsDirectory, RELEASE_TARBALL_FILE)
    const runner: CommandRunner = (command, arguments_, cwd) => {
      const result = base(command, arguments_, cwd)
      if (command === 'npm' && arguments_[0] === 'pack') writeFileSync(candidate, 'racer-owned')
      return result
    }
    expect(() =>
      packReleaseCandidate({
        repositoryRoot,
        artifactsDirectory,
        runId: RELEASE_RUN_ID,
        runAttempt: RELEASE_RUN_ATTEMPT,
        commandRunner: runner,
      }),
    ).toThrow(/already exists|cannot be published/)
    expect(readFileSync(candidate, 'utf8')).toBe('racer-owned')
    expect(calls.pack).toBe(1)
    expect(readdirSync(artifactsDirectory).some((name) => name.includes('.staging'))).toBe(false)
  })

  it('rejects an extra finalizer staging entry', () => {
    const directory = temporaryDirectory('ghostty-release-final-staging-')
    for (const name of [RELEASE_TARBALL_FILE, RELEASE_EVIDENCE_FILE, RELEASE_IDENTITY_FILE]) {
      writeFileSync(join(directory, name), name)
    }
    writeFileSync(join(directory, 'injected'), 'not owned by the final handoff')
    expect(() =>
      requireExactDirectoryFiles(directory, [
        RELEASE_TARBALL_FILE,
        RELEASE_EVIDENCE_FILE,
        RELEASE_IDENTITY_FILE,
      ]),
    ).toThrow(/unexpected output/)
  })

  it('finalizes transactionally and verifies solely from the three handoff files', () => {
    const fixture = createReleaseFixture()
    const repositoryRoot = syntheticRepository()
    const artifactsDirectory = join(repositoryRoot, '.artifacts')
    const runner = fixtureCommandRunner(repositoryRoot, fixture, { pack: 0 })
    const packed = packReleaseCandidate({
      repositoryRoot,
      artifactsDirectory,
      runId: RELEASE_RUN_ID,
      runAttempt: RELEASE_RUN_ATTEMPT,
      commandRunner: runner,
    })
    const inputs = writeProvenanceInputs(repositoryRoot, fixture)
    const before = statIdentity(packed.tarballPath)
    const finalized = finalizeReleaseCandidate({
      repositoryRoot,
      outputDirectory: artifactsDirectory,
      runId: RELEASE_RUN_ID,
      runAttempt: RELEASE_RUN_ATTEMPT,
      tarballPath: packed.tarballPath,
      provisionalPath: packed.provisionalPath,
      rebuildProvenancePaths: inputs.rebuild,
      smokeProvenancePaths: inputs.smoke,
      commandRunner: runner,
    })
    expect(statIdentity(packed.tarballPath)).toEqual(before)
    expect(readdirSync(finalized.directory).sort()).toEqual(
      [RELEASE_TARBALL_FILE, RELEASE_EVIDENCE_FILE, RELEASE_IDENTITY_FILE].sort(),
    )
    const verified = verifyReleaseCandidate({
      repositoryRoot,
      tarballPath: finalized.tarballPath,
      identityPath: finalized.identityPath,
      evidencePath: finalized.evidencePath,
      verifyRepository: false,
    })
    expect(verified.identity.packageSourceHead).toBe(PACKAGE_HEAD)
    expect(verified.evidence.releaseSmoke['linux-x64'].checks.packageSmoke).toBe('pass')
    expect(readdirSync(artifactsDirectory).some((name) => name.includes('.staging'))).toBe(false)
  })

  it('rejects a three-file mutation without rewriting any handoff file', () => {
    const { repositoryRoot, finalized } = finalizedFixture()
    const copied = join(repositoryRoot, 'copied')
    mkdirSync(copied)
    for (const name of [RELEASE_TARBALL_FILE, RELEASE_EVIDENCE_FILE, RELEASE_IDENTITY_FILE]) {
      writeFileSync(join(copied, name), readFileSync(join(finalized.directory, name)))
    }
    const evidencePath = join(copied, RELEASE_EVIDENCE_FILE)
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
      releaseSmoke: { 'linux-x64': { runtimes: { node: string } } }
    }
    evidence.releaseSmoke['linux-x64'].runtimes.node = '23.0.0'
    writeFileSync(evidencePath, canonicalObjectBytes(evidence))
    const before = [
      statIdentity(join(copied, RELEASE_TARBALL_FILE)),
      statIdentity(join(copied, RELEASE_IDENTITY_FILE)),
      statIdentity(evidencePath),
    ]
    expect(() =>
      verifyReleaseCandidate({
        repositoryRoot,
        tarballPath: join(copied, RELEASE_TARBALL_FILE),
        identityPath: join(copied, RELEASE_IDENTITY_FILE),
        evidencePath,
        verifyRepository: false,
      }),
    ).toThrow(/evidence digest differs/)
    expect([
      statIdentity(join(copied, RELEASE_TARBALL_FILE)),
      statIdentity(join(copied, RELEASE_IDENTITY_FILE)),
      statIdentity(evidencePath),
    ]).toEqual(before)
  })

  it('rejects a canonical identity mutation against the untouched tarball and evidence', () => {
    const { repositoryRoot, finalized } = finalizedFixture()
    const copied = join(repositoryRoot, 'identity-mutation')
    mkdirSync(copied)
    for (const name of [RELEASE_TARBALL_FILE, RELEASE_EVIDENCE_FILE, RELEASE_IDENTITY_FILE]) {
      writeFileSync(join(copied, name), readFileSync(join(finalized.directory, name)))
    }
    const identityPath = join(copied, RELEASE_IDENTITY_FILE)
    const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as {
      packedFileListSha256: string
    }
    identity.packedFileListSha256 = '0'.repeat(64)
    writeFileSync(identityPath, canonicalObjectBytes(identity))
    expect(() =>
      verifyReleaseCandidate({
        repositoryRoot,
        tarballPath: join(copied, RELEASE_TARBALL_FILE),
        identityPath,
        evidencePath: join(copied, RELEASE_EVIDENCE_FILE),
        verifyRepository: false,
      }),
    ).toThrow(/packed file-list digest differs/)
  })

  it('refuses finalizer retries without touching the input pack artifact', () => {
    const { repositoryRoot, artifactsDirectory, finalized, fixture, packed, inputs, runner } =
      finalizedFixture()
    const before = statIdentity(packed.tarballPath)
    expect(() =>
      finalizeReleaseCandidate({
        repositoryRoot,
        outputDirectory: artifactsDirectory,
        runId: RELEASE_RUN_ID,
        runAttempt: RELEASE_RUN_ATTEMPT,
        tarballPath: packed.tarballPath,
        provisionalPath: packed.provisionalPath,
        rebuildProvenancePaths: inputs.rebuild,
        smokeProvenancePaths: inputs.smoke,
        commandRunner: runner,
      }),
    ).toThrow(/already exists/)
    expect(statIdentity(packed.tarballPath)).toEqual(before)
    expect(readdirSync(finalized.directory)).toHaveLength(3)
    expect(fixture.provisional.tarball.sha256).toBe(packed.provisional.tarball.sha256)
  })

  it('rejects a source-head diff outside the generated native transition', () => {
    const fixture = createReleaseFixture()
    const repositoryRoot = syntheticRepository()
    const base = fixtureCommandRunner(repositoryRoot, fixture, { pack: 0 })
    const runner: CommandRunner = (command, arguments_, cwd) => {
      if (command === 'git' && arguments_[0] === 'diff') {
        return success(
          Buffer.concat([generatedDiff(fixture.manifest), Buffer.from('A\0README.md\0')]),
        )
      }
      return base(command, arguments_, cwd)
    }
    expect(() =>
      requireGeneratedOnlyPackageDiff(repositoryRoot, PACKAGE_HEAD, fixture.manifest, runner),
    ).toThrow(/non-generated/)
  })

  it('requires the canonicalizer in the committed self-verifier closure', () => {
    const fixture = createReleaseFixture()
    const repositoryRoot = syntheticRepository()
    const base = fixtureCommandRunner(repositoryRoot, fixture, { pack: 0 })
    const runner: CommandRunner = (command, arguments_, cwd) => {
      const result = base(command, arguments_, cwd)
      if (command !== 'git' || arguments_[0] !== 'ls-tree') return result
      const paths = result.stdout
        .toString('utf8')
        .split('\0')
        .filter((path) => path && path !== 'src/config-resolver/canonicalize.ts')
      return success(`${paths.join('\0')}\0`)
    }
    expect(() => requireVerifierAtHead(repositoryRoot, PACKAGE_HEAD, runner)).toThrow(/absent/)
  })
})

describe('release candidate CLI contract', () => {
  it('parses each mode with exact repeated evidence inputs', () => {
    const root = '/tmp/release-root'
    expect(
      parseReleaseCandidateArguments(
        ['--pack', '--run-id', RELEASE_RUN_ID, '--run-attempt', '2'],
        root,
      ).mode,
    ).toBe('pack')
    expect(
      parseReleaseCandidateArguments(
        [
          '--finalize',
          '--run-id',
          RELEASE_RUN_ID,
          '--run-attempt',
          '2',
          '--tarball',
          '/tmp/a.tgz',
          '--provisional',
          '/tmp/p.json',
          ...NATIVE_TARGETS.flatMap((target) => ['--rebuild-provenance', `/tmp/r-${target}`]),
          ...NATIVE_TARGETS.flatMap((target) => ['--smoke-provenance', `/tmp/s-${target}`]),
        ],
        root,
      ).mode,
    ).toBe('finalize')
    expect(
      parseReleaseCandidateArguments(
        [
          '--verify',
          '--tarball',
          '/tmp/a.tgz',
          '--identity',
          '/tmp/i.json',
          '--evidence',
          '/tmp/e.json',
        ],
        root,
      ).mode,
    ).toBe('verify')
  })

  it('rejects unknown, duplicate, missing, and noncanonical options', () => {
    expect(() => parseReleaseCandidateArguments(['--wat'], '/tmp')).toThrow()
    expect(() =>
      parseReleaseCandidateArguments(
        ['--pack', '--run-id', RELEASE_RUN_ID, '--run-id', RELEASE_RUN_ID, '--run-attempt', '2'],
        '/tmp',
      ),
    ).toThrow(/exactly once/)
    expect(() =>
      parseReleaseCandidateArguments(
        ['--pack', '--run-id', RELEASE_RUN_ID, '--run-attempt', '02'],
        '/tmp',
      ),
    ).toThrow(/canonical decimal/)
  })
})

describe('release workflow provenance producers', () => {
  it('validates an exact independent rebuild against the package manifest', () => {
    const fixture = createReleaseFixture()
    const target = 'linux-x64' as const
    const archive = Buffer.from('independent deterministic archive')
    const archiveIdentity = {
      file: `ghostty-config-resolver-${target}.tar`,
      sha256: sha256(archive),
      bytes: archive.length,
    }
    const manifest = structuredClone(fixture.manifest)
    const rebuild = structuredClone(fixture.rebuild[target])
    ;(
      manifest.targets[target].assemblyProvenance as unknown as {
        archive: typeof archiveIdentity
      }
    ).archive = archiveIdentity
    ;(rebuild as unknown as { archive: typeof archiveIdentity }).archive = archiveIdentity
    ;(
      manifest.targets[target] as unknown as { assemblyProvenanceSha256: string }
    ).assemblyProvenanceSha256 = canonicalSha256(manifest.targets[target].assemblyProvenance)

    const repositoryRoot = syntheticRepository()
    writeSourceManifest(repositoryRoot, manifest)
    const directory = temporaryDirectory('ghostty-release-rebuild-')
    const archivePath = join(directory, archiveIdentity.file)
    const provenancePath = join(directory, 'provenance.json')
    writeFileSync(archivePath, archive)
    writeFileSync(provenancePath, canonicalObjectBytes(rebuild))
    const releaseFixture = { ...fixture, manifest }
    const options = {
      repositoryRoot,
      packageSourceHead: PACKAGE_HEAD,
      runId: RELEASE_RUN_ID,
      runAttempt: RELEASE_RUN_ATTEMPT,
      target,
      runnerImage: NATIVE_TARGET_CONFIG[target].image,
      runnerImageVersion: NATIVE_TARGET_CONFIG[target].imageVersion,
      archivePath,
      provenancePath,
      commandRunner: fixtureCommandRunner(repositoryRoot, releaseFixture, { pack: 0 }),
      verifyRepositoryState() {},
      platform: 'linux',
      architecture: 'x64',
    } as const
    expect(verifyReleaseRebuildProvenance(options)).toEqual(rebuild)
    expect(() => verifyReleaseRebuildProvenance({ ...options, runAttempt: 3 })).toThrow(/attempt/)
    writeFileSync(archivePath, 'changed archive')
    expect(() => verifyReleaseRebuildProvenance(options)).toThrow(/hash|bytes/)
  })

  it('runs exact-tarball smoke itself and writes one canonical O_EXCL record', () => {
    const fixture = createReleaseFixture()
    const target = 'linux-x64' as const
    const repositoryRoot = syntheticRepository()
    writeSourceManifest(repositoryRoot, fixture.manifest)
    const directory = temporaryDirectory('ghostty-release-smoke-')
    const tarballPath = join(directory, RELEASE_TARBALL_FILE)
    const provisionalPath = join(directory, RELEASE_PROVISIONAL_FILE)
    const rebuildProvenancePath = join(directory, 'rebuild.json')
    const outputPath = join(directory, 'smoke.json')
    writeFileSync(tarballPath, fixture.tarball)
    writeFileSync(provisionalPath, canonicalObjectBytes(fixture.provisional))
    writeFileSync(rebuildProvenancePath, canonicalObjectBytes(fixture.rebuild[target]))
    const calls = { pack: 0, smoke: 0 }
    const options = {
      repositoryRoot,
      packageSourceHead: PACKAGE_HEAD,
      runId: RELEASE_RUN_ID,
      runAttempt: RELEASE_RUN_ATTEMPT,
      target,
      runnerImage: NATIVE_TARGET_CONFIG[target].image,
      runnerImageVersion: NATIVE_TARGET_CONFIG[target].imageVersion,
      tarballPath,
      provisionalPath,
      rebuildProvenancePath,
      outputPath,
      commandRunner: fixtureCommandRunner(repositoryRoot, fixture, calls),
      verifyRepositoryState() {},
      platform: 'linux',
      architecture: 'x64',
    } as const
    const smoke = createReleaseSmokeProvenance(options)
    expect(calls.smoke).toBe(1)
    expect(smoke).toEqual(fixture.smoke[target])
    expect(readFileSync(outputPath)).toEqual(canonicalObjectBytes(smoke))
    expect(() => createReleaseSmokeProvenance(options)).toThrow(/already exists/)
    expect(calls.smoke).toBe(1)
  })

  it('does not emit smoke evidence when package smoke fails or an input changes', () => {
    const fixture = createReleaseFixture()
    const target = 'linux-x64' as const
    const repositoryRoot = syntheticRepository()
    writeSourceManifest(repositoryRoot, fixture.manifest)
    const directory = temporaryDirectory('ghostty-release-smoke-failure-')
    const tarballPath = join(directory, RELEASE_TARBALL_FILE)
    const provisionalPath = join(directory, RELEASE_PROVISIONAL_FILE)
    const rebuildProvenancePath = join(directory, 'rebuild.json')
    const outputPath = join(directory, 'smoke.json')
    writeFileSync(tarballPath, fixture.tarball)
    writeFileSync(provisionalPath, canonicalObjectBytes(fixture.provisional))
    writeFileSync(rebuildProvenancePath, canonicalObjectBytes(fixture.rebuild[target]))
    const base = fixtureCommandRunner(repositoryRoot, fixture, { pack: 0 })
    const failing: CommandRunner = (command, arguments_, cwd) => {
      if (command === 'bun' && arguments_[0]?.endsWith('package-smoke.ts')) return failure()
      return base(command, arguments_, cwd)
    }
    const common = {
      repositoryRoot,
      packageSourceHead: PACKAGE_HEAD,
      runId: RELEASE_RUN_ID,
      runAttempt: RELEASE_RUN_ATTEMPT,
      target,
      runnerImage: NATIVE_TARGET_CONFIG[target].image,
      runnerImageVersion: NATIVE_TARGET_CONFIG[target].imageVersion,
      tarballPath,
      provisionalPath,
      rebuildProvenancePath,
      outputPath,
      verifyRepositoryState() {},
      platform: 'linux' as const,
      architecture: 'x64',
    }
    expect(() => createReleaseSmokeProvenance({ ...common, commandRunner: failing })).toThrow(
      /package smoke/,
    )
    expect(() => statSync(outputPath)).toThrow()

    const wrongOutput: CommandRunner = (command, arguments_, cwd) => {
      if (command === 'bun' && arguments_[0]?.endsWith('package-smoke.ts')) {
        return success('Verified packed consumer PASS\n')
      }
      return base(command, arguments_, cwd)
    }
    expect(() => createReleaseSmokeProvenance({ ...common, commandRunner: wrongOutput })).toThrow(
      /package smoke/,
    )
    expect(() => statSync(outputPath)).toThrow()

    const smokeStderr: CommandRunner = (command, arguments_, cwd) => {
      if (command === 'bun' && arguments_[0]?.endsWith('package-smoke.ts')) {
        return {
          ...success(`Verified packed consumer ${fixture.provisional.tarball.sha256}\n`),
          stderr: Buffer.from('unexpected diagnostic'),
        }
      }
      return base(command, arguments_, cwd)
    }
    expect(() => createReleaseSmokeProvenance({ ...common, commandRunner: smokeStderr })).toThrow(
      /package smoke/,
    )
    expect(() => statSync(outputPath)).toThrow()

    const mutating: CommandRunner = (command, arguments_, cwd) => {
      const result = base(command, arguments_, cwd)
      if (command === 'bun' && arguments_[0]?.endsWith('package-smoke.ts')) {
        writeFileSync(tarballPath, fixture.tarball.subarray(0, fixture.tarball.length - 1))
      }
      return result
    }
    expect(() => createReleaseSmokeProvenance({ ...common, commandRunner: mutating })).toThrow(
      /changed during verification/,
    )
    expect(() => statSync(outputPath)).toThrow()
  })

  it('parses strict rebuild and smoke producer commands', () => {
    const common = [
      '--run-id',
      RELEASE_RUN_ID,
      '--run-attempt',
      String(RELEASE_RUN_ATTEMPT),
      '--target',
      'linux-x64',
      '--package-source-head',
      PACKAGE_HEAD,
      '--runner-image',
      NATIVE_TARGET_CONFIG['linux-x64'].image,
      '--runner-image-version',
      NATIVE_TARGET_CONFIG['linux-x64'].imageVersion,
    ]
    expect(
      parseReleaseProvenanceArguments(
        ['--rebuild', ...common, '--archive', '/tmp/a.tar', '--provenance', '/tmp/p.json'],
        '/tmp/repository',
      ).mode,
    ).toBe('rebuild')
    expect(
      parseReleaseProvenanceArguments(
        [
          '--smoke',
          ...common,
          '--tarball',
          '/tmp/a.tgz',
          '--provisional',
          '/tmp/p.json',
          '--rebuild-provenance',
          '/tmp/r.json',
          '--output',
          '/tmp/s.json',
        ],
        '/tmp/repository',
      ).mode,
    ).toBe('smoke')
    expect(() =>
      parseReleaseProvenanceArguments(
        [
          '--smoke',
          ...common,
          '--tarball',
          '/tmp/a.tgz',
          '--provisional',
          '/tmp/p.json',
          '--rebuild-provenance',
          '/tmp/r.json',
          '--output',
          '/tmp/s.json',
          '--unknown',
          'x',
        ],
        '/tmp/repository',
      ),
    ).toThrow(/unknown/)
  })
})

function syntheticRepository(): string {
  const root = temporaryDirectory('ghostty-release-candidate-')
  mkdirSync(join(root, 'scripts/config-resolver-native'), { recursive: true })
  mkdirSync(join(root, 'scripts/release-candidate'), { recursive: true })
  mkdirSync(join(root, 'src/config-resolver'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'ghostty-webgpu', version: '0.1.2' }),
  )
  writeFileSync(join(root, 'scripts/create-release-candidate.ts'), 'entrypoint\n')
  writeFileSync(join(root, 'scripts/release-candidate/core.ts'), 'core\n')
  writeFileSync(join(root, 'src/config-resolver/canonicalize.ts'), 'canonicalize\n')
  for (const name of ['canonical.ts', 'constants.ts', 'contract.ts', 'link-plan.ts', 'order.ts']) {
    writeFileSync(join(root, 'scripts/config-resolver-native', name), `${name}\n`)
  }
  return root
}

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function fixtureCommandRunner(
  repositoryRoot: string,
  fixture: ReleaseFixture,
  calls: { pack: number; smoke?: number },
): CommandRunner {
  return (command, arguments_) => {
    if (command === 'git' && arguments_[0] === 'rev-parse') return success(`${PACKAGE_HEAD}\n`)
    if (command === 'git' && arguments_[0] === 'status') return success('')
    if (command === 'git' && arguments_[0] === 'merge-base') return success('')
    if (command === 'git' && arguments_[0] === 'diff')
      return success(generatedDiff(fixture.manifest))
    if (command === 'git' && arguments_[0] === 'ls-tree') {
      return success(
        [
          'scripts/config-resolver-native/canonical.ts',
          'scripts/config-resolver-native/constants.ts',
          'scripts/config-resolver-native/contract.ts',
          'scripts/config-resolver-native/link-plan.ts',
          'scripts/config-resolver-native/order.ts',
          'scripts/create-release-candidate.ts',
          'scripts/release-candidate/core.ts',
          'src/config-resolver/canonicalize.ts',
          '',
        ].join('\0'),
      )
    }
    if (command === 'git' && arguments_[0] === 'show') {
      const object = arguments_[1]
      const path = object?.slice(object.indexOf(':') + 1)
      if (!path) return failure()
      return success(readFileSync(join(repositoryRoot, ...path.split('/'))))
    }
    if (command === 'bun' && arguments_[0] === '--version') return success('1.3.10\n')
    if (command === 'bun' && arguments_[0]?.endsWith('package-smoke.ts')) {
      if (calls.smoke !== undefined) calls.smoke += 1
      return success(`Verified packed consumer ${fixture.provisional.tarball.sha256}\n`)
    }
    if (command === 'node' && arguments_[0] === '--version') return success('v22.12.0\n')
    if (command === 'npm' && arguments_[0] === '--version') return success('11.6.2\n')
    if (command === 'npm' && arguments_[0] === 'pack') {
      calls.pack += 1
      const index = arguments_.indexOf('--pack-destination')
      const destination = arguments_[index + 1]
      if (!destination) return failure()
      writeFileSync(join(destination, RELEASE_TARBALL_FILE), fixture.tarball)
      return success(fixture.npmJson)
    }
    return failure()
  }
}

function generatedDiff(manifest: ReleaseFixture['manifest']): Buffer {
  const rows: Array<readonly ['A' | 'D', string]> = [
    ['D', NATIVE_BOOTSTRAP_PATH],
    ['A', NATIVE_MANIFEST_PATH],
  ]
  for (const target of NATIVE_TARGETS) {
    for (const file of manifest.targets[target].files) {
      rows.push(['A', `native/config-resolver/${target}/${file.path}`])
    }
  }
  return Buffer.from(`${rows.flat().join('\0')}\0`)
}

function writeSourceManifest(repositoryRoot: string, manifest: ReleaseFixture['manifest']): void {
  const path = join(repositoryRoot, NATIVE_MANIFEST_PATH)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, canonicalObjectBytes(manifest))
}

function writeProvenanceInputs(
  repositoryRoot: string,
  fixture: ReleaseFixture,
): { readonly rebuild: readonly string[]; readonly smoke: readonly string[] } {
  const directory = join(repositoryRoot, 'provenance')
  mkdirSync(directory)
  const rebuild = NATIVE_TARGETS.map((target) => {
    const path = join(directory, `rebuild-${target}.json`)
    writeFileSync(path, canonicalObjectBytes(fixture.rebuild[target]))
    return path
  })
  const smoke = NATIVE_TARGETS.map((target) => {
    const path = join(directory, `smoke-${target}.json`)
    writeFileSync(path, canonicalObjectBytes(fixture.smoke[target]))
    return path
  })
  return { rebuild, smoke }
}

function replaceTarEntry(
  entries: ReleaseFixture['entries'],
  path: string,
  bytes: Buffer,
): ReleaseFixture['entries'] {
  return entries.map((entry) => (entry.path === path ? { ...entry, bytes } : entry))
}

function finalizedFixture(): {
  readonly repositoryRoot: string
  readonly artifactsDirectory: string
  readonly finalized: ReturnType<typeof finalizeReleaseCandidate>
  readonly fixture: ReleaseFixture
  readonly packed: ReturnType<typeof packReleaseCandidate>
  readonly inputs: ReturnType<typeof writeProvenanceInputs>
  readonly runner: CommandRunner
} {
  const fixture = createReleaseFixture()
  const repositoryRoot = syntheticRepository()
  const artifactsDirectory = join(repositoryRoot, '.artifacts')
  const runner = fixtureCommandRunner(repositoryRoot, fixture, { pack: 0 })
  const packed = packReleaseCandidate({
    repositoryRoot,
    artifactsDirectory,
    runId: RELEASE_RUN_ID,
    runAttempt: RELEASE_RUN_ATTEMPT,
    commandRunner: runner,
  })
  const inputs = writeProvenanceInputs(repositoryRoot, fixture)
  const finalized = finalizeReleaseCandidate({
    repositoryRoot,
    outputDirectory: artifactsDirectory,
    runId: RELEASE_RUN_ID,
    runAttempt: RELEASE_RUN_ATTEMPT,
    tarballPath: packed.tarballPath,
    provisionalPath: packed.provisionalPath,
    rebuildProvenancePaths: inputs.rebuild,
    smokeProvenancePaths: inputs.smoke,
    commandRunner: runner,
  })
  return { repositoryRoot, artifactsDirectory, finalized, fixture, packed, inputs, runner }
}

function statIdentity(path: string): object {
  const stats = statSync(path, { bigint: true })
  return { ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs }
}

function success(output: string | Buffer): CommandResult {
  return {
    status: 0,
    stdout: typeof output === 'string' ? Buffer.from(output) : output,
    stderr: Buffer.alloc(0),
  }
}

function failure(): CommandResult {
  return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
}
