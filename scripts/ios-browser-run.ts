import { createVitest } from 'vitest/node'
import { fileURLToPath } from 'node:url'
import type { FrameworkHost } from 'waffle/testing/page-runner/framework'
import type { ViteDevServer } from 'vite'
import { createFrameworkHost } from 'waffle/testing/page-runner/framework'
import { createBrowserTestConfig } from '../vitest.browser.config.ts'
import { attachedGhosttyProvider, ghosttyFrameworkPlugin } from './ios-browser.ts'
import { frameworkEndReporter } from './ios-browser-report.ts'
import { runFrameworkNode, joinFrameworkExecution } from './ios-browser-node.ts'
import { nativeStage } from './ios-browser-stages.ts'
import type { NativeOptions } from './ios-browser-options.ts'
import { writeFile } from 'node:fs/promises'
import type { CaptureEvidence } from './ios-browser-capture.ts'

type CaptureObservation = { name: string; evidence: CaptureEvidence }

async function closeFramework(
  context: Awaited<ReturnType<typeof createVitest>>,
  servers: ReadonlySet<ViteDevServer>,
): Promise<void> {
  await context.close()
  for (const server of servers) {
    if (server.httpServer?.listening || server.ws.clients.size !== 0)
      throw new Error('Framework HTTP or WebSocket consumers remain after context.close')
  }
}

function nativeConfiguration(
  host: FrameworkHost,
  options: NativeOptions,
  servers: Set<ViteDevServer>,
  end: ReturnType<typeof frameworkEndReporter>,
  captures: CaptureObservation[],
) {
  const base = createBrowserTestConfig()
  const selected = nativeStage(options.stage)
  return {
    ...base,
    plugins: base.plugins.concat([
      ghosttyFrameworkPlugin(host),
      {
        name: 'ghostty-owned-context',
        configureServer(server: ViteDevServer) {
          servers.add(server)
        },
      },
    ]),
    test: {
      ...base.test,
      include: base.test.include.concat(
        options.stage === 'synthetic' || options.stage === 'capture-control' ? [selected.file] : [],
      ),
      testTimeout: 15000,
      hookTimeout: 30000,
      retry: 0,
      isolate: true,
      fileParallelism: false,
      reporters: ['default', end.reporter],
      browser: {
        ...base.test.browser,
        provider: attachedGhosttyProvider(
          host,
          options.stage === 'capture-control'
            ? (name, evidence) => {
                captures.push({ name, evidence })
              }
            : undefined,
        ),
        instances: [{ browser: 'safari' }],
        commands: {},
        headless: false,
        ui: false,
        screenshotFailures: false,
        connectTimeout: 60000,
      },
    },
  } satisfies import('vitest/config').ViteUserConfig
}

async function executeFramework(
  host: FrameworkHost,
  options: NativeOptions,
  captures: CaptureObservation[],
): Promise<number> {
  const servers = new Set<ViteDevServer>()
  const end = frameworkEndReporter()
  let context: Awaited<ReturnType<typeof createVitest>> | undefined
  let execution: Promise<import('waffle/testing/page-runner/framework').VitestEnd> | undefined
  const start: Parameters<FrameworkHost['run']>[0] = async (registerClose) => {
    context = await createVitest(
      'test',
      { config: false, watch: false, root: fileURLToPath(new URL('../', import.meta.url)) },
      nativeConfiguration(host, options, servers, end, captures),
    )
    const actual = context
    let closing = false
    const close = () => {
      closing = true
      return closeFramework(actual, servers)
    }
    registerClose(close)
    if (closing) throw new Error('Framework context closed before start')
    await actual.start([nativeStage(options.stage).file])
    return end.endStatus()
  }
  const execute: Parameters<FrameworkHost['run']>[0] = (registerClose) => {
    execution = Promise.resolve().then(() => start(registerClose))
    return execution
  }
  const close = async () => {
    if (context) {
      await closeFramework(context, servers)
      return
    }
    for (const server of servers) await server.close()
  }
  try {
    const result = await host.run(execute)
    return result.exit
  } finally {
    await joinFrameworkExecution(close, execution)
  }
}

export async function executeNativeStage(options: NativeOptions): Promise<number> {
  let exit = 2
  const captures: CaptureObservation[] = []
  // All framework/SDK modules above initialize before the owned dispatcher is installed.
  await runFrameworkNode(async () => {
    const selected = nativeStage(options.stage)
    const host = createFrameworkHost({
      suite: `ghostty-${options.stage}`,
      native: { udid: options.udid },
      expected: selected.expected,
      scope: { kind: 'root-selection', command: 'test:browser', files: [selected.file] },
      resultPath: options.resultPath,
    })
    exit = await executeFramework(host, options, captures)
  })
  if (options.stage === 'capture-control')
    await writeFile(
      `${options.resultPath}.captures.json`,
      JSON.stringify(captures, null, 2) + '\n',
      { flag: 'wx' },
    )
  return exit
}
