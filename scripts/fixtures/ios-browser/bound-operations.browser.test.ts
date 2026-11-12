import { afterAll, beforeAll, expect, test } from 'vitest'
import { page } from 'vitest/browser'
import type {} from '@vitest/browser-playwright'

declare const BOUND_CONTROL_MODE: string
declare const BOUND_CONTROL_PATH: string
let saved: { width: number; height: number }

beforeAll(async () => {
  saved = { width: innerWidth, height: innerHeight }
  await page.viewport(800, 600)
  expect([innerWidth, innerHeight]).toEqual([800, 600])
  await page.viewport(800, 600)
  expect([innerWidth, innerHeight]).toEqual([800, 600])
})

afterAll(async () => {
  await page.viewport(saved.width, saved.height)
  expect([innerWidth, innerHeight]).toEqual([414, 896])
})

test('combined synthetic transport operation', async () => {
  await page.viewport(saved.width, saved.height)
  expect([innerWidth, innerHeight]).toEqual([414, 896])
  const target = document.createElement('div')
  target.id = 'synthetic-transport-target'
  target.style.cssText = 'width:480px;height:160px'
  document.body.append(target)
  expect(target.getBoundingClientRect().width).toBe(480)
  expect(target.getBoundingClientRect().width).toBeGreaterThan(innerWidth)
  if (BOUND_CONTROL_MODE.startsWith('enclosing')) {
    target.style.cssText =
      'position:absolute;left:10.5px;top:10.5px;width:42px;height:26px;background:rgb(49,90,155)'
    const capture = page.screenshot({ element: target, save: false, scale: 'device' })
    if (BOUND_CONTROL_MODE !== 'enclosing') {
      await expect(capture).rejects.toThrow()
      return
    }
    const image = new Image()
    image.src = `data:image/png;base64,${await capture}`
    await image.decode()
    expect([image.naturalWidth, image.naturalHeight]).toEqual([43, 27])
    await page.viewport(640, 480)
    expect([innerWidth, innerHeight]).toEqual([640, 480])
    return
  }
  const operation = page.screenshot({
    path: BOUND_CONTROL_PATH,
    save: BOUND_CONTROL_MODE !== 'temporary',
    scale: 'css',
  })
  if (BOUND_CONTROL_MODE !== 'pass' && BOUND_CONTROL_MODE !== 'temporary') {
    await expect(operation).rejects.toThrow()
    return
  }
  const path = await operation
  if (BOUND_CONTROL_MODE === 'temporary') expect(path).toMatch(/^iVBOR/)
  else expect(path).toContain('synthetic-transport.png')
  await page.viewport(640, 480)
  expect([innerWidth, innerHeight]).toEqual([640, 480])
})
