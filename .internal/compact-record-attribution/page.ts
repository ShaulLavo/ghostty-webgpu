function nextFrame(): Promise<void> {
  return new Promise((resolve) => nativeRequestFrame(() => resolve()))
}
async function replay(chunks: readonly Uint8Array[]) {
  const before = driver.metrics()
  callbackMilliseconds = []
  frameRequests = 0
  writeMilliseconds = []
  writtenBytes = 0
  const started = performance.now()
  for (const chunk of chunks) {
    const bytes = chunk
    const writing = performance.now()
    // Original PTY bytes are delivered as one write per original chunk.
    driver.write(bytes)
    writeMilliseconds.push(performance.now() - writing)
    writtenBytes += bytes.byteLength
    await nextFrame()
  }
  await nextFrame()
  assertNoDrawErrors()
  const after = driver.metrics()
  return {
    callbackMilliseconds,
    elapsedMilliseconds: performance.now() - started,
    frameRequests,
    metrics: Object.fromEntries(
      Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]),
    ),
    pendingFrames: pendingFrames.size,
    steps: chunks.length,
    writeMilliseconds,
    writtenBytes,
  }
}
let preparedChunks: Uint8Array[] = []
Object.assign(window, {
  __attributionPrepare(chunks: number[][]) {
    preparedChunks = chunks.map((chunk) => new Uint8Array(chunk))
  },
  __attributionReplay(chunks: number[][]) {
    return replay(chunks.map((chunk) => new Uint8Array(chunk)))
  },
  __attributionRun(start = 0, end = preparedChunks.length) {
    return replay(preparedChunks.slice(start, end))
  },
})
