import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { NativeContractError } from './canonical'

export function workspaceNativeWorkflowPath(familyRoot: string): string | undefined {
  const parent = dirname(familyRoot)
  const manifest = join(parent, 'package.json')
  if (!existsSync(manifest)) return
  const { workspaces } = JSON.parse(readFileSync(manifest, 'utf8'))
  const packages: unknown = Array.isArray(workspaces) ? workspaces : workspaces?.packages
  if (!Array.isArray(packages) || !packages.includes(relative(parent, familyRoot))) return
  return join(parent, '.github/workflows/ghostty-config-resolver.yml')
}

export function renderWorkspaceNativeWorkflow(source: string): string {
  const releaseStart = source.indexOf('\n  release-rebuild:\n')
  if (releaseStart === -1)
    throw new NativeContractError('native workflow has no release rebuild job')
  const build = source
    .slice(0, releaseStart)
    .replace(
      'defaults:\n  run:\n    shell: bash\n',
      'defaults:\n  run:\n    shell: bash\n    working-directory: ghostty-webgpu\n',
    )
  const release = source
    .slice(releaseStart)
    .replace(
      '    runs-on: ${{ matrix.runner }}\n',
      '    runs-on: ${{ matrix.runner }}\n    defaults:\n      run:\n        working-directory: ${{ github.workspace }}\n',
    )
  return (build + release)
    .replaceAll(
      'working-directory: package-source',
      'working-directory: package-source/ghostty-webgpu',
    )
    .replaceAll(
      'working-directory: native-source',
      'working-directory: native-source/ghostty-webgpu',
    )
    .replaceAll('native-source/scripts/', 'native-source/ghostty-webgpu/scripts/')
    .replaceAll('package-source/scripts/', 'package-source/ghostty-webgpu/scripts/')
    .replaceAll('cd native-source &&', 'cd native-source/ghostty-webgpu &&')
    .replaceAll('cd package-source &&', 'cd package-source/ghostty-webgpu &&')
}

export function verifyWorkspaceNativeWorkflow(familyRoot: string): void {
  const path = workspaceNativeWorkflowPath(familyRoot)
  if (!path) return
  const source = readFileSync(join(familyRoot, '.github/workflows/config-resolver.yml'), 'utf8')
  if (!existsSync(path) || readFileSync(path, 'utf8') !== renderWorkspaceNativeWorkflow(source)) {
    throw new NativeContractError(
      'native workflow differs from its fingerprinted family recipe; run `bun run native:workflow`',
    )
  }
}
