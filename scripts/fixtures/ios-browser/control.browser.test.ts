import { test } from 'vitest'

test('not executed by the HTTP fake', () => {
  throw new Error('The no-browser SDK control must not execute a browser body')
})
