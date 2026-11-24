import '../../../dist/worker/entry.js'

// Animation frames never arrive, so only a paint outside them can show output.
const scope = globalThis as unknown as {
  requestAnimationFrame(callback: FrameRequestCallback): number
}
scope.requestAnimationFrame = () => 0
