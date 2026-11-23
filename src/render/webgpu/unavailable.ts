export type WebGpuUnavailableReason = 'adapter' | 'api' | 'context'

export class WebGpuUnavailableError extends Error {
  readonly reason: WebGpuUnavailableReason

  constructor(reason: WebGpuUnavailableReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WebGpuUnavailableError'
    this.reason = reason
  }
}
