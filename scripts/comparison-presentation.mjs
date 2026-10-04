import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PNG } from 'pngjs'

export const smokeViewport = Object.freeze({ width: 320, height: 440 })
const grid = Object.freeze({ left: 16, top: 16, cell: 24, columns: 8, rows: 8 })

export class PresentationSmokeError extends Error {
  constructor(code, evidence) {
    super(code)
    this.name = 'PresentationSmokeError'
    this.code = code
    this.evidence = evidence
  }
}

export async function boundedSmokeOperation(operation, milliseconds) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new PresentationSmokeError('PRESENTATION_SMOKE_TIMEOUT', { milliseconds })),
          milliseconds,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function smokeChallenge(smokeId, sequence) {
  assert.match(smokeId, /^[a-f0-9-]{36}$/)
  assert(Number.isSafeInteger(sequence) && sequence > 0 && sequence <= 3)
  const colors = Array.from({ length: grid.columns * grid.rows }, (_, index) => {
    const bytes = createHash('sha256').update(`${smokeId}/${sequence}/${index}`).digest()
    return Array.from(bytes.subarray(0, 3), (byte) => 32 + (byte % 192))
  })
  return { smokeId, sequence, colors, grid, viewport: smokeViewport }
}

export function presentationSmokeHtml(smokeId) {
  assert.match(smokeId, /^[a-f0-9-]{36}$/)
  return `<!doctype html><meta charset="utf-8"><title>Headed presentation smoke ${smokeId}</title>
<style>html,body{margin:0;background:white}canvas{display:block}p{margin:8px;font:12px monospace}</style>
<canvas width="320" height="320"></canvas><p>Setup smoke ${smokeId}</p>
<script>
const smokeId = ${JSON.stringify(smokeId)};
let sequence = 0;
window.presentationSmoke = {
  smokeId,
  submit(challenge) {
    if (challenge.smokeId !== smokeId || challenge.sequence !== sequence + 1) throw new Error('Smoke identity or sequence mismatch');
    const canvas = document.querySelector('canvas');
    const context = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!context || context.isContextLost()) throw new Error('Smoke WebGL2 context unavailable');
    context.disable(context.SCISSOR_TEST);
    context.clearColor(1, 1, 1, 1); context.clear(context.COLOR_BUFFER_BIT);
    context.enable(context.SCISSOR_TEST);
    const grid = challenge.grid;
    challenge.colors.forEach((color, index) => {
      const x = grid.left + index % grid.columns * grid.cell;
      const y = grid.top + Math.floor(index / grid.columns) * grid.cell;
      context.scissor(x, canvas.height - y - grid.cell, grid.cell, grid.cell);
      context.clearColor(color[0] / 255, color[1] / 255, color[2] / 255, 1);
      context.clear(context.COLOR_BUFFER_BIT);
    });
    context.flush();
    sequence = challenge.sequence;
    return { smokeId, sequence, visibility: document.visibilityState, dpr: devicePixelRatio, url: location.href, width: innerWidth, height: innerHeight };
  }
};
</script>`
}

function decodedWitness(frame, challenge, viewport) {
  assert(
    typeof frame.data === 'string' && frame.data.length < 4_000_000,
    'Bounded PNG frame required',
  )
  const bytes = Buffer.from(frame.data, 'base64')
  assert(bytes.length >= 24, 'PNG header required')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  assert(
    width > 0 && width <= smokeViewport.width && height > 0 && height <= smokeViewport.height,
    'Bounded compositor image dimensions required',
  )
  assert.equal(
    frame.metadata?.deviceWidth,
    viewport.width,
    'Compositor and page viewport widths must agree',
  )
  assert.equal(
    frame.metadata?.deviceHeight,
    viewport.height,
    'Compositor and page viewport heights must agree',
  )
  for (const [key, value] of Object.entries({
    offsetTop: 0,
    pageScaleFactor: 1,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
  }))
    assert.equal(frame.metadata[key], value, 'Unscaled, unscrolled compositor content required')
  const scale = width / viewport.width
  assert(Math.abs(height - viewport.height * scale) <= 1, 'Uniform compositor image scale required')
  const image = PNG.sync.read(bytes)
  const observedColors = challenge.colors.map((_, index) => {
    const x = Math.floor((grid.left + (index % grid.columns) * grid.cell + grid.cell / 2) * scale)
    const y = Math.floor(
      (grid.top + Math.floor(index / grid.columns) * grid.cell + grid.cell / 2) * scale,
    )
    const offset = (y * image.width + x) * 4
    assert.equal(image.data[offset + 3], 255, 'Compositor content must be opaque')
    return Array.from(image.data.subarray(offset, offset + 3))
  })
  if (
    !observedColors.every((color, index) => color.every((v, c) => v === challenge.colors[index][c]))
  )
    return null
  return {
    pngSha256: createHash('sha256').update(bytes).digest('hex'),
    pngBytes: bytes.length,
    width: image.width,
    height: image.height,
    viewport,
    scale,
    observedColors,
  }
}

