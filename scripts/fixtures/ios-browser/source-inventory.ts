import assert from 'node:assert/strict'
import { parseSync, type Expression, type Statement, type CallExpression } from 'oxc-parser'

type Value = string | number | boolean | undefined | Value[] | { [key: string]: Value }
type Binding = { kind: 'expression'; node: Expression } | { kind: 'value'; value: Value }
type Scope = ReadonlyMap<string, Binding>
export type SourceCase = { fullName: string; line: number; index: number; timeoutMs: number }

function value(node: Expression, scope: Scope): Value {
  if (node.type === 'TSAsExpression') return value(node.expression, scope)
  if (node.type === 'Literal') {
    assert(
      typeof node.value === 'string' ||
        typeof node.value === 'number' ||
        typeof node.value === 'boolean',
    )
    return node.value
  }
  if (node.type === 'Identifier') {
    if (node.name === 'undefined') return undefined
    const item = scope.get(node.name)
    assert(item, `Unknown source constant ${node.name}`)
    return item.kind === 'expression' ? value(item.node, scope) : item.value
  }
  if (node.type === 'UnaryExpression' && node.operator === '-') {
    const operand = value(node.argument, scope)
    assert.equal(typeof operand, 'number')
    return -Number(operand)
  }
  if (node.type === 'ArrayExpression')
    return node.elements.map((item) => {
      assert(item && item.type !== 'SpreadElement')
      return value(item, scope)
    })
  if (node.type === 'ObjectExpression')
    return Object.fromEntries(
      node.properties.map((item) => {
        assert(item.type === 'Property' && !item.computed && item.key.type === 'Identifier')
        return [item.key.name, value(item.value, scope)]
      }),
    )
  if (node.type === 'TemplateLiteral')
    return node.quasis
      .map(
        (part, index) =>
          (part.value.cooked ?? '') +
          (node.expressions[index] ? String(value(node.expressions[index], scope)) : ''),
      )
      .join('')
  throw new Error(`Unsupported source value ${node.type}`)
}

function table(node: Expression, scope: Scope): Value[] {
  const rows = value(node, scope)
  assert(Array.isArray(rows) && rows.length > 0, 'Expected a nonempty source table')
  return rows
}

function title(pattern: string, item: Value): string {
  if (item && typeof item === 'object' && !Array.isArray(item))
    return pattern.replace(/\$(\w+)/g, (_match, key: string) => {
      assert(Object.hasOwn(item, key), `Missing title field ${key}`)
      return String(item[key])
    })
  const args = Array.isArray(item) ? item : [item]
  let index = 0
  const result = pattern.replace(/%s/g, () => String(args[index++]))
  assert.equal(index, args.length, 'Unrecognized parameter title')
  return result
}

function testCall(call: CallExpression): { name: string; rows?: Expression } | undefined {
  if (call.callee.type === 'Identifier') {
    if (['it', 'test', 'describe'].includes(call.callee.name)) return { name: call.callee.name }
    return undefined
  }
  if (
    call.callee.type === 'MemberExpression' &&
    call.callee.object.type === 'Identifier' &&
    ['it', 'test', 'describe'].includes(call.callee.object.name)
  )
    throw new Error('Modified source registration')
  if (call.callee.type !== 'CallExpression') return undefined
  const each = call.callee
  assert(each.callee.type === 'MemberExpression' && !each.callee.computed)
  assert(each.callee.object.type === 'Identifier' && each.callee.object.name === 'it')
  assert(
    each.callee.property.type === 'Identifier' &&
      ['each', 'for'].includes(each.callee.property.name),
  )
  assert.equal(each.arguments.length, 1)
  const rows = each.arguments[0]
  assert(rows && rows.type !== 'SpreadElement')
  return { name: 'it', rows }
}

type Inventory = {
  scope: Map<string, Binding>
  prefix: string
  source: string
  cases: SourceCase[]
}

function collectCall(call: CallExpression, state: Inventory): void {
  const registration = testCall(call)
  if (!registration) return
  const [name, body, timeout] = call.arguments
  assert(name && name.type !== 'SpreadElement')
  const pattern = value(name, state.scope)
  assert.equal(typeof pattern, 'string')
  assert(body?.type === 'ArrowFunctionExpression' && body.body.type === 'BlockStatement')
  assert(call.arguments.length === 2 || call.arguments.length === 3)
  if (registration.name === 'describe') {
    assert.equal(call.arguments.length, 2)
    collect(body.body.body, { ...state, prefix: state.prefix + pattern + ' > ' })
    return
  }
  assert(!timeout || (timeout.type === 'Literal' && typeof timeout.value === 'number'))
  const timeoutMs = timeout ? Number(timeout.value) : 15000
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0)
  const names = registration.rows
    ? table(registration.rows, state.scope).map((row) => title(String(pattern), row))
    : [String(pattern)]
  const line = state.source.slice(0, call.start).split('\n').length
  for (const fullName of names)
    state.cases.push({
      fullName: state.prefix + fullName,
      line,
      index: state.cases.filter((row) => row.line === line).length,
      timeoutMs,
    })
}

function collectLoop(
  statement: Extract<Statement, { type: 'ForOfStatement' }>,
  state: Inventory,
): void {
  assert(statement.left.type === 'VariableDeclaration' && statement.left.kind === 'const')
  assert.equal(statement.left.declarations.length, 1)
  const binding = statement.left.declarations[0]?.id
  assert(binding && statement.body.type === 'BlockStatement')
  for (const row of table(statement.right, state.scope)) {
    const scope = new Map(state.scope)
    bind(binding, row, scope)
    collect(statement.body.body, { ...state, scope })
  }
}

function bind(
  binding: import('oxc-parser').BindingPattern,
  row: Value,
  scope: Map<string, Binding>,
): void {
  if (binding.type === 'Identifier') {
    scope.set(binding.name, { kind: 'value', value: row })
    return
  }
  assert(binding.type === 'ArrayPattern' && Array.isArray(row))
  assert.equal(binding.elements.length, row.length)
  binding.elements.forEach((item, index) => {
    assert(item?.type === 'Identifier')
    scope.set(item.name, { kind: 'value', value: row[index] })
  })
}

function collect(statements: readonly Statement[], state: Inventory): void {
  for (const statement of statements) {
    if (statement.type === 'VariableDeclaration') {
      registerConstants(statement, state.scope)
      continue
    }
    if (statement.type === 'ForOfStatement') {
      collectLoop(statement, state)
      continue
    }
    if (statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression')
      collectCall(statement.expression, state)
  }
}

function registerConstants(
  statement: Extract<Statement, { type: 'VariableDeclaration' }>,
  scope: Map<string, Binding>,
): void {
  for (const item of statement.declarations) {
    if (item.id.type === 'Identifier' && item.init)
      scope.set(item.id.name, { kind: 'expression', node: item.init })
  }
}

// Read registration syntax only. Never import originals, invoke hooks, or evaluate test bodies.
export function sourceInventory(file: string, source: string): SourceCase[] {
  const parsed = parseSync(file, source)
  assert.deepEqual(parsed.errors, [])
  const cases: SourceCase[] = []
  collect(parsed.program.body, { scope: new Map(), prefix: '', source, cases })
  return cases
}
