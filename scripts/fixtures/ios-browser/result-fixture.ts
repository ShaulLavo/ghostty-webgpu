import type { FrameworkResult } from 'waffle/testing/page-runner/framework'
import type { NativeStage } from '../../ios-browser-options.ts'
import { nativeStage } from '../../ios-browser-stages.ts'

// Unit records only. These never establish actual binding, ACKs, or native qualification.
export function resultFixture(stage: NativeStage = 'synthetic') {
  const expected = nativeStage(stage).expected
  return {
    suite: `ghostty-${stage}`,
    run: 'fixture-run',
    expected,
    cases: expected.map((item, index) => ({
      expected: item,
      actualId: `fixture-${index}`,
      started: true,
      outcome: {
        id: `fixture-${index}`,
        state: 'pass' as const,
        retryCount: 0,
        hooks: {},
        errors: [],
      },
    })),
    collection: [],
    events: [],
    failures: [],
    exit: 4,
    fileComplete: true,
    rootBrowserSuiteComplete: false,
    omittedRootFiles: 'not enumerated',
    framework: { status: 'passed' },
    commandFailures: [],
    commandHooks: [],
    cleanup: {
      serviceDisposition: 'Unit fixture only',
      session: { status: 'confirmed', detail: 'Unit fixture only' },
      launcher: { status: 'confirmed', detail: 'Unit fixture only' },
      callbacks: { status: 'confirmed', detail: 'Unit fixture only' },
      provider: { status: 'confirmed', detail: 'Unit fixture only' },
      context: { status: 'confirmed', detail: 'Unit fixture only' },
      scratch: { status: 'confirmed', detail: 'Unit fixture only' },
    },
    binding: {
      windowHandle: 'fixture-window',
      iframeElementId: 'fixture-iframe',
      topUrl: 'http://localhost/top',
      testerUrl: 'http://localhost/tester',
    },
    geometry: {
      tester: { width: 414, height: 896, dpr: 3 },
      top: { width: 402, height: 714, visualWidth: 402, visualHeight: 714, scale: 1 },
      iframe: { x: 0, y: 0, width: 414, height: 896 },
    },
    documents: [
      {
        kind: 'orchestrator',
        doc: 'fixture-top',
        acceptedThrough: 3,
        ackedThrough: 3,
        pending: 0,
        cutoff: 13.5,
      },
      {
        kind: 'tester',
        doc: 'fixture-tester',
        acceptedThrough: 4,
        ackedThrough: 4,
        pending: 0,
        cutoff: 12.5,
      },
    ],
  } satisfies FrameworkResult
}

export const receiptFixture = {
  exit: 4,
  outcome: { kind: 'exited', code: 4, signal: null, joined: true },
}
