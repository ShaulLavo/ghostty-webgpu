import type { StampStorage } from '../stamp-cache.js'

export class StampStorageFixture implements StampStorage {
  readonly memory = new WebAssembly.Memory({ initial: 1 })
  readonly released: { offset: number; bytes: number }[] = []
  private next = 32

  allocate(bytes: number): number {
    const reusable = this.released.findIndex((entry) => entry.bytes >= bytes)
    if (reusable >= 0) {
      const block = this.released.splice(reusable, 1)[0]!
      if (block.bytes > bytes)
        this.released.push({ offset: block.offset + bytes, bytes: block.bytes - bytes })
      return block.offset
    }
    const offset = this.next
    this.next += bytes
    const missing = this.next - this.memory.buffer.byteLength
    if (missing > 0) this.memory.grow(Math.ceil(missing / 65536))
    return offset
  }

  release(offset: number, bytes: number): void {
    this.released.push({ offset, bytes })
  }
}
