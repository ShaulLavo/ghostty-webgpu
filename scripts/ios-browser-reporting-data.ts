const ownDescriptor = Object.getOwnPropertyDescriptor
const ownKeys = Object.keys
const quote = JSON.stringify
const encode = TextEncoder.prototype.encode.bind(new TextEncoder())
const byteLimit = 48 * 1024
const entryLimit = 1024

export function encodeReportingData(value: unknown): string {
  const chunks: string[] = []
  const ancestors = new Set<object>()
  let bytes = 0
  let entries = 0
  const append = (text: string) => {
    bytes += encode(text).byteLength
    if (bytes > byteLimit) throw new Error('Reporting trace exceeds 48 KiB')
    chunks.push(text)
  }
  const string = (text: string) => {
    if (text.length > byteLimit) throw new Error('Reporting trace string exceeds 48 KiB')
    append('"')
    for (const char of text) append(quote(char).slice(1, -1))
    append('"')
  }
  const field = (object: object, key: string, depth: number) => {
    const descriptor = ownDescriptor(object, key)
    if (!descriptor || !('value' in descriptor))
      throw new Error('Reporting trace contains an accessor')
    visit(descriptor.value, depth)
  }
  const prefix = (key: string) => {
    string(key)
    append(':')
  }
  const object = (value: object, depth: number) => {
    if (ancestors.has(value)) throw new Error('Reporting trace contains a cycle')
    ancestors.add(value)
    const array = Array.isArray(value)
    const keys = ownKeys(value)
    if (keys.length > entryLimit) throw new Error('Reporting trace has too many fields')
    append(array ? '[' : '{')
    for (const [index, key] of keys.entries()) {
      if (array && !/^\d+$/.test(key)) throw new Error('Reporting trace has non-index array data')
      if (index) append(',')
      if (!array) prefix(key)
      field(value, key, depth + 1)
    }
    append(array ? ']' : '}')
    ancestors.delete(value)
  }
  const visit = (value: unknown, depth: number): void => {
    if (++entries > 16 * entryLimit || depth > 16)
      throw new Error('Reporting trace structure exceeds bounds')
    if (value === undefined || value === null) {
      append('null')
      return
    }
    if (typeof value === 'string') {
      string(value)
      return
    }
    if (typeof value === 'boolean') {
      append(String(value))
      return
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      append(String(value))
      return
    }
    if (typeof value !== 'object') throw new Error('Reporting trace is not recorded data')
    object(value, depth)
  }
  visit(value, 0)
  return chunks.join('')
}

export class ReportingRecorder {
  private entries = 0
  private failed = false

  array<T>(): T[] {
    const values: T[] = []
    const append = values.push.bind(values)
    Object.defineProperty(values, 'push', {
      value: (...items: T[]) => {
        if (this.failed || this.entries + items.length > entryLimit) {
          this.failed = true
          throw new Error('Reporting recorder exceeds 1,024 entries')
        }
        this.entries += items.length
        return append(...items)
      },
    })
    return values
  }

  fail(): void {
    this.failed = true
  }

  encode(data: unknown): string {
    if (this.failed) throw new Error('Reporting recorder overflowed')
    return encodeReportingData(data)
  }
}
