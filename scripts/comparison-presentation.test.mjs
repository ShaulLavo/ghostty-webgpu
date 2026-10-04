import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { PNG } from 'pngjs'
import {
  boundedSmokeOperation,
  presentationSmokeHtml,
  proveHeadedPresentation,
  smokeChallenge,
  smokeViewport,
} from './comparison-presentation.mjs'

const smokeId = '12345678-1234-1234-1234-123456789abc'
const url = `http://127.0.0.1:12345/?smoke=${smokeId}`
const ownership = { targetId: 'owned-page', windowId: 7, url, viewport: smokeViewport }

function image(challenge, scale = 1) {
  const png = new PNG({ width: smokeViewport.width, height: smokeViewport.height })
  png.data.fill(255)
  const { grid, colors } = challenge
  for (let index = 0; index < colors.length; index++) {
    const x = Math.floor((grid.left + (index % grid.columns) * grid.cell + grid.cell / 2) * scale)
    const y = Math.floor(
      (grid.top + Math.floor(index / grid.columns) * grid.cell + grid.cell / 2) * scale,
    )
    const offset = (y * png.width + x) * 4
    png.data.set([...colors[index], 255], offset)
  }
  return PNG.sync.write(png).toString('base64')
}

function externalBoundaries({
  frame = true,
  target = {},
  submitted = {},
  ackError = false,
  stopError = false,
  viewport = smokeViewport,
  windowState = 'normal',
} = {}) {
  const commands = []
  const session = new EventEmitter()
  session.send = async (method, params) => {
    commands.push({ method, params })
    if (method === 'Target.getTargetInfo')
      return { targetInfo: { type: 'page', targetId: ownership.targetId, url, ...target } }
    if (method === 'Browser.getWindowForTarget')
      return { windowId: ownership.windowId, bounds: { windowState } }
    if (method === 'Page.screencastFrameAck' && ackError) throw new Error('External ACK failure')
    if (method === 'Page.stopScreencast' && stopError) throw new Error('External stop failure')
    return {}
  }
  const page = {
    url: () => url,
    evaluate: async (_evaluate, challenge) => {
      const event = {
        data: image(challenge, smokeViewport.width / viewport.width),
        sessionId: 1,
        metadata: {
          timestamp: challenge.sequence,
          deviceWidth: viewport.width,
          deviceHeight: viewport.height,
          offsetTop: 0,
          pageScaleFactor: 1,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      }
      if (typeof frame === 'function') frame(session, event, challenge)
      if (frame === true) session.emit('Page.screencastFrame', event)
      return {
        smokeId,
        sequence: challenge.sequence,
        visibility: 'visible',
        dpr: 1,
        url,
        width: viewport.width,
        height: viewport.height,
        ...submitted,
      }
    },
  }
  const run = () =>
    proveHeadedPresentation({
      page,
      session,
      ownership: { ...ownership, viewport },
      smokeId,
      frameTimeoutMilliseconds: 30,
      commandTimeoutMilliseconds: 30,
    })
  return { session, commands, run }
}

function cleaned(boundaries) {
  assert.equal(boundaries.session.listenerCount('Page.screencastFrame'), 0)
  assert.equal(boundaries.commands.at(-1).method, 'Page.stopScreencast')
}

test('three nonce-bearing submitted contents match advancing compositor frames, with ACK and cleanup', async () => {
  const boundaries = externalBoundaries()
  const result = await boundaries.run()
  assert.equal(result.submitted.length, 3)
  assert.equal(result.presented.length, 3)
  assert.deepEqual(
    result.presented.map((entry) => entry.compositorTimestampSeconds),
    [1, 2, 3],
  )
  assert.equal(new Set(result.presented.map((entry) => entry.pngSha256)).size, 3)
  assert.deepEqual(
    result.submitted.map((entry) => entry.challenge.colors),
    result.presented.map((entry) => entry.observedColors),
  )
  assert.equal(result.acknowledged, 3)
  assert.deepEqual(result.cleanup, { listenerRemoved: true, screencastStopped: true })
  assert.equal(result.limits.optical, false)
  assert.equal(result.limits.performance, false)
  assert.equal(result.limits.terminalMarkers, 0)
  assert.equal(result.limits.canvas2d, false)
  assert.equal(result.limits.webgpu, false)
  assert.equal(result.limits.terminalRendererCorrectness, false)
  cleaned(boundaries)
})

test('uniform screencast downscaling uses actual page and compositor geometry', async () => {
  const boundaries = externalBoundaries({
    viewport: { width: 512, height: 704 },
    windowState: 'maximized',
  })
  const result = await boundaries.run()
  assert.equal(result.presented.length, 3)
  assert.equal(result.presented[0].scale, 0.625)
  cleaned(boundaries)
})

test('emulated geometry contradicting compositor geometry is rejected', async () => {
  const boundaries = externalBoundaries({
    frame: (session, event) =>
      session.emit('Page.screencastFrame', {
        ...event,
        metadata: { ...event.metadata, deviceWidth: 922, deviceHeight: 943 },
      }),
  })
  await assert.rejects(boundaries.run(), /viewport widths must agree/)
  cleaned(boundaries)
})

test('minimized windows fail before screencast starts', async () => {
  const boundaries = externalBoundaries({ windowState: 'minimized' })
  await assert.rejects(boundaries.run(), /Mapped non-minimized window/)
  assert.equal(boundaries.session.listenerCount('Page.screencastFrame'), 0)
  assert(!boundaries.commands.some((c) => c.method === 'Page.startScreencast'))
})

test('RAF and readPixels success without compositor frames cannot pass', async () => {
  const boundaries = externalBoundaries({
    frame: false,
    submitted: { raf: 1000, readPixels: 'passed' },
  })
  await assert.rejects(boundaries.run(), { code: 'PRESENTATION_SMOKE_TIMEOUT' })
  cleaned(boundaries)
})

test('matching content with cached or nonadvancing compositor timestamps fails fast', async () => {
  const boundaries = externalBoundaries({
    frame: (session, event) =>
      session.emit('Page.screencastFrame', {
        ...event,
        metadata: { ...event.metadata, timestamp: 1 },
      }),
  })
  await assert.rejects(boundaries.run(), { code: 'PRESENTATION_SMOKE_NONADVANCING' })
  assert.equal(boundaries.commands.filter((c) => c.method === 'Page.screencastFrameAck').length, 2)
  cleaned(boundaries)
})

test('cached earlier content with advancing timestamps is rejected', async () => {
  let cached
  const boundaries = externalBoundaries({
    frame: (session, event) => {
      cached ??= event.data
      session.emit('Page.screencastFrame', { ...event, data: cached })
    },
  })
  await assert.rejects(boundaries.run(), { code: 'PRESENTATION_SMOKE_TIMEOUT' })
  cleaned(boundaries)
})

test('different smoke identity content is ACKed but cannot qualify', async () => {
  const boundaries = externalBoundaries({
    frame: (session, event, challenge) => {
      const wrong = smokeChallenge('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', challenge.sequence)
      session.emit('Page.screencastFrame', { ...event, data: image(wrong) })
    },
  })
  await assert.rejects(boundaries.run(), { code: 'PRESENTATION_SMOKE_TIMEOUT' })
  assert(boundaries.commands.some((c) => c.method === 'Page.screencastFrameAck'))
  cleaned(boundaries)
})

test('zero-alpha Canvas output cannot pass a submitted-content claim', async () => {
  const blank = new PNG({ width: smokeViewport.width, height: smokeViewport.height })
  blank.data.fill(0)
  const boundaries = externalBoundaries({
    frame: (session, event) =>
      session.emit('Page.screencastFrame', {
        ...event,
        data: PNG.sync.write(blank).toString('base64'),
      }),
  })
  await assert.rejects(boundaries.run(), /Compositor content must be opaque/)
  cleaned(boundaries)
})

test('wrong target or URL fails before screencast starts', async () => {
  for (const target of [{ targetId: 'unrelated-page' }, { url: 'http://example.invalid/' }]) {
    const boundaries = externalBoundaries({ target })
    await assert.rejects(boundaries.run(), /Wrong CDP target|Wrong page URL/)
    assert(!boundaries.commands.some((c) => c.method === 'Page.startScreencast'))
    assert.equal(boundaries.session.listenerCount('Page.screencastFrame'), 0)
  }
})

test('page-side wrong submission and hidden pages fail even with matching PNGs', async () => {
  for (const submitted of [
    { smokeId: 'wrong' },
    { sequence: 17 },
    { visibility: 'hidden' },
    { dpr: 2 },
  ]) {
    const boundaries = externalBoundaries({ submitted })
    await assert.rejects(
      boundaries.run(),
      /Wrong submitted|Page must be visible|device scale factor/,
    )
    cleaned(boundaries)
  }
})

test('missing compositor timestamp never receives invented clocks', async () => {
  const boundaries = externalBoundaries({
    frame: (session, event) =>
      session.emit('Page.screencastFrame', {
        ...event,
        metadata: { ...event.metadata, timestamp: undefined },
      }),
  })
  await assert.rejects(boundaries.run(), { code: 'PRESENTATION_SMOKE_NONADVANCING' })
  cleaned(boundaries)
})

test('external ACK or stop failures reject and remove listener', async () => {
  for (const failure of [{ ackError: true }, { stopError: true }]) {
    const boundaries = externalBoundaries(failure)
    await assert.rejects(boundaries.run(), /External ACK failure|External stop failure/)
    cleaned(boundaries)
  }
})

test('command timeout is bounded', async () => {
  await assert.rejects(
    boundedSmokeOperation(() => new Promise(() => {}), 10),
    { code: 'PRESENTATION_SMOKE_TIMEOUT' },
  )
})

test('actual fixture submits WebGL clears at the pixels the compositor verifier samples', () => {
  const calls = []
  const gl = new Proxy(
    {},
    {
      get:
        (_target, key) =>
        (...args) => {
          calls.push({ key, args })
          return key === 'isContextLost' ? false : undefined
        },
    },
  )
  const window = {}
  const script = presentationSmokeHtml(smokeId).split('<script>')[1].split('</script>')[0]
  runInNewContext(script, {
    window,
    document: {
      visibilityState: 'visible',
      querySelector: () => ({
        height: 320,
        getContext: (kind) => {
          assert.equal(kind, 'webgl2')
          return gl
        },
      }),
    },
    location: { href: url },
    devicePixelRatio: 1,
    innerWidth: smokeViewport.width,
    innerHeight: smokeViewport.height,
  })
  const challenge = smokeChallenge(smokeId, 1)
  const submitted = window.presentationSmoke.submit(challenge)
  assert.equal(submitted.sequence, 1)
  assert.equal(submitted.url, url)
  assert.deepEqual(calls.filter((call) => call.key === 'scissor')[0].args, [16, 280, 24, 24])
  assert.equal(calls.filter((call) => call.key === 'clear').length, 65)
  assert.equal(calls.filter((call) => call.key === 'flush').length, 1)
  assert.throws(() => window.presentationSmoke.submit(challenge), /identity or sequence mismatch/)
})

test('fixture has discrete submits, own identity, and zero terminal or RAF measurement loops', () => {
  const html = presentationSmokeHtml(smokeId)
  assert(html.includes(smokeId))
  assert(
    !/requestAnimationFrame|readPixels|getImageData|TERMINAL|benchmark|performance\.now/.test(html),
  )
  assert.notDeepEqual(smokeChallenge(smokeId, 1).colors, smokeChallenge(smokeId, 2).colors)
})
