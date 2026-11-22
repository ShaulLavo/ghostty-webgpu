import { readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { expect, it } from 'vitest'

const dist = fileURLToPath(new URL('../../dist/', import.meta.url))

function staticDependencies(entry: string): string[] {
  const pending = new Set([resolve(dist, entry)])
  for (const file of pending) {
    const { errors, module } = parseSync(file, readFileSync(file, 'utf8'))
    expect(errors, file).toEqual([])
    const imports = module.staticImports.map(({ moduleRequest }) => moduleRequest.value)
    const reexports = module.staticExports.flatMap(({ entries }) =>
      entries.map(({ moduleRequest }) => moduleRequest?.value),
    )
    for (const specifier of reexports.concat(imports)) {
      if (!specifier?.startsWith('.')) continue
      pending.add(resolve(dirname(file), specifier))
    }
  }
  return Array.from(pending, (file) => relative(dist, file).split(sep).join('/'))
}

it('keeps the built worker host independent of local execution and renderer backends', () => {
  const blocked = [
    /^(?:bidi\/(?:row|selection)|core\/(?:runtime|terminal)|dom\/execution-local|term\/session)\.js$/,
    /^render\/(?:canvas|dom|pixels|webgl|webgpu)\//,
    /^render\/shared\/(?:atlas[./-]|selector\.js$)/,
  ]
  const dependencies = staticDependencies('worker/index.js')
  expect(dependencies.filter((file) => blocked.some((pattern) => pattern.test(file)))).toEqual([])
})
