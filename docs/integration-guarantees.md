# Integration guarantees

This audit covers applications that embed ghostty-webgpu, especially applications that create many terminals or own layout and transport. It records the current contract, its tests, and the remaining gaps. The guarantees for renderer replacement apply to the built-in renderers. A custom `rendererFactory` must provide its own cancellation and disposal behavior.

The application evidence comes from the [terminal application study](../.internal/reference-study-2026-10/lanes/04-rio-and-apps.md) and [companion project study](../.internal/reference-study-2026-10/lanes/06-companions-workloads.md). Terax needed explicit memory reclamation, shared modules, scrollback budgets, and generation-checked fallback. Go-booba reached into renderer geometry and tracked write depth to distinguish terminal replies from user input.

## Disposal and memory reclamation

**Contract.** `terminal.dispose()` removes the DOM controllers, subscriptions, renderer, native render state, and native terminal. The default owned runtime is disposed with the session. A borrowed runtime remains active for its other terminals. Successful worker disposal awaits worker cleanup and terminates the worker. Worker cleanup races a 15-second deadline. If the deadline wins, disposal rejects and still terminates the worker, but pending GPU acquisition or queue-fence cleanup can remain incomplete. Main-thread GPU destruction waits for the last device lease and its queue fence, but main-thread `dispose()` does not wait for that fence.

Disposing an owned runtime makes its WASM instance and linear memory unreachable when the application releases its own references. JavaScript garbage collection reclaims them later. WASM linear memory does not shrink when an individual terminal in a borrowed runtime is disposed. There is no deterministic reclamation deadline.

