import type { WebGpuTerminalRendererOptions } from '../../renderer.js'
import { CanvasTerminalRenderer } from '../renderer.js'
import { ReferenceTarget } from './reference-target.js'

export class ReferenceRenderer extends CanvasTerminalRenderer {
  private constructor(options: WebGpuTerminalRendererOptions) {
    super(options, (canvas, output) => new ReferenceTarget(canvas, output))
  }

  static override create(options: WebGpuTerminalRendererOptions): Promise<ReferenceRenderer> {
    return Promise.resolve(new ReferenceRenderer(options))
  }
}
