self.onmessage = (event: MessageEvent<OffscreenCanvas>) => {
  const context = event.data.getContext('webgl2', { antialias: false })
  self.postMessage(context !== null)
  context?.getExtension('WEBGL_lose_context')?.loseContext()
}
