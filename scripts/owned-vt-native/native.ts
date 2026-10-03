import assert from 'node:assert/strict'
import { ArtifactBuildError } from '../ghostty-source.js'

export interface Cell {
  cp: number[]
  wide: number
  fg: [number, number]
  bold: boolean
}
export interface Snapshot {
  cols: number
  rows: number
  screen: number
  cursor: [number, number, boolean]
  grid: { wrap: boolean; continuation: boolean; cells: Cell[] }[]
}
export type Point = [number, number]
export type Receipt = (value: Record<string, unknown>) => void
interface Deadlines {
  readonly acknowledgement: number
  readonly shutdown: number
  readonly forcedShutdown: number
  readonly drain: number
}
const deadlines: Deadlines = {
  acknowledgement: 5000,
  shutdown: 1000,
  forcedShutdown: 1000,
  drain: 1000,
}

async function deadline<T>(task: Promise<T>, milliseconds: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ArtifactBuildError(`Native ${phase} deadline expired`)),
          milliseconds,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function* lines(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        yield buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
  assert.equal(buffer, '', 'native protocol ended with an incomplete record')
}

async function collect(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let result = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return result + decoder.decode()
      result += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

export class Native {
  private readonly process
  private readonly replies
  private readonly stdout
  private readonly stderrReader
  private readonly stderr: Promise<string>
  private retired = false
  private failure: Error | undefined
  private finishing: Promise<void> | undefined

  constructor(
    binary: string,
    private readonly label: string,
    private readonly receipt: Receipt,
    private readonly limits: Deadlines = deadlines,
  ) {
    for (const name of Object.keys(deadlines) as (keyof Deadlines)[]) {
      const value = limits[name]
      assert.ok(
        Number.isInteger(value) && value > 0 && value <= deadlines[name],
        'test deadlines can only shorten the finite transport policy',
      )
    }
    this.process = Bun.spawn([binary], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    this.stdout = this.process.stdout.getReader()
    this.stderrReader = this.process.stderr.getReader()
    this.stderr = collect(this.stderrReader)
    this.replies = lines(this.stdout)
  }

  async request(command: string): Promise<unknown> {
    if (this.failure) throw this.failure
    if (this.retired) throw new ArtifactBuildError('Native transport is closed')
    try {
      return await deadline(this.exchange(command), this.limits.acknowledgement, 'acknowledgement')
    } catch (error) {
      this.fail(error)
      await this.dispose()
      throw this.failure
    }
  }

  async create(cols: number, rows: number): Promise<void> {
    await this.request(`N ${cols} ${rows}`)
  }

  async write(text: string): Promise<void> {
    await this.request(`W ${Buffer.from(text).toString('hex')}`)
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.request(`R ${cols} ${rows}`)
  }

  async track(slot: number): Promise<void> {
    await this.request(`T ${slot}`)
  }

  async point(slot: number): Promise<Point | null> {
    const result = (await this.request(`P ${slot}`)) as { point: Point | null }
    return result.point
  }

  async snapshot(): Promise<Snapshot> {
    return (await this.request('S')) as Snapshot
  }

  async close(): Promise<void> {
    await this.dispose()
    if (this.failure) throw this.failure
  }

  private async exchange(command: string): Promise<unknown> {
    this.process.stdin.write(`${command}\n`)
    await this.process.stdin.flush()
    const reply = await this.replies.next()
    assert.equal(reply.done, false, 'native process ended before acknowledging the operation')
    const value: unknown = JSON.parse(reply.value!)
    this.receipt({ kind: 'native', terminal: this.label, command, value })
    return value
  }

  private fail(error: unknown): void {
    if (this.failure) return
    this.failure =
      error instanceof Error ? error : new ArtifactBuildError('Native transport failed')
    this.receipt({ kind: 'transport-failure', terminal: this.label, error: String(this.failure) })
  }

  private dispose(): Promise<void> {
    this.retired = true
    // Concurrent request failure and close share one bounded resource cleanup.
    this.finishing ??= this.finish().catch((error) => this.fail(error))
    return this.finishing
  }

  private async finish(): Promise<void> {
    try {
      try {
        void Promise.resolve(this.process.stdin.end()).catch((error) => this.fail(error))
      } catch (error) {
        this.fail(error)
      }
      let code: number
      try {
        code = await deadline(this.process.exited, this.limits.shutdown, 'shutdown')
      } catch (error) {
        this.fail(error)
        this.process.kill('SIGKILL')
        code = await deadline(this.process.exited, this.limits.forcedShutdown, 'forced shutdown')
      }
      const stderr = await deadline(this.stderr, this.limits.drain, 'stderr drain')
      this.receipt({ kind: 'native-exit', terminal: this.label, code, stderr })
      if (stderr) console.error(stderr)
      if (!this.failure) assert.equal(code, 0, 'native process must exit cleanly')
    } finally {
      await deadline(
        Promise.allSettled([this.stdout.cancel(), this.stderrReader.cancel()]),
        this.limits.drain,
        'stream cleanup',
      )
      await deadline(this.replies.return(undefined), this.limits.drain, 'protocol cleanup')
    }
  }
}
