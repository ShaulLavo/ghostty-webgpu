import { createServer } from 'node:net'

// Vitest treats `api.port: 0` as unset and races every nested session for 63315 and up.
// Pair this with `strictPort`: a port taken before Vitest binds then fails startup instead of hanging.
export async function freePort(host = '127.0.0.1'): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') throw new Error('No free TCP port was assigned')
  return address.port
}
