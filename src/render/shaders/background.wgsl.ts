export const backgroundShader = /* wgsl */ `
struct Instance {
  rect: vec4f,
  color: vec4f,
}

struct Viewport {
  size: vec2f,
  padding: vec2f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@group(0) @binding(0) var<storage, read> instances: array<Instance>;
@group(0) @binding(1) var<uniform> viewport: Viewport;

@vertex
fn vertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let instance = instances[instanceIndex];
  let pixel = instance.rect.xy + corners[vertexIndex] * instance.rect.zw;
  var output: VertexOutput;
  output.position = vec4f(
    pixel.x / viewport.size.x * 2.0 - 1.0,
    1.0 - pixel.y / viewport.size.y * 2.0,
    0.0,
    1.0,
  );
  output.color = instance.color;
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color.rgb * input.color.a, input.color.a);
}
`
