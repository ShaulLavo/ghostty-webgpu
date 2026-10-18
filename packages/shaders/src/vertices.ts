/** Draw three vertices. Channel textures use row zero as the logical bottom row. */
export const FULLSCREEN_VERTEX_WGSL = `struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn main(@builtin(vertex_index) index: u32) -> VertexOutput {
  let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  var output: VertexOutput;
  output.position = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
  output.uv = uv;
  return output;
}
`

/** Draw three vertices with no vertex buffers. Matches the WGSL vertex output. */
export const FULLSCREEN_VERTEX_GLSL = `#version 300 es
precision highp float;
out vec2 _vs2fs_location0;

void main() {
  vec2 uv = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  _vs2fs_location0 = uv;
}
`
