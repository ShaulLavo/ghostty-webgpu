# Usage and lifecycle

Install the addon separately from `ghostty-webgpu`. Terminal core has no dependency on this package.

```ts
import { createShaderAddon } from 'ghostty-webgpu-shaders'

const handle = terminal.use(
  createShaderAddon(compiled, {
    paused: false,
    onError: (error) => console.error(error.code, error.message),
  }),
)
await handle.api.ready
await handle.api.setShader(nextCompiled)
handle.api.setPaused(true)
handle.dispose()
```

`compiled` is an object containing nonempty `wgsl`, `glsl`, or both. These are already compiled fragment programs. A full `CompiledGhosttyShader` object from `ghostty-web-shaderc` is structurally accepted. Partial output may omit `schemaVersion`, `uniformLayout`, `entryPoint`, and `webgl`. If supplied, the schema and layout must be `1` and `ghostty-v1`. See [bindings](bindings.md) for custom authoring.

Compile in your build or with a compiler you load yourself. This package neither resolves nor loads a compiler, parser, WASM, or Three.js. Its packed entry can be imported without a terminal runtime installed. The terminal peer supplies TypeScript types and the host extension lifecycle.

## Backend selection

With both languages, the addon prefers WebGL2 when the terminal selected WebGL2, and WebGPU otherwise. If a WebGPU adapter/device is unavailable and GLSL is present, it uses WebGL2. WGSL-only output selects WebGPU; GLSL-only output selects WebGL2. Canvas2D source terminals work with either output backend.

`backend: 'webgpu' | 'webgl2'` makes selection strict. Missing language output or unavailable browser capability rejects `ready` with a `ShaderAddonError`. Backend selection happens once per installation. Replacements must supply that backend's language.

## Installation and replacement

Installation works before or after `terminal.open()`. `ready` waits for opening, output device initialization, and a valid shader. It rejects if initialization fails or the addon is disposed first.

`setShader` resolves `true` when its program becomes current. A superseded request or disposal resolves `false`. Requests are serialized, and only the newest can become current. Invalid replacements reject while keeping the last valid program and pixels. An invalid initial program rejects `ready`, removes the addon canvas, and calls `onError`.

Main-thread WebGPU, WebGL2, and Canvas2D terminals are supported. DOM renderers reject with code `backend`. Worker terminals reject with code `worker`: their asynchronous snapshots arrive after the non-preserved source drawing buffer can clear. Use a main-thread terminal for this addon.

## Capture and ownership

The addon inserts a `pointer-events: none`, `aria-hidden` overlay into `terminal.element`, before the terminal's input/composition elements. It follows the source content box, padding, backing dimensions, and DPR. Source canvas, focus, keyboard input, selection, and accessibility nodes stay owned by the terminal. Renderer recovery can replace the source canvas; the next submitted frame retargets capture and geometry.

A synchronous public `frame` callback copies the source into an owned Canvas2D staging canvas. This preserves WebGL2 frames with `preserveDrawingBuffer: false`. Transparent cleared-buffer copies leave the previous opaque terminal snapshot intact. Installation calls the public `clearTextureAtlas()` once to guarantee a fresh draw even for an unchanged, already-presented terminal. The output then uploads that snapshot. This copy has a cost proportional to terminal pixel area; this package makes no hardware performance claim.

At most one output draw is submitted per animation frame and one unfinished effect frame is retained. WebGPU queue completion and WebGL2 fences gate uploads/draws. Busy output retains the latest snapshot and elapsed time. Pause and document visibility freeze effect time. Terminal changes can still redraw while paused; hidden documents resume with current terminal state.

`handle.dispose()` removes only the overlay and owned resources/listeners. It leaves the terminal usable. Terminal disposal also disposes the addon. Device/context loss rejects pending installation, removes the overlay, and calls `onError`; reinstall to create fresh output resources. Original terminal pixels remain underneath on disposal or failure.
