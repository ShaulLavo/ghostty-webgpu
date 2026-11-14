import { fileURLToPath } from 'node:url'
import type { ExpectedCase } from 'waffle/testing/page-runner/framework'

export const historyFile = fileURLToPath(
  new URL('../src/dom/tests/history.browser.test.ts', import.meta.url),
)

export const historyCases = [
  {
    file: historyFile,
    fullName:
      'built native history API in Chromium > keeps main history, selection and mirrors on the retained native rows',
    sourceKey: 'src/dom/tests/history.browser.test.ts:29:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: historyFile,
    fullName:
      'built native history API in Chromium > keeps worker history, selection and mirrors on the retained native rows',
    sourceKey: 'src/dom/tests/history.browser.test.ts:29:1',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: historyFile,
    fullName:
      'built native history API in Chromium > reads empty rows before opening with the same lifecycle guard as visibleLines',
    sourceKey: 'src/dom/tests/history.browser.test.ts:117:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: historyFile,
    fullName:
      'built native history API in Chromium > reads history before paint and preserves selection and visibleLines',
    sourceKey: 'src/dom/tests/history.browser.test.ts:125:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: historyFile,
    fullName:
      'built native history API in Chromium > exports the row cap and reads the active screen through the built API',
    sourceKey: 'src/dom/tests/history.browser.test.ts:151:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]

export const readlineLayoutFile = fileURLToPath(
  new URL('../src/dom/tests/readline-layout.browser.test.ts', import.meta.url),
)

export const readlineLayoutCases = [
  {
    file: readlineLayoutFile,
    fullName:
      'renders and submits logical LF and prints above an active multiline edit through the built addon',
    sourceKey: 'src/dom/tests/readline-layout.browser.test.ts:71:0',
    timeoutMs: 15000,
    retries: 0,
  },
  {
    file: readlineLayoutFile,
    fullName:
      'preserves earlier output and pending wrap across exact-width edits through the built addon',
    sourceKey: 'src/dom/tests/readline-layout.browser.test.ts:93:0',
    timeoutMs: 15000,
    retries: 0,
  },
] satisfies readonly ExpectedCase[]
