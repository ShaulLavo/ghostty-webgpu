import { describe, expect, it } from 'vitest'
import { SharedPool } from '../shared-rasterizer.js'

describe('SharedPool', () => {
  it('shares one value per key until its last owner releases it', () => {
    const pool = new SharedPool<{ id: number }>()
    let created = 0
    const create = () => ({ id: ++created })
    const first = pool.acquire('font-a', create)
    const second = pool.acquire('font-a', create)
    const other = pool.acquire('font-b', create)

    expect(second).toBe(first)
    expect(other).not.toBe(first)
    expect(created).toBe(2)
    pool.release(first)
    expect(pool.acquire('font-a', create)).toBe(first)
    pool.release(first)
    pool.release(first)
    expect(pool.size).toBe(1)
    expect(pool.acquire('font-a', create)).not.toBe(first)
    expect(created).toBe(3)
  })

  it('ignores values it does not own and repeated releases', () => {
    const pool = new SharedPool<{ id: number }>()
    const value = pool.acquire('font', () => ({ id: 1 }))
    pool.release({ id: 1 })
    expect(pool.size).toBe(1)
    pool.release(value)
    pool.release(value)
    expect(pool.size).toBe(0)
  })
})
