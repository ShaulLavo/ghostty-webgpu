import { createServer } from 'node:net'

// Vitest treats `api.port: 0` as unset and races every nested session for 63315 and up.
// OS-assigned ports come from the ephemeral range, which never overlaps that scan.
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