/** CDP compositor-surface readback qualifies setup. It measures no physical display endpoint. */
export async function proveHeadedPresentation({
  page,
  session,
  ownership,
  smokeId,
  frameTimeoutMilliseconds = 3000,
  commandTimeoutMilliseconds = 2000,
}) {
  assert(frameTimeoutMilliseconds > 0 && frameTimeoutMilliseconds <= 5000)
  assert(commandTimeoutMilliseconds > 0 && commandTimeoutMilliseconds <= 5000)
  const send = (method, params) =>
    boundedSmokeOperation(() => session.send(method, params), commandTimeoutMilliseconds)
  const target = (await send('Target.getTargetInfo')).targetInfo
  assert.equal(target.type, 'page', 'Owned page target required')
  assert.equal(target.targetId, ownership.targetId, 'Wrong CDP target')
  assert.equal(target.url, ownership.url, 'Wrong page URL')
  assert.equal(page.url(), ownership.url, 'Page URL changed')
  assert.equal(
    new URL(ownership.url).searchParams.get('smoke'),
    smokeId,
    'URL must bind smoke identity',
  )
  const window = await send('Browser.getWindowForTarget', { targetId: target.targetId })
  assert.equal(window.windowId, ownership.windowId, 'Wrong owned window')
  assert(
    ['normal', 'maximized', 'fullscreen'].includes(window.bounds.windowState),
    'Mapped non-minimized window required',
  )
  assert(
    ownership.viewport.width >= 320 && ownership.viewport.height >= 320,
    'Smoke grid must fit the actual page viewport',
  )

  const evidence = {
    endpoint: 'CDP Page.screencastFrame compositor-surface PNG content',
    smokeId,
    ownership,
    submitted: [],
    presented: [],
    received: 0,
    acknowledged: 0,
    unmatched: 0,
    frames: [],
    cleanup: { listenerRemoved: false, screencastStopped: false },
    limits: {
      optical: false,
      performance: false,
      terminalMarkers: 0,
      fixture: 'WebGL2 scissor and clear',
      canvas2d: false,
      webgpu: false,
      terminalRendererCorrectness: false,
    },
  }
  let pending
  let failure
  let previousTimestamp = -Infinity
  let processing = Promise.resolve()
  const fail = (error) => {
    failure ??= error
    pending?.reject(error)
  }
  const acceptFrame = async (frame) => {
    evidence.received++
    await send('Page.screencastFrameAck', { sessionId: frame.sessionId })
    evidence.acknowledged++
    assert(evidence.received <= 32, 'Smoke frame safety bound exceeded')
    assert(
      typeof frame.data === 'string' && frame.data.length < 4_000_000,
      'Bounded PNG frame required',
    )
    evidence.frames.push({
      sessionId: frame.sessionId,
      metadata: frame.metadata,
      pngBase64: frame.data,
    })
    if (!pending || failure) return
    const content = decodedWitness(frame, pending.challenge, ownership.viewport)
    if (!content) {
      evidence.unmatched++
      return
    }
    const timestamp = frame.metadata?.timestamp
    if (!Number.isFinite(timestamp) || timestamp <= previousTimestamp)
      throw new PresentationSmokeError('PRESENTATION_SMOKE_NONADVANCING', {
        timestamp,
        previousTimestamp,
      })
    previousTimestamp = timestamp
    pending.resolve({
      smokeId,
      sequence: pending.challenge.sequence,
      sessionId: frame.sessionId,
      compositorTimestampSeconds: timestamp,
      metadata: frame.metadata,
      ...content,
    })
    pending = undefined
  }
  const listener = (frame) => {
    processing = processing.then(() => acceptFrame(frame)).catch(fail)
  }
  session.on('Page.screencastFrame', listener)
  try {
    await send('Page.startScreencast', {
      format: 'png',
      maxWidth: smokeViewport.width,
      maxHeight: smokeViewport.height,
      everyNthFrame: 1,
    })
    for (let sequence = 1; sequence <= 3; sequence++) {
      if (failure) throw failure
      const challenge = smokeChallenge(smokeId, sequence)
      const witness = new Promise((resolve, reject) => {
        pending = { challenge, resolve, reject }
      })
      // The waiter precedes submission because compositor readback can beat CDP evaluate completion.
      const observed = boundedSmokeOperation(async () => {
        const submitted = await page.evaluate(
          (input) => window.presentationSmoke.submit(input),
          challenge,
        )
        assert.equal(submitted.smokeId, smokeId, 'Wrong submitted identity')
        assert.equal(submitted.sequence, sequence, 'Wrong submitted sequence')
        assert.equal(submitted.visibility, 'visible', 'Page must be visible')
        assert.equal(submitted.dpr, 1, 'Smoke uses device scale factor one')
        assert.equal(submitted.url, ownership.url, 'Submission URL must remain owned')
        assert.equal(submitted.width, ownership.viewport.width, 'Submitted viewport width changed')
        assert.equal(
          submitted.height,
          ownership.viewport.height,
          'Submitted viewport height changed',
        )
        evidence.submitted.push({ ...submitted, challenge })
        return await witness
      }, frameTimeoutMilliseconds)
      witness.catch(() => {})
      evidence.presented.push(await observed)
    }
  } catch (error) {
    error.smokeEvidence = evidence
    throw error
  } finally {
    pending = undefined
    session.off('Page.screencastFrame', listener)
    evidence.cleanup.listenerRemoved = true
    try {
      await boundedSmokeOperation(() => processing, commandTimeoutMilliseconds)
    } finally {
      await send('Page.stopScreencast')
      evidence.cleanup.screencastStopped = true
    }
  }
  if (failure) throw failure
  return evidence
}
