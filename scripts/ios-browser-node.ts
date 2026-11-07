import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

export class OwnedFrameworkDispatcher extends Agent {}

export async function runFrameworkNode(execute: () => Promise<void>): Promise<void> {
  const previous = getGlobalDispatcher()
  const transport = new OwnedFrameworkDispatcher()
  setGlobalDispatcher(transport)
  try {
    // The execution promise includes host.run and actual context/server/consumer joining.
    await execute()
  } finally {
    try {
      await transport.close()
    } finally {
      setGlobalDispatcher(previous)
    }
  }
}

export async function joinFrameworkExecution(
  close: () => Promise<void>,
  execution: Promise<unknown> | undefined,
): Promise<void> {
  let closeFailure: { error: unknown } | undefined
  await close().catch((error) => {
    closeFailure = { error }
  })
  await execution?.catch(() => {})
  await close().catch((error) => {
    closeFailure ??= { error }
  })
  if (closeFailure !== undefined) throw closeFailure.error
}
