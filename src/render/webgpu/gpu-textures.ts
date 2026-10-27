import type { AtlasKind, AtlasPageUpload, AtlasTextureLayout } from '../shared/atlas/types.js'

interface OwnedTexture {
  layers: number
  texture: GPUTexture
  view: GPUTextureView
}

function formatForKind(kind: AtlasKind): GPUTextureFormat {
  return kind === 'grayscale' ? 'r8unorm' : 'rgba8unorm'
}

function bytesPerPixel(kind: AtlasKind): number {
  return kind === 'grayscale' ? 1 : 4
}

function validateLayout(device: GPUDevice, layout: AtlasTextureLayout): void {
  if (layout.layerCount <= device.limits.maxTextureArrayLayers) return
  throw new RangeError(
    'atlas layer count ' +
      layout.layerCount +
      ' exceeds adapter limit ' +
      device.limits.maxTextureArrayLayers,
  )
}

function createTexture(
  device: GPUDevice,
  kind: AtlasKind,
  layout: AtlasTextureLayout,
  layers = 1,
): OwnedTexture {
  const texture = device.createTexture({
    dimension: '2d',
    format: formatForKind(kind),
    size: {
      depthOrArrayLayers: layers,
      height: layout.pageHeight,
      width: layout.pageWidth,
    },
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
  })
  try {
    const view = texture.createView({
      arrayLayerCount: layers,
      baseArrayLayer: 0,
      dimension: '2d-array',
    })
    return { layers, texture, view }
  } catch (cause) {
    texture.destroy()
    throw cause
  }
}

export class AtlasGpuTextures {
  private readonly device: GPUDevice
  private readonly layout: AtlasTextureLayout
  private readonly textures: Record<AtlasKind, OwnedTexture>
  private uploadBytesValue = 0
  private uploadOperationCountValue = 0
  private textureCreationCountValue = 2

  constructor(device: GPUDevice, layout: AtlasTextureLayout) {
    validateLayout(device, layout)
    this.device = device
    this.layout = layout
    const color = createTexture(device, 'color', layout)
    try {
      this.textures = { color, grayscale: createTexture(device, 'grayscale', layout) }
    } catch (cause) {
      color.texture.destroy()
      throw cause
    }
  }

  get textureCreationCount(): number {
    return this.textureCreationCountValue
  }

  get uploadBytes(): number {
    return this.uploadBytesValue
  }

  get uploadOperationCount(): number {
    return this.uploadOperationCountValue
  }

  sync(uploads: readonly AtlasPageUpload[]): boolean {
    let changed = false
    for (const kind of ['grayscale', 'color'] as const) {
      const required = uploads.reduce(
        (count, upload) => (upload.kind === kind ? Math.max(count, upload.layer + 1) : count),
        1,
      )
      if (required <= this.textures[kind].layers) continue
      this.grow(kind, required)
      changed = true
    }
    for (const upload of uploads) this.syncPage(upload)
    return changed
  }

  texture(kind: AtlasKind): GPUTexture {
    return this.textures[kind].texture
  }

  view(kind: AtlasKind): GPUTextureView {
    return this.textures[kind].view
  }

  destroy(): void {
    this.textures.grayscale.texture.destroy()
    this.textures.color.texture.destroy()
  }

  private grow(kind: AtlasKind, required: number): void {
    if (required > this.layout.layerCount)
      throw new RangeError('atlas upload layer is outside texture-array capacity')
    const previous = this.textures[kind]
    const layers = Math.min(this.layout.layerCount, Math.max(required, previous.layers * 2))
    const next = createTexture(this.device, kind, this.layout, layers)
    const encoder = this.device.createCommandEncoder()
    encoder.copyTextureToTexture(
      { texture: previous.texture },
      { texture: next.texture },
      {
        width: this.layout.pageWidth,
        height: this.layout.pageHeight,
        depthOrArrayLayers: previous.layers,
      },
    )
    this.device.queue.submit([encoder.finish()])
    previous.texture.destroy()
    this.textures[kind] = next
    this.textureCreationCountValue += 1
  }

  private syncPage(upload: AtlasPageUpload): void {
    this.validateUpload(upload)
    this.device.queue.writeTexture(
      {
        origin: { x: upload.origin.x, y: upload.origin.y, z: upload.layer },
        texture: this.textures[upload.kind].texture,
      },
      upload.pixels,
      {
        bytesPerRow: upload.bytesPerRow,
        offset: upload.dataOffset,
        rowsPerImage: upload.extent.height,
      },
      {
        depthOrArrayLayers: 1,
        height: upload.extent.height,
        width: upload.extent.width,
      },
    )
    this.uploadBytesValue += upload.extent.width * upload.extent.height * bytesPerPixel(upload.kind)
    this.uploadOperationCountValue += 1
  }

  private validateUpload(upload: AtlasPageUpload): void {
    if (upload.layer < 0 || upload.layer >= this.layout.layerCount) {
      throw new RangeError('atlas upload layer is outside texture-array capacity')
    }
    const right = upload.origin.x + upload.extent.width
    const bottom = upload.origin.y + upload.extent.height
    if (right <= this.layout.pageWidth && bottom <= this.layout.pageHeight) return
    throw new RangeError('atlas upload extent is outside the target layer')
  }
}
