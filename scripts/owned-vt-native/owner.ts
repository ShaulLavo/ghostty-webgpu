import { ArtifactBuildError } from '../ghostty-source.js'
import { Native, type Point, type Receipt } from './native.js'
import type { Command, Owner, Session } from './proof.js'

const pen = '\x1b[0m\x1b(B\x0f'

export class OwnedRead implements Owner {
  private tail: Promise<void> = Promise.resolve()
  private started = false
  private sequence = 0

  constructor(
    private readonly native: Native,
    private readonly session: Session,
    private readonly receipt: Receipt,
  ) {}

  paint(): Promise<void> {
    return this.enqueue('paint', () => this.redraw())
  }

  edit(command: Command): Promise<void> {
    return this.enqueue(`edit/${command.kind}`, async () => {
      await this.session.dispatch(command)
      await this.redraw()
    })
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.enqueue('resize', async () => {
      await this.native.resize(cols, rows)
      await this.redraw()
    })
  }

  printAbove(text: string): Promise<void> {
    return this.enqueue('printAbove', async () => {
      const origin = await this.origin()
      await this.native.write(`${this.cup(origin)}\x1b[J${pen}${text}\r\n`)
      await this.native.track(0)
      await this.redraw()
    })
  }

  private enqueue(name: string, operation: () => Promise<void>): Promise<void> {
    const id = ++this.sequence
    this.tail = this.tail.then(async () => {
      this.receipt({ kind: 'operation-begin', id, name })
      await operation()
      this.receipt({ kind: 'operation-end', id, name })
    })
    return this.tail
  }

  private cup(point: Point): string {
    return `\x1b[${point[1] + 1};${point[0] + 1}H`
  }

  private async origin(): Promise<Point> {
    const screen = await this.native.snapshot()
    if (screen.screen !== 0)
      throw new ArtifactBuildError('Owned display requires the primary screen')
    if (!this.started) {
      if (screen.cursor[0] !== 0 || screen.cursor[2])
        throw new ArtifactBuildError('Owned display requires a fresh column-zero origin')
      await this.native.track(0)
      this.started = true
    }
    const origin = await this.native.point(0)
    if (!origin)
      throw new ArtifactBuildError(
        'Owned display has left the active screen; long-buffer viewport is outside this proof',
      )
    if (origin[0] !== 0)
      throw new ArtifactBuildError('Owned display origin must remain at column zero')
    return origin
  }

  private display(text: string): string {
    const prompt = this.session.prompt
    if (!prompt) throw new ArtifactBuildError('Owned display requires an active ReadSession')
    return `${pen}${prompt.primary}${text.split('\n').join(`\r\n${prompt.secondary}`)}`
  }

  private async redraw(): Promise<void> {
    const { text, cursor } = this.session.model.snapshot
    const origin = await this.origin()
    await this.native.write(`${this.cup(origin)}\x1b[J${this.display(text)}`)
    const moved = await this.origin()
    // Printing the owned prefix recreates native pending wrap without a saved cursor slot.
    await this.native.write(`${this.cup(moved)}${this.display(text.slice(0, cursor))}`)
  }
}
