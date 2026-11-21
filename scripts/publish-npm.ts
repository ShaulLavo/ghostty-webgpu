import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const packageDirs = ['.', 'packages/line-editor', 'packages/shaders'] as const

function run(command: string, args: string[], cwd = root): void {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

function isPublished(spec: string): boolean {
  try {
    execFileSync('npm', ['view', spec, 'version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

run('bun', ['run', 'build'])
run('bun', ['run', '--cwd', 'packages/line-editor', 'build'])
run('bun', ['run', '--cwd', 'packages/shaders', 'build'])

for (const dir of packageDirs) {
  const pkgDir = join(root, dir)
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
    name: string
    version: string
  }
  const spec = `${manifest.name}@${manifest.version}`
  if (isPublished(spec)) {
    console.log(`${spec} is already published on npm; skipping.`)
    continue
  }
  const scratch = mkdtempSync(join(tmpdir(), 'ghostty-npm-pack-'))
  try {
    const filename = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
    const tarball = join(scratch, filename)
    run('bun', ['pm', 'pack', '--ignore-scripts', '--filename', tarball], pkgDir)
    run('npm', ['publish', tarball, '--access', 'public', '--provenance'])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

run('bunx', ['changeset', 'tag'])
