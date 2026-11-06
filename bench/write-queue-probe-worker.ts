import { observeGpuSubmissions } from './write-queue-observer.js'

observeGpuSubmissions(() => globalThis.postMessage({ type: 'queue-probe-submit' }))
await import('../src/worker/entry.js')
