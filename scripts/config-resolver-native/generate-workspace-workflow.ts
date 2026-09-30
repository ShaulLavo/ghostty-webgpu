import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeContractError } from './canonical'
import {
  renderWorkspaceNativeWorkflow,
  verifyWorkspaceNativeWorkflow,
  workspaceNativeWorkflowPath,
} from './workflow'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const mode = process.argv[2]
if (process.argv.length !== 3 || (mode !== '--write' && mode !== '--check')) {
  throw new NativeContractError('usage: generate-workspace-workflow.ts --write|--check')
}
if (mode === '--check') {
  verifyWorkspaceNativeWorkflow(root)
} else {
  const output = workspaceNativeWorkflowPath(root)
  if (!output)
    throw new NativeContractError('native workflow generation requires the Fregat workspace')
  const source = readFileSync(join(root, '.github/workflows/config-resolver.yml'), 'utf8')
  writeFileSync(output, renderWorkspaceNativeWorkflow(source))
}
