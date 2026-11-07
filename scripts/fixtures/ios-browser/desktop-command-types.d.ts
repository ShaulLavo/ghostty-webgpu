import type {} from 'vitest/internal/browser'

// Compile alongside the existing desktop command to catch forwarding-module collisions.
declare module 'vitest/internal/browser' {
  interface BrowserCommands {
    insertText: (text: string) => Promise<void>
  }
}
