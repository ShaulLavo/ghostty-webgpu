import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const artifactRoot = join(root, '.artifacts', 'verified-build')
const manifestPath = join(artifactRoot, 'build-manifest.json')
const manifestDigestPath = join(artifactRoot, 'build-manifest.sha256')
const buildCommand =
  'bun run build && bun run --cwd packages/line-editor build && bun run --cwd packages/shaders build'
const outputRoots = ['dist', 'packages/line-editor/dist', 'packages/shaders/dist']
const outputExtensions = ['.js', '.d.ts']

type Output = { path: string; size: number; sha256: string }
type Manifest = {
  version: 1
  sourceSha: string
  bunVersion: string
  lockfileSha256: string
  buildCommand: string
  outputs: Output[]
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function hashFile(path: string): Promise<string> {
  return digest(await readFile(path))
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)))
      continue
    }
    if (outputExtensions.some((extension) => entry.name.endsWith(extension))) files.push(path)
  }
  return files
}

async function sourceSha(): Promise<string> {
  const configured = process.env.GITHUB_SHA
  if (configured) return configured
  const result = await Bun.$`git -C ${root} rev-parse HEAD`.text()
  return result.trim()
}

async function prepareArtifact(): Promise<void> {
  await rm(artifactRoot, { recursive: true, force: true })
  const files = (await Promise.all(outputRoots.map((path) => collectFiles(join(root, path)))))
    .flat()
    .toSorted()
  if (files.length === 0) throw new Error('No generated build files found')

  const outputs: Output[] = []
  for (const source of files) {
    const outputPath = relative(root, source)
    const destination = join(artifactRoot, outputPath)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    const sourceStat = await stat(source)
    outputs.push({
      path: outputPath.split(sep).join('/'),
      size: sourceStat.size,
      sha256: await hashFile(source),
    })
  }

  const manifest: Manifest = {
    version: 1,
    sourceSha: await sourceSha(),
    bunVersion: Bun.version,
    lockfileSha256: await hashFile(join(root, 'bun.lock')),
    buildCommand,
    outputs,
  }
  const content = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(manifestPath, content)
  await writeFile(manifestDigestPath, `${digest(Buffer.from(content))}  build-manifest.json\n`)
  console.log(
    `verified build artifact: ${outputs.length} files, ${outputs.reduce((total, output) => total + output.size, 0)} bytes`,
  )
  console.log(`source SHA: ${manifest.sourceSha}`)
  console.log(`manifest SHA-256: ${digest(Buffer.from(content))}`)
}

function expectedSourceSha(): string {
  const configured = process.env.GITHUB_SHA
  if (!configured) throw new Error('GITHUB_SHA is required when validating a downloaded artifact')
  return configured
}

async function verifyArtifact(): Promise<void> {
  const content = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(content) as Manifest
  if (manifest.version !== 1)
    throw new Error(`Unsupported build manifest version: ${manifest.version}`)
  if (manifest.sourceSha !== expectedSourceSha())
    throw new Error(`Build source SHA mismatch: ${manifest.sourceSha}`)
  if (manifest.bunVersion !== Bun.version)
    throw new Error(`Bun version mismatch: ${manifest.bunVersion}`)
  if (manifest.lockfileSha256 !== (await hashFile(join(root, 'bun.lock'))))
    throw new Error('Lockfile hash mismatch')
  if (manifest.buildCommand !== buildCommand)
    throw new Error(`Build command mismatch: ${manifest.buildCommand}`)

  const expectedDigest = `${digest(Buffer.from(content))}  build-manifest.json\n`
  const recordedDigest = (await readFile(manifestDigestPath, 'utf8')).trim().split(/\s+/)[0]
  if (recordedDigest !== expectedDigest.split(' ', 1)[0])
    throw new Error('Build manifest digest mismatch')
  for (const output of manifest.outputs) {
    if (output.path.includes('..') || output.path.startsWith('/'))
      throw new Error(`Unsafe output path: ${output.path}`)
    const source = join(artifactRoot, output.path)
    const destination = join(root, output.path)
    await access(source)
    const sourceStat = await stat(source)
    if (sourceStat.size !== output.size) throw new Error(`Output size mismatch: ${output.path}`)
    if ((await hashFile(source)) !== output.sha256)
      throw new Error(`Output hash mismatch: ${output.path}`)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }
  console.log(
    `verified build artifact: ${manifest.outputs.length} files, source SHA ${manifest.sourceSha}`,
  )
}

const mode = process.argv[2]
if (mode === 'pack') await prepareArtifact()
else if (mode === 'verify') await verifyArtifact()
else throw new Error('Usage: bun scripts/verified-build-artifact.ts <pack|verify>')
