import type { Terminal } from 'ghostty-webgpu'

export async function chooseRetention(terminal: Terminal) {
  await terminal.setAppearance({
    scrollbackLimit: 10000,
    scrollbackByteLimit: 64 * 1024 * 1024,
  })
}

export async function disableHistory(terminal: Terminal) {
  await terminal.setAppearance({ scrollbackByteLimit: 0 })
}
