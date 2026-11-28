export class WebGlUnavailableError extends Error {
  constructor(
    readonly reason: 'context' | 'allocation' | 'limits' = 'context',
    message = 'Unable to create a WebGL2 canvas context',
  ) {
    super(message)
    this.name = 'WebGlUnavailableError'
  }

  get canvasClaimed(): boolean {
    return this.reason !== 'context'
  }
}
