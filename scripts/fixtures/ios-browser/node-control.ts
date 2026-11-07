// SDK initialization must precede the owned dispatcher, as in the native entry.
import 'vitest/node'
import '@vitest/browser-webdriverio'
import 'webdriverio'
import '../../../vitest.browser.config.ts'
import { runFrameworkNode } from '../../ios-browser-node.ts'

await runFrameworkNode(async () => {
  const target = process.argv[2]
  if (target === 'sdk') await import('./sdk-control.ts')
  else if (target === 'desktop') await import('./desktop-control.ts')
  else if (target === 'ordinary') await import('./ordinary-control.ts')
  else throw new Error(`Unknown framework control: ${target}`)
})
