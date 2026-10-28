import { GlyphAtlas, type GlyphAtlasMetrics } from '../shared/atlas/atlas.js'
import { CanvasGlyphRasterizer } from '../shared/atlas/canvas-rasterizer.js'
import type { TerminalFittedFont } from '../../term/types.js'
import { AtlasGpuTextures } from './gpu-textures.js'

export type SharedAtlasOwner = object

interface DeviceTextures {
  textures: AtlasGpuTextures
  references: number
  version: number
}

interface InFlightFrame {
  readonly device: GPUDevice
  readonly version: number
}

interface RetiredTexture {
  readonly device: GPUDevice
  readonly version: number
  readonly release: () => void
}

export interface SharedAtlasSync {
  readonly textureChanged: boolean
  readonly uploadedBytes: number
  readonly uploadOperations: number
}

export class SharedGlyphAtlas {
  readonly atlas = new GlyphAtlas()
  rasterizer: CanvasGlyphRasterizer
  private readonly owners = new Set<SharedAtlasOwner>()
  private readonly devices = new Map<GPUDevice, DeviceTextures>()
  private readonly inFlight = new Map<SharedAtlasOwner, InFlightFrame[]>()
  private readonly retired: RetiredTexture[] = []

  constructor(
    readonly key: string,
    private readonly font: TerminalFittedFont,
  ) {
    this.rasterizer = new CanvasGlyphRasterizer({ font })
  }

  get ownerCount(): number {
    return this.owners.size
  }

  attach(owner: SharedAtlasOwner): void {
    this.owners.add(owner)
    this.atlas.attachOwner(owner)
    this.atlas.growCapacity(Math.min(256, this.owners.size * 16))
  }

  detach(owner: SharedAtlasOwner): boolean {
    if (!this.owners.delete(owner)) return false
    this.atlas.detachOwner(owner)
    const frames = this.inFlight.get(owner) ?? []
    this.inFlight.delete(owner)
    for (const frame of frames) this.collectRetired(frame.device)
    return true
  }

  metrics(owner: SharedAtlasOwner): GlyphAtlasMetrics {
    return this.atlas.metrics(owner)
  }

  acquireTextures(device: GPUDevice): AtlasGpuTextures {
    const existing = this.devices.get(device)
    if (existing) {
      existing.references += 1
      return existing.textures
    }
    const textures = this.createTextures(device)
    this.devices.set(device, { textures, references: 1, version: 0 })
    this.atlas.markAllForUpload()
    return textures
  }

  releaseTextures(device: GPUDevice): void {
    const entry = this.devices.get(device)
    if (!entry) return
    entry.references -= 1
    if (entry.references === 0) {
      this.devices.delete(device)
      this.retire({ device, version: entry.version, release: () => entry.textures.destroy() })
    }
    this.collectRetired(device)
  }

  textureVersion(device: GPUDevice): number {
    return this.devices.get(device)?.version ?? -1
  }

  sync(device: GPUDevice): SharedAtlasSync {
    const uploads = this.atlas.consumeUploads()
    if (uploads.length === 0)
      return { textureChanged: false, uploadedBytes: 0, uploadOperations: 0 }
    const current = this.devices.get(device)
    if (!current) throw new Error('Shared atlas device textures are unavailable')
    const bytes = current.textures.uploadBytes
    const operations = current.textures.uploadOperationCount
    let textureChanged = false
    for (const [targetDevice, entry] of this.devices) {
      const changed = entry.textures.sync(uploads, (release) => {
        this.retire({ device: targetDevice, release, version: entry.version })
      })
      if (!changed) continue
      entry.version += 1
      textureChanged ||= targetDevice === device
    }
    return {
      textureChanged,
      uploadedBytes: current.textures.uploadBytes - bytes,
      uploadOperations: current.textures.uploadOperationCount - operations,
    }
  }

  invalidate(): void {
    this.atlas.invalidateAll()
    this.rasterizer = new CanvasGlyphRasterizer({ font: this.font })
    for (const [device, entry] of this.devices) {
      const previous = entry.textures
      const replacement = this.createTextures(device)
      const version = entry.version
      entry.textures = replacement
      entry.version += 1
      this.retire({ device, version, release: () => previous.destroy() })
    }
  }

  textures(device: GPUDevice): AtlasGpuTextures {
    const entry = this.devices.get(device)
    if (!entry) throw new Error('Shared atlas device textures are unavailable')
    return entry.textures
  }

  private createTextures(device: GPUDevice): AtlasGpuTextures {
    return new AtlasGpuTextures(device, {
      ...this.atlas.textureLayout,
      layerCount: 256,
    })
  }

  beginFrame(owner: SharedAtlasOwner, device: GPUDevice): void {
    const version = this.devices.get(device)?.version
    if (version === undefined) throw new Error('Shared atlas device textures are unavailable')
    const frames = this.inFlight.get(owner) ?? []
    frames.push({ device, version })
    this.inFlight.set(owner, frames)
  }

  frameSubmitted(owner: SharedAtlasOwner, device: GPUDevice): void {
    this.removeInFlight(owner, device)
    this.collectRetired(device)
  }

  frameFailed(owner: SharedAtlasOwner, device: GPUDevice): void {
    this.removeInFlight(owner, device)
    this.collectRetired(device)
  }

  private removeInFlight(owner: SharedAtlasOwner, device: GPUDevice): void {
    const frames = this.inFlight.get(owner)
    if (!frames) return
    const index = frames.findIndex((frame) => frame.device === device)
    if (index < 0) return
    frames.splice(index, 1)
    if (frames.length === 0) this.inFlight.delete(owner)
  }

  private collectRetired(device: GPUDevice): void {
    const safe = this.retired.filter(
      (retired) => retired.device === device && this.isRetired(retired),
    )
    if (safe.length === 0) return
    for (const retired of safe) retired.release()
    this.removeRetired(safe)
  }

  private retire(texture: RetiredTexture): void {
    if (this.isRetired(texture)) {
      texture.release()
      return
    }
    this.retired.push(texture)
  }

  private isRetired(retired: RetiredTexture): boolean {
    for (const frames of this.inFlight.values()) {
      if (
        frames.some((frame) => frame.device === retired.device && frame.version <= retired.version)
      )
        return false
    }
    return true
  }

  private removeRetired(released: readonly RetiredTexture[]): void {
    for (const retired of released) {
      const index = this.retired.indexOf(retired)
      if (index >= 0) this.retired.splice(index, 1)
    }
  }
}