**Implementation.** Runtime ownership is selected in [`src/term/session.ts:909`](../src/term/session.ts#L909-L916). Session teardown releases native resources and an owned runtime in [`src/term/session.ts:1619`](../src/term/session.ts#L1619-L1640). The DOM host tears down its controllers in [`src/dom/terminal.ts:979`](../src/dom/terminal.ts#L979-L1009). Worker disposal terminates in a `finally` block in [`src/worker/execution.ts:508`](../src/worker/execution.ts#L508-L542). The cleanup deadline and abandonment path are in [`src/worker/runtime.ts:683`](../src/worker/runtime.ts#L683-L725). The shared device owner destroys a device after its last lease in [`src/render/webgpu/device-owner.ts:35`](../src/render/webgpu/device-owner.ts#L35-L43).

**Tests.** Borrowed and owned session ownership is covered in [`src/term/tests/session.test.ts:1765`](../src/term/tests/session.test.ts#L1765-L1817). Repeated disposal and weak memory references are covered in [`src/core/tests/reclamation.test.ts`](../src/core/tests/reclamation.test.ts) and [`src/core/tests/fixtures/reclaim.ts`](../src/core/tests/fixtures/reclaim.ts). Worker device cleanup, including delayed queue fences and replacement devices, is covered in [`src/worker/terminal.browser.test.ts:416`](../src/worker/terminal.browser.test.ts#L416-L524). Deadline rejection and abandoned cleanup are covered in [`src/worker/terminal.browser.test.ts:636`](../src/worker/terminal.browser.test.ts#L636-L662) and [`src/worker/terminal.browser.test.ts:754`](../src/worker/terminal.browser.test.ts#L754-L774). Late WebGPU replacement during disposal is covered in [`src/render/tests/renderer.browser.test.ts:702`](../src/render/tests/renderer.browser.test.ts#L702-L745).

**Measured behavior.** The Bun fixture creates and disposes eight owned sessions, then forty borrowed sessions around one runtime. After eight warmup cycles, the next 32 borrowed cycles stay at or below the warmed linear-memory capacity while that runtime remains live. A weak reference confirms the borrowed memory is live before runtime teardown. Weak references to all eight owned memories clear after garbage collection, and the borrowed memory clears after the runtime is disposed and its scope returns. Removing session disposal from a fixture copy makes the live-memory assertion fail as native allocations accumulate. This is a Bun regression check, not a collection-time guarantee for Chromium, Firefox, or WebKit.

## Shared modules, runtimes, and devices

**Contract.** Each main-thread terminal owns a new runtime by default. Pass `runtime: { kind: 'borrowed', runtime }` to share one runtime instance, its linear memory, and its callback bridge across sessions. Pass a `WebAssembly.Module` as `wasm` or `bridge` to reuse compiled code while keeping separate runtime instances and memories. Supplying bytes or URLs compiles for each runtime creation.

Built-in main-thread WebGPU renderers share devices through module-local leased owners. Atlas textures and frame builders remain per renderer. Each worker terminal has a dedicated worker, runtime, WASM memory, and device owner. Public worker options do not offer a borrowed runtime or shared device.

**Implementation.** Runtime creation accepts compiled modules and instantiates them in [`src/core/runtime.ts:38`](../src/core/runtime.ts#L38-L50) and [`src/core/runtime.ts:89`](../src/core/runtime.ts#L89-L112). Borrowed sessions are acquired in [`src/term/session.ts:909`](../src/term/session.ts#L909-L916). The default main-thread device owners are module-local in [`src/render/webgpu/renderer.ts:132`](../src/render/webgpu/renderer.ts#L132-L138). Worker options exclude `runtime` and `rendererFactory` in [`src/worker/index.ts:7`](../src/worker/index.ts#L7-L15).

**Tests.** Device deduplication, last-lease destruction, and replacement generations are covered in [`src/render/tests/device-owner.test.ts:16`](../src/render/tests/device-owner.test.ts#L16-L110). Shared borrowed sessions are covered in [`src/term/tests/session.test.ts:1765`](../src/term/tests/session.test.ts#L1765-L1795). Reusing one compiled native and bridge module across independent runtimes with isolated memories is covered in [`src/core/tests/runtime.test.ts:90`](../src/core/tests/runtime.test.ts#L90-L113).

**Remaining gap and reason.** Multi-worker applications cannot opt into shared runtimes or devices through the public worker API. Closing this needs the X4 worker-pool design, not a reference-counting patch to the dedicated-worker actor. One worker must own several terminal generations, native sessions, output sequencing, renderer resources, and device teardown while preserving per-terminal acknowledgement and disposal behavior. That change also needs the X4 memory, host-publication, and busiest-terminal latency measurements before it becomes a public contract.

## Scrollback budgets

**Contract.** `appearance.scrollbackLimit` budgets physical history rows. `appearance.scrollbackByteLimit` budgets native page allocation and includes the active area. Both use Ghostty's page-granular pruning, so retained rows can exceed or undershoot a configured value. A zero byte budget disables history. Applications can set either budget at creation or through `setAppearance`, then read actual retention through `lineCount()` on a terminal or `scrollbackLength` on a session or native terminal.

An omitted byte budget at creation preserves Ghostty's native default. Omitted or explicitly undefined budgets in `setAppearance()` preserve the current values. Only the dedicated `TerminalSession` and `GhosttyTerminal` setters treat `undefined` as removing a budget. For main-thread and worker `Terminal.setAppearance()`, pass the native unlimited sentinel `0xffffffff` to remove either budget.

**Implementation.** Public options are defined in [`src/term/types.ts:91`](../src/term/types.ts#L91-L118). Creation defaults and appearance-update preservation are in [`src/term/session.ts:701`](../src/term/session.ts#L701-L753). Native getters and dedicated setters are implemented in [`src/core/terminal.ts:288`](../src/core/terminal.ts#L288-L310) and [`src/core/terminal.ts:422`](../src/core/terminal.ts#L422-L457).

**Tests.** Native byte-budget behavior is covered in [`src/core/tests/history.test.ts:54`](../src/core/tests/history.test.ts#L54-L77). Session creation, updates, pruning, and actual row counts are covered in [`src/term/tests/session.test.ts:1002`](../src/term/tests/session.test.ts#L1002-L1050). Unlimited sentinel and independent-budget behavior continue through [`src/term/tests/session.test.ts:1101`](../src/term/tests/session.test.ts#L1101-L1115).

**Documentation.** The page-granular rules and examples are already in [the API reference](api.md#scrollback-retention). No gap remains in this guarantee.

## Generation-safe renderer replacement

**Contract.** Initial backend fallback disposes failed attempts. WebGL context loss stops calls to the old renderer while a replacement is created. A replacement that finishes after disposal or another state change is disposed instead of installed. WebGPU recovery attaches an expected device generation to loss callbacks and discards stale devices and resources. Worker protocol envelopes also reject stale terminal generations and control order.

**Implementation.** Initial selection is in [`src/render/shared/selector.ts:17`](../src/render/shared/selector.ts#L17-L67). WebGL fallback state and late-replacement disposal are in [`src/render/shared/fallback.ts:172`](../src/render/shared/fallback.ts#L172-L225). WebGPU generation checks are in [`src/render/webgpu/renderer.ts:756`](../src/render/webgpu/renderer.ts#L756-L811). Worker control-envelope ordering is checked in [`src/worker/runtime.ts:426`](../src/worker/runtime.ts#L426-L440), and producer-output identity and sequence checks are in [`src/worker/runtime.ts:602`](../src/worker/runtime.ts#L602-L607).

**Tests.** WebGPU recovery and full repaint are covered in [`src/render/tests/renderer.browser.test.ts:665`](../src/render/tests/renderer.browser.test.ts#L665-L745). Acquisition and setup failures are covered in [`src/render/tests/renderer.browser.test.ts:748`](../src/render/tests/renderer.browser.test.ts#L748-L830). WebGL replacements that finish after disposal or abort are covered in [`src/render/tests/fallback.browser.test.ts:157`](../src/render/tests/fallback.browser.test.ts#L157-L180). Packaged worker generation checks are covered in [`src/worker/terminal.browser.test.ts:1084`](../src/worker/terminal.browser.test.ts#L1084-L1129).

**Documentation.** Backend order and recovery behavior are in [the API reference](api.md#packaged-worker-checkpoint) and [the architecture overview](concepts.md#four-renderers-and-the-order-they-are-tried). No built-in renderer gap remains in this guarantee.

## Headless core imports

**Contract.** `GhosttyRuntime`, `GhosttyTerminal`, and `TerminalSession` can parse and read terminal state without creating a DOM terminal. Import them from `ghostty-webgpu/core` for a runtime module graph with no DOM or renderer modules. The package root also exports these classes, but its graph includes the DOM host and built-in renderers. Bundler tree shaking is not a core-only import contract.

```ts
import { GhosttyRuntime } from 'ghostty-webgpu/core'

const runtime = await GhosttyRuntime.create()
const terminal = runtime.createTerminal({ columns: 80, rows: 24 })
terminal.write('headless\r\n')
console.log(terminal.readLines(0, 1))
terminal.dispose()
runtime.dispose()
```

**Implementation.** The core entry exports the headless classes in [`src/core/index.ts`](../src/core/index.ts). Frame observer symbols, color contrast, and the default terminal theme live in core or term modules instead of renderer modules. The package subpath is declared in [`package.json`](../package.json) with current and legacy TypeScript declarations.

**Tests.** Core runtime behavior runs under Node in [`src/core/tests/runtime.test.ts:34`](../src/core/tests/runtime.test.ts#L34-L115). The source entry test in [`src/core/tests/entry.test.ts`](../src/core/tests/entry.test.ts) rejects runtime imports from DOM and renderer directories. The packed package check in [`scripts/package-smoke.ts`](../scripts/package-smoke.ts) repeats that graph check, imports `ghostty-webgpu/core`, and creates and disposes a native terminal.

**Documentation.** No gap remains in this guarantee.

## WASM assets and loading

**Contract.** Releases ship raw `ghostty-vt.wasm`, `bridge.wasm`, `canvas-compose.wasm`, and `canvas-compose-scalar.wasm` files. The package exports all four. Main-thread native and bridge assets accept URLs, strings, bytes, or compiled modules. Worker native and bridge assets accept explicit URL strings. The installation guide includes Vite and Bun layouts.

URL loading uses `WebAssembly.compileStreaming` when available. It clones the response before streaming and falls back to byte compilation if streaming rejects, including an incorrect MIME type. The Canvas compositor accepts a `compositorAsset` URL override on main-thread terminals and renderer options. Its default loader validates the SIMD artifact and fetches the scalar artifact when SIMD validation fails. An explicit override never falls back to a different asset.

**Implementation.** Raw files and exports are declared in [`package.json`](../package.json). The `WasmSource` union is in [`src/core/types.ts:9`](../src/core/types.ts#L9-L14). Streaming and byte compilation are in [`src/core/runtime.ts:19`](../src/core/runtime.ts#L19-L65). Compositor loading and capability selection are in [`src/render/pixels/kernel.ts:88`](../src/render/pixels/kernel.ts#L88-L113). Main-thread renderer initialization passes the override through [`src/dom/terminal.ts`](../src/dom/terminal.ts) and [`src/render/canvas/renderer.ts`](../src/render/canvas/renderer.ts).

**Tests.** Runtime export validation and streaming fallback are covered in [`src/core/tests/runtime.test.ts`](../src/core/tests/runtime.test.ts). Bridge build-time export validation is in [`scripts/build-bridge.ts:36`](../scripts/build-bridge.ts#L36-L60). Scalar and SIMD compositor tests start in [`src/render/pixels/kernel.test.ts:189`](../src/render/pixels/kernel.test.ts#L189-L230). Explicit URLs, scalar selection, and renderer override forwarding are covered in [`src/render/pixels/kernel.test.ts`](../src/render/pixels/kernel.test.ts) and [`src/render/pixels/pixels.browser.test.ts`](../src/render/pixels/pixels.browser.test.ts). Package contents and raw WASM files are checked in [`scripts/package-smoke.ts`](../scripts/package-smoke.ts).

**Documentation.** No gap remains in this guarantee.

## Host-owned geometry and DPR

**Contract.** Applications do not need renderer internals to obtain terminal geometry. `terminal.appearance.grid` exposes columns, rows, CSS cell dimensions, and DPR. `terminal.geometry()` reads live native grid and CSS cell dimensions. After the first submitted frame, `terminal.submittedFrame` exposes the complete fitted font, CSS and device cell dimensions, baseline, DPR, padding, and grid. `fitTerminalFont` provides the same measurement policy for hosts that need metrics before a frame. On main-thread terminals, `fitEnvironment.getPixelRatio` and `subscribePixelRatio` let a host own DPR behavior.

Worker terminals accept the same `fitEnvironment.getPixelRatio` and `subscribePixelRatio` hooks. The host evaluates the selected ratio, includes it in each numeric worker layout, and sends a fresh layout when the host subscription fires. The other fit-environment hooks remain main-thread-only because the worker owns font measurement and scheduling. A host that needs a capped or custom DPR no longer needs renderer internals or a different worker API.

**Implementation.** Public grid and fitted-font shapes are in [`src/term/types.ts:41`](../src/term/types.ts#L41-L72). Submitted geometry is in [`src/dom/submitted-frame.ts:13`](../src/dom/submitted-frame.ts#L13-L27) and [`src/dom/terminal.ts:669`](../src/dom/terminal.ts#L669-L695). The shared DPR hooks are in [`src/dom/fit.ts:37`](../src/dom/fit.ts#L37-L43). Worker options accept those hooks in [`src/worker/index.ts:7`](../src/worker/index.ts#L7-L15). The host reads the selected ratio and subscribes in [`src/worker/layout.ts:5`](../src/worker/layout.ts#L5-L69), then sends numeric geometry to [`src/worker/runtime.ts:189`](../src/worker/runtime.ts#L189-L234).

**Tests.** Fitted font math at fractional DPR and mounted backing geometry are covered in [`src/dom/tests/font-geometry.browser.test.ts:32`](../src/dom/tests/font-geometry.browser.test.ts#L32-L115). Native DPR resize behavior is covered in [`src/term/tests/session.test.ts:892`](../src/term/tests/session.test.ts#L892-L917). Worker-submitted window DPR is checked in [`src/worker/terminal.browser.test.ts:1917`](../src/worker/terminal.browser.test.ts#L1917-L1940). Host-selected worker DPR, later subscription changes, and subscription disposal are covered in [`src/worker/terminal.browser.test.ts:1881`](../src/worker/terminal.browser.test.ts#L1881-L1914).

**Documentation.** CSS and device-pixel rules are already in [the font geometry guide](font-geometry.md#native-fitted-units). No gap remains in this guarantee.

## Synchronous replies and reentrancy

**Contract.** Main-thread `write()` parses synchronously. Native query replies are emitted through `onData` before that `write()` returns, on the same native path as keystrokes. Applications must expect reentrant observers and must not treat every emission as human input. Worker calls return promises, but the worker's native session uses the same reply classification.

`TerminalSession` labels its data events with `origin: 'input' | 'reply'`. The DOM `Terminal` emits that same `TerminalDataEvent` shape through `onData`, with an owned copy of the bytes. Applications forward `event.bytes` to a PTY and use `event.origin` when they need to exclude terminal replies from human-input handling. Tracking write depth is no longer needed to recover the library's classification.

**Implementation.** Synchronous writes and effect flushing are in [`src/term/session.ts:1648`](../src/term/session.ts#L1648-L1660) and [`src/term/session.ts:1884`](../src/term/session.ts#L1884-L1912). Session origin metadata is defined in [`src/term/types.ts:236`](../src/term/types.ts#L236-L240). The DOM host preserves it in [`src/dom/terminal.ts:1236`](../src/dom/terminal.ts#L1236-L1249).

**Tests.** Core query callbacks during writes are covered in [`src/core/tests/runtime.test.ts:117`](../src/core/tests/runtime.test.ts#L117-L146). Native replies bypassing DOM input claims are covered in [`src/dom/tests/extensions.browser.test.ts:1427`](../src/dom/tests/extensions.browser.test.ts#L1427-L1453). Public reply origin and synchronous event order are covered in [`src/dom/tests/extensions.browser.test.ts:1417`](../src/dom/tests/extensions.browser.test.ts#L1417-L1425).

**Documentation.** No gap remains in this guarantee.

## Gaps and proposed fixes

| Guarantee      | Gap                                                | One-line fix proposal                                                                                        |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Shared workers | Worker terminals cannot share a runtime or device. | Implement and qualify the X4 worker pool with per-terminal lifecycle, output ordering, and latency coverage. |
