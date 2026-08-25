import { expect, it } from 'vitest'
import type { RenderCursorSnapshot } from '../../core/types.js'
import { renderCursorState } from '../cursor.js'

const cursor: RenderCursorSnapshot = {
  blinking: false,
  passwordInput: false,
  style: 'block',
  viewport: { wideTail: true, x: 1, y: 2 },
  visible: true,
}

it('maps a native wide-tail cursor to the leading visible cell', () => {
  expect(renderCursorState(cursor, true)).toEqual({
    style: 'block',
    visible: true,
    x: 0,
    y: 2,
  })
  expect(renderCursorState({ ...cursor, viewport: { wideTail: true, x: 0, y: 2 } }, true)?.x).toBe(
    0,
  )
  expect(renderCursorState(cursor, false)?.visible).toBe(false)
  expect(renderCursorState(cursor, true, 'outline')).toMatchObject({
    style: 'outline',
    visible: true,
  })
  expect(renderCursorState(cursor, true, 'none')).toMatchObject({
    style: 'block',
    visible: false,
  })
})
