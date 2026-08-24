export const cellShader = /* wgsl */ `
const FLAG_CURSOR: u32 = 1u;
const FLAG_OVERLINE: u32 = 2u;
const FLAG_STRIKETHROUGH: u32 = 4u;

struct Instance {
  rect: vec4f,
  foreground: vec4f,
  background: vec4f,
  metadata: vec4f,
}

struct Viewport {
  size: vec2f,
  padding: vec2f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) foreground: vec4f,
  @location(1) background: vec4f,
  @location(2) metadata: vec4f,
  @location(3) local: vec2f,
  @location(4) size: vec2f,
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
  let corner = corners[vertexIndex];
  let local = corner * instance.rect.zw;
  let pixel = instance.rect.xy + local;
  var output: VertexOutput;
  output.position = vec4f(
    pixel.x / viewport.size.x * 2.0 - 1.0,
    1.0 - pixel.y / viewport.size.y * 2.0,
    0.0,
    1.0,
  );
  output.foreground = instance.foreground;
  output.background = instance.background;
  output.metadata = instance.metadata;
  output.local = local;
  output.size = instance.rect.zw;
  return output;
}

fn srgbChannelToLinear(value: f32) -> f32 {
  if (value <= 0.04045) {
    return value / 12.92;
  }
  return pow((value + 0.055) / 1.055, 2.4);
}

fn luminance(color: vec3f) -> f32 {
  let linear = vec3f(
    srgbChannelToLinear(color.r),
    srgbChannelToLinear(color.g),
    srgbChannelToLinear(color.b),
  );
  return dot(linear, vec3f(0.2126, 0.7152, 0.0722));
}

fn contrastRatio(first: vec3f, second: vec3f) -> f32 {
  let bright = max(luminance(first), luminance(second));
  let dark = min(luminance(first), luminance(second));
  return (bright + 0.05) / (dark + 0.05);
}

fn contrastColor(foreground: vec3f, background: vec3f, minimum: f32) -> vec3f {
  if (minimum <= 1.0 || contrastRatio(foreground, background) >= minimum) {
    return foreground;
  }
  let black = vec3f(0.0);
  let white = vec3f(1.0);
  if (contrastRatio(white, background) >= contrastRatio(black, background)) {
    return white;
  }
  return black;
}

fn hasFlag(flags: u32, flag: u32) -> bool {
  return (flags & flag) != 0u;
}

fn lineCoverage(position: f32, center: f32) -> f32 {
  return select(0.0, 1.0, abs(position - center) <= 0.5);
}

fn underlineCoverage(style: u32, local: vec2f, size: vec2f) -> f32 {
  if (style == 0u) {
    return 0.0;
  }
  let lower = size.y - 2.0;
  if (style == 1u) {
    return lineCoverage(local.y, lower);
  }
  if (style == 2u) {
    return max(lineCoverage(local.y, lower), lineCoverage(local.y, lower - 3.0));
  }
  if (style == 3u) {
    let wave = lower - 1.0 + sin(local.x * 1.5707963);
    return lineCoverage(local.y, wave);
  }
  if (style == 4u) {
    let dot = select(0.0, 1.0, (local.x % 4.0) < 2.0);
    return dot * lineCoverage(local.y, lower);
  }
  let dash = select(0.0, 1.0, (local.x % 8.0) < 5.0);
  return dash * lineCoverage(local.y, lower);
}

fn decorationCoverage(flags: u32, underline: u32, local: vec2f, size: vec2f) -> f32 {
  var coverage = underlineCoverage(underline, local, size);
  if (hasFlag(flags, FLAG_STRIKETHROUGH)) {
    coverage = max(coverage, lineCoverage(local.y, floor(size.y * 0.52)));
  }
  if (hasFlag(flags, FLAG_OVERLINE)) {
    coverage = max(coverage, lineCoverage(local.y, 1.0));
  }
  return coverage;
}

fn cursorCoverage(flags: u32, style: u32, local: vec2f, size: vec2f) -> f32 {
  if (!hasFlag(flags, FLAG_CURSOR) || style == 0u) {
    return 0.0;
  }
  if (style == 1u) {
    return select(0.0, 1.0, local.x < max(1.0, floor(size.x * 0.15)));
  }
  if (style == 2u) {
    return select(0.0, 1.0, local.y >= size.y - max(1.0, floor(size.y * 0.16)));
  }
  let thickness = max(1.0, floor(min(size.x, size.y) * 0.08));
  let edge = min(min(local.x, size.x - local.x), min(local.y, size.y - local.y));
  return select(0.0, 1.0, edge < thickness);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let flags = u32(input.metadata.x);
  let underline = u32(input.metadata.y);
  let cursorStyle = u32(input.metadata.z);
  let minimumContrast = input.metadata.w;
  let decoration = decorationCoverage(flags, underline, input.local, input.size);
  let cursor = cursorCoverage(flags, cursorStyle, input.local, input.size);
  let effectAlpha = max(decoration, cursor) * input.foreground.a;
  let adjusted = contrastColor(input.foreground.rgb, input.background.rgb, minimumContrast);
  let background = vec4f(input.background.rgb * input.background.a, input.background.a);
  let effect = vec4f(adjusted * effectAlpha, effectAlpha);
  return effect + background * (1.0 - effectAlpha);
}
`
