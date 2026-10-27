interface Surface {
  framebuffer: WebGLFramebuffer
  texture: WebGLTexture
  readonly canvas: OffscreenCanvas
  readonly context: OffscreenCanvasRenderingContext2D
  width: number
  height: number
}

export class SharedWebGl {
  private readonly canvas = new OffscreenCanvas(1, 1)
  private readonly gl: WebGL2RenderingContext
  private readonly surfaces = new Set<Surface>()

  constructor() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    })
    if (!gl) throw new Error('shared WebGL2 unavailable')
    this.gl = gl
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.broadcast('webglcontextlost')
    })
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.restoreSurfaces()
      this.broadcast('webglcontextrestored')
    })
  }

  surface(canvas: OffscreenCanvas): { canvas: OffscreenCanvas; present(): void; dispose(): void } {
    const gl = this.gl
    const context = canvas.getContext('2d')
    const framebuffer = gl.createFramebuffer()
    const texture = gl.createTexture()
    if (!context || !framebuffer || !texture) throw new Error('shared surface allocation failed')
    const surface: Surface = { canvas, context, framebuffer, texture, width: 1, height: 1 }
    const view = this.contextView(surface)
    this.surfaces.add(surface)
    const virtualCanvas = new Proxy(canvas, {
      get: (target, key) => {
        if (key === 'getContext') return () => view
        if (key === 'width' || key === 'height') return surface[key]
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set: (target, key, value) => {
        if (key !== 'width' && key !== 'height') return Reflect.set(target, key, value, target)
        surface[key] = value
        this.resize(surface)
        return true
      },
    })
    return {
      canvas: virtualCanvas,
      present: () => this.present(surface),
      dispose: () => {
        gl.deleteFramebuffer(surface.framebuffer)
        gl.deleteTexture(surface.texture)
        this.surfaces.delete(surface)
      },
    }
  }

  private resize(surface: Surface): void {
    const gl = this.gl
    surface.canvas.width = surface.width
    surface.canvas.height = surface.height
    gl.bindTexture(gl.TEXTURE_2D, surface.texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      surface.width,
      surface.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, surface.framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, surface.texture, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('shared framebuffer incomplete')
    this.canvas.width = Math.max(this.canvas.width, surface.width)
    this.canvas.height = Math.max(this.canvas.height, surface.height)
  }

  private contextView(surface: Surface): WebGL2RenderingContext {
    const gl = this.gl
    return new Proxy(gl, {
      get: (target, key) => {
        if (key === 'bindFramebuffer')
          return (binding: number, framebuffer: WebGLFramebuffer | null) =>
            gl.bindFramebuffer(binding, framebuffer ?? surface.framebuffer)
        if (key === 'getExtension')
          return (name: string) => (name === 'WEBGL_lose_context' ? null : gl.getExtension(name))
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  private present(surface: Surface): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, surface.framebuffer)
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    gl.disable(gl.SCISSOR_TEST)
    gl.blitFramebuffer(
      0,
      0,
      surface.width,
      surface.height,
      0,
      0,
      surface.width,
      surface.height,
      gl.COLOR_BUFFER_BIT,
      gl.NEAREST,
    )
    surface.context.clearRect(0, 0, surface.width, surface.height)
    surface.context.drawImage(
      this.canvas,
      0,
      this.canvas.height - surface.height,
      surface.width,
      surface.height,
      0,
      0,
      surface.width,
      surface.height,
    )
  }

  private restoreSurfaces(): void {
    for (const surface of this.surfaces) {
      const framebuffer = this.gl.createFramebuffer()
      const texture = this.gl.createTexture()
      if (!framebuffer || !texture) throw new Error('surface restore allocation failed')
      surface.framebuffer = framebuffer
      surface.texture = texture
      this.resize(surface)
    }
  }

  private broadcast(type: string): void {
    for (const surface of this.surfaces)
      surface.canvas.dispatchEvent(new Event(type, { cancelable: true }))
  }

  async lose(): Promise<void> {
    const extension = this.gl.getExtension('WEBGL_lose_context')
    if (!extension) throw new Error('context loss extension unavailable')
    const restored = new Promise<void>((resolve) =>
      this.canvas.addEventListener('webglcontextrestored', () => resolve(), { once: true }),
    )
    extension.loseContext()
    await new Promise((resolve) => setTimeout(resolve, 50))
    extension.restoreContext()
    await restored
  }

  dispose(): void {
    for (const surface of this.surfaces) {
      this.gl.deleteFramebuffer(surface.framebuffer)
      this.gl.deleteTexture(surface.texture)
    }
    this.surfaces.clear()
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
