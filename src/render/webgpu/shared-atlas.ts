import { GlyphAtlas } from '../shared/atlas/atlas.js'
import { CanvasGlyphRasterizer } from '../shared/atlas/canvas-rasterizer.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { AtlasGpuTextures } from './gpu-textures.js'

export interface SharedAtlasOwner {
  atlasEvicted(): void
}

interface DeviceTextures {
  readonly textures: AtlasGpuTextures
  references: number
  version: number
}

// One atlas, rasterizer and texture set per font key; terminals with equal fitted fonts share them.
export class SharedGlyphAtlas {
  readonly atlas = new GlyphAtlas()
  readonly rasterizer: CanvasGlyphRasterizer
  private readonly owners = new Set<SharedAtlasOwner>()
  private readonly devices = new Map<GPUDevice, DeviceTextures>()

  constructor(
    readonly key: string,
    font: TerminalFittedFont,
  ) {
    this.rasterizer = new CanvasGlyphRasterizer({ font })
    this.atlas.onEviction = () => {
      for (const owner of this.owners) owner.atlasEvicted()
    }
  }

  get ownerCount(): number {
    return this.owners.size
  }

  attach(owner: SharedAtlasOwner): void {
    this.owners.add(owner)
    this.atlas.attachOwner(owner)
  }

  detach(owner: SharedAtlasOwner): void {
    this.owners.delete(owner)
    this.atlas.detachOwner(owner)
  }

  acquireTextures(device: GPUDevice): AtlasGpuTextures {
    const existing = this.devices.get(device)
    if (existing) {
      existing.references += 1
      return existing.textures
    }
    const textures = new AtlasGpuTextures(device, this.atlas.textureLayout)
    this.devices.set(device, { textures, references: 1, version: 0 })
    // A new device starts empty; restore it from the retained CPU pages.
    this.atlas.markAllForUpload()
    return textures
  }

  releaseTextures(device: GPUDevice): void {
    const entry = this.devices.get(device)
    if (!entry) return
    entry.references -= 1
    if (entry.references > 0) return
    this.devices.delete(device)
    entry.textures.destroy()
  }

  textureVersion(device: GPUDevice): number {
    return this.devices.get(device)?.version ?? -1
  }

  hasPendingUploads(): boolean {
    return this.atlas.hasPendingUploads
  }

  sync(): void {
    const uploads = this.atlas.consumeUploads()
    if (uploads.length === 0) return
    for (const entry of this.devices.values()) {
      if (entry.textures.sync(uploads)) entry.version += 1
    }
  }
}

const registry = new Map<string, SharedGlyphAtlas>()

export function sharedAtlasKey(font: TerminalFittedFont): string {
  return JSON.stringify(font)
}

export function acquireSharedAtlas(
  font: TerminalFittedFont,
  owner: SharedAtlasOwner,
): SharedGlyphAtlas {
  const key = sharedAtlasKey(font)
  let shared = registry.get(key)
  if (!shared) {
    shared = new SharedGlyphAtlas(key, font)
    registry.set(key, shared)
  }
  shared.attach(owner)
  return shared
}

export function releaseSharedAtlas(shared: SharedGlyphAtlas, owner: SharedAtlasOwner): void {
  shared.detach(owner)
  if (shared.ownerCount > 0) return
  if (registry.get(shared.key) === shared) registry.delete(shared.key)
}
