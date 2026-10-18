# Shader bindings

The addon accepts compiled fragment programs through `CompiledShader`. It supplies a fullscreen triangle with no vertex buffers. Fragment entry defaults to `main`; WGSL can override it with `entryPoint`. The fragment input is `@location(0) vec2<f32>` in WGSL or `in vec2 _vs2fs_location0` in GLSL. UV `(0, 0)` is the bottom-left of the terminal content. Fragment output is a color at location zero. Output is opaque.

## Source texture

WebGPU group zero bindings are:

| Binding | Resource                                 |
| ------- | ---------------------------------------- |
| 0       | Uniform buffer, 4496 bytes               |
| 1       | Terminal `texture_2d<f32>`, RGBA8        |
| 2       | Filtering sampler, linear, clamp-to-edge |

Texture row zero is the logical bottom row on both backends. Sampling at UV `(0, 0)` reads the bottom-left terminal pixel. Direct WGSL position builtins still use WebGPU's native top-origin coordinates. The vertex UV is the shared bottom-origin coordinate.

A hand-authored compiled WGSL pass can use only the resources it needs:

```ts
const compiled = {
  wgsl: `
@group(0) @binding(1) var terminalTexture: texture_2d<f32>;
@group(0) @binding(2) var terminalSampler: sampler;
@fragment fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(terminalTexture, terminalSampler, uv);
}`,
}
```

For GLSL ES 3.00, `webgl.uniformBlock` names the std140 block and `webgl.channel0` names its `sampler2D`. They default to `GhosttyUniforms` and `iChannel0`. Use `null` for a resource your program omits, for example `webgl: { uniformBlock: null, channel0: null }` for a constant-color fragment. Full compiler output carries its generated names. The sampler uses texture unit zero, and the uniform block uses buffer binding zero.

## Uniform ABI

`SHADER_UNIFORM_FIELDS` exposes names, types, byte offsets, counts, and strides. `SHADER_UNIFORM_BYTE_LENGTH` is 4496. `packShaderUniforms(values, output?)` packs this little-endian std140 layout. Arrays use 16-byte strides, including scalar arrays. WGSL represents `iChannelTime` as four `vec4<f32>` values with each time in `.x`. Unused bytes and omitted values are zero, except `iResolution.z`, which defaults to one.

| Field                                                     | Type/count           | Byte offset   |
| --------------------------------------------------------- | -------------------- | ------------- |
| iResolution                                               | vec3                 | 0             |
| iTime, iTimeDelta, iFrameRate                             | float each           | 12, 16, 20    |
| iFrame                                                    | int                  | 24            |
| iChannelTime                                              | float[4], stride 16  | 32            |
| iChannelResolution                                        | vec3[4], stride 16   | 96            |
| iMouse, iDate                                             | vec4 each            | 160, 176      |
| iSampleRate                                               | float                | 192           |
| iCurrentCursor, iPreviousCursor                           | vec4 each            | 208, 224      |
| iCurrentCursorColor, iPreviousCursorColor                 | vec4 each            | 240, 256      |
| iCurrentCursorStyle, iPreviousCursorStyle, iCursorVisible | int each             | 272, 276, 280 |
| iTimeCursorChange, iTimeFocus                             | float each           | 284, 288      |
| iFocus                                                    | int                  | 292           |
| iPalette                                                  | vec3[256], stride 16 | 304           |
| iBackgroundColor, iForegroundColor                        | vec3 each            | 4400, 4416    |
| iCursorColor, iCursorText                                 | vec3 each            | 4432, 4448    |
| iSelectionForegroundColor, iSelectionBackgroundColor      | vec3 each            | 4464, 4480    |

Resolution uses backing pixels. Time is active elapsed seconds; delta is time since the last submitted effect frame. `iFrame` starts at zero and advances only on submission. Channel zero has the terminal dimensions/time; other channels and sample rate are zero. There are no additional channel textures.

Mouse `.xy` is the current bottom-origin backing-pixel position. `.zw` holds the press origin, positive while pressed and negative after release. Date is local year, zero-based month, day of month, and seconds since midnight.

Cursor rectangles are `(left, top, width, height)` in bottom-origin pixels. The previous rectangle/color/style changes when the current one changes. Styles are block `0`, bar `2`, underline `3`. Visibility reflects the last submitted terminal cursor paint. Focus is `1` when the terminal contains the active element. Cursor/focus timestamps use effect time. Theme colors and the 256-entry palette use normalized RGB; cursor colors include alpha one.

The uniform packing and bounded-frame scheduling are adapted from the MIT-licensed `ghostty-web-shaderc` runtime and showcase at revision `331a7ee`.
