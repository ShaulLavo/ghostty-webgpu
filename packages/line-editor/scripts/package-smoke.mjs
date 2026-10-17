import assert from 'node:assert/strict'
import { EditModel, History, ReadSession, keyCommand, readline } from 'ghostty-webgpu-line-editor'

const history = new History({ limit: 2 })
const model = new EditModel(history)
model.insert('界é👨‍💻')
model.delete('backward')
assert.equal(model.snapshot.text, '界é')
assert.equal(model.snapshot.cursor, 3)

const session = new ReadSession({ history, complete: () => ['echo'] })
const pending = session.read({ prompt: '$ ' })
await assert.rejects(session.read({ prompt: '$ ' }), { code: 'line-editor.READ_PENDING' })
await session.dispatch({ kind: 'insert', text: 'ec' })
await session.dispatch({ kind: 'complete' })
const enter = keyCommand({ key: 'Enter' })
assert.deepEqual(enter, { kind: 'submit' })
await session.dispatch(enter)
assert.deepEqual(await pending, { kind: 'submit', text: 'echo' })
assert.deepEqual(history.entries, ['echo'])
session.dispose()
assert.equal(readline().name, 'readline')
console.log('Built package exports, structured errors, Unicode editing and read lifecycle passed.')
