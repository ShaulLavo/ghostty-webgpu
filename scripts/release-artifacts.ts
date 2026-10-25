import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const packages = [
  { directory: '.', name: 'ghostty-webgpu' },
  { directory: 'packages/line-editor', name: 'ghostty-webgpu-line-editor' },
  { directory: 'packages/shaders', name: 'ghostty-webgpu-shaders' },
]

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReleaseError'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function packageIdentity(value: unknown): { name: string; version: string } {
  if (!isObject(value) || typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new ReleaseError('Package identity must contain a name and version')
  }
  return { name: value.name, version: value.version }
}

export async function releasePackages(root: string) {
  return Promise.all(
    packages.map(async (entry) => {
      const directory = join(root, entry.directory)
      const identity = packageIdentity(
        JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')),
      )
      if (identity.name !== entry.name) throw new ReleaseError('Source package name differs')
      return { ...identity, directory, filename: `${entry.name}.tgz` }
    }),
  )
}

export function sourceCommit(root: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD^{commit}'], { cwd: root, encoding: 'utf8' }).trim()
}

async function artifactIdentity(
  artifacts: string,
  entry: Awaited<ReturnType<typeof releasePackages>>[number],
) {
  const tarball = join(artifacts, entry.filename)
  const packed = packageIdentity(
    JSON.parse(
      execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }),
    ),
  )
  if (packed.name !== entry.name || packed.version !== entry.version) {
    throw new ReleaseError(`Packed identity differs for ${entry.filename}`)
  }
  const sha256 = createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex')
  return { ...packed, filename: entry.filename, sha256 }
}

async function artifactIdentities(root: string, artifacts: string) {
  const entries = await releasePackages(root)
  const filenames = (await readdir(artifacts)).filter((name) => name.endsWith('.tgz')).sort()
  const expected = entries.map((entry) => entry.filename).sort()
  if (JSON.stringify(filenames) !== JSON.stringify(expected)) {
    throw new ReleaseError('Release tarball set differs from the three source packages')
  }
  return Promise.all(entries.map((entry) => artifactIdentity(artifacts, entry)))
}

export async function writeReleaseManifest(root: string, artifacts: string): Promise<void> {
  const manifest = {
    commit: sourceCommit(root),
    packages: await artifactIdentities(root, artifacts),
  }
  await writeFile(join(artifacts, 'release.json'), JSON.stringify(manifest, null, 2) + '\n')
}

export async function validateReleaseArtifacts(options: {
  root: string
  artifacts: string
  commit: string
  tag?: string
}): Promise<void> {
  const { root, artifacts, commit, tag } = options
  if (!/^[0-9a-f]{40}$/.test(commit) || commit !== sourceCommit(root)) {
    throw new ReleaseError('Expected release commit differs from the checkout')
  }
  const manifest: unknown = JSON.parse(await readFile(join(artifacts, 'release.json'), 'utf8'))
  if (!isObject(manifest) || manifest.commit !== commit || !Array.isArray(manifest.packages)) {
    throw new ReleaseError('Release manifest commit or package set is invalid')
  }
  const identities = await artifactIdentities(root, artifacts)
  if (manifest.packages.length !== identities.length)
    throw new ReleaseError('Release manifest package count differs')
  const recordedPackages = manifest.packages
  identities.forEach((identity, index) => {
    const recorded: unknown = recordedPackages[index]
    if (
      !isObject(recorded) ||
      Object.entries(identity).some(([key, value]) => recorded[key] !== value)
    ) {
      throw new ReleaseError(
        `Release manifest identity or checksum differs for ${identity.filename}`,
      )
    }
  })
  if (tag === undefined) return
  const terminal = identities.find((entry) => entry.name === 'ghostty-webgpu')
  if (!terminal) throw new ReleaseError('Terminal release identity is missing')
  const prefix = `v${terminal.version}-`
  const suffix = tag.slice(prefix.length)
  if (!tag.startsWith(prefix) || !/^[0-9a-f]{7,40}$/.test(suffix) || !commit.startsWith(suffix)) {
    throw new ReleaseError('Release tag must match the terminal version and commit prefix')
  }
  const taggedCommit = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  if (taggedCommit !== commit) throw new ReleaseError('Release tag points to a different commit')
}
