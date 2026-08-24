import type { AtlasKind, AtlasPageUpload, AtlasTextureLayout } from './types.js'

interface OwnedTexture {
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
): OwnedTexture {
  const texture = device.createTexture({
    dimension: '2d',
    format: formatForKind(kind),
    size: {
      depthOrArrayLayers: layout.layerCount,
      height: layout.pageHeight,
      width: layout.pageWidth,
    },
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
  })
  const view = texture.createView({
    arrayLayerCount: layout.layerCount,
    baseArrayLayer: 0,
    dimension: '2d-array',
  })
  return { texture, view }
}

export class AtlasGpuTextures {
  private readonly device: GPUDevice
  private readonly layout: AtlasTextureLayout
  private readonly textures: Record<AtlasKind, OwnedTexture>
  private uploadBytesValue = 0
  private uploadOperationCountValue = 0

  constructor(device: GPUDevice, layout: AtlasTextureLayout) {
    validateLayout(device, layout)
    this.device = device
    this.layout = layout
    this.textures = {
      color: createTexture(device, 'color', layout),
      grayscale: createTexture(device, 'grayscale', layout),
    }
  }

  get textureCreationCount(): number {
    return 2
  }

  get uploadBytes(): number {
    return this.uploadBytesValue
  }

  get uploadOperationCount(): number {
    return this.uploadOperationCountValue
  }

  sync(uploads: readonly AtlasPageUpload[]): void {
    for (const upload of uploads) this.syncPage(upload)
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
