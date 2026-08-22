import type { AtlasKind, AtlasPageUpload } from './types.js'

interface OwnedTexture {
  generation: number
  pageId: number
  texture: GPUTexture
}

function createTexture(device: GPUDevice, upload: AtlasPageUpload): GPUTexture {
  return device.createTexture({
    format: 'rgba8unorm',
    size: [upload.width, upload.height],
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
  })
}

export class AtlasGpuTextures {
  private readonly textures = new Map<AtlasKind, OwnedTexture>()

  sync(device: GPUDevice, uploads: readonly AtlasPageUpload[]): void {
    for (const upload of uploads) this.syncPage(device, upload)
  }

  view(kind: AtlasKind): GPUTextureView | undefined {
    return this.textures.get(kind)?.texture.createView()
  }

  destroy(): void {
    for (const owned of this.textures.values()) owned.texture.destroy()
    this.textures.clear()
  }

  private syncPage(device: GPUDevice, upload: AtlasPageUpload): void {
    const previous = this.textures.get(upload.kind)
    const reusable = previous?.pageId === upload.id && previous.generation === upload.generation
    const texture = reusable ? previous.texture : createTexture(device, upload)
    if (!reusable) previous?.texture.destroy()
    device.queue.writeTexture({ texture }, upload.pixels, { bytesPerRow: upload.width * 4 }, [
      upload.width,
      upload.height,
    ])
    this.textures.set(upload.kind, {
      generation: upload.generation,
      pageId: upload.id,
      texture,
    })
  }
}
