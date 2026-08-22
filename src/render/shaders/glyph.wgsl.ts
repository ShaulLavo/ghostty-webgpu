export const glyphShader = /* wgsl */ `
const FLAG_UNDERLINE: u32 = 1u;
const FLAG_UNDERCURL: u32 = 2u;
const FLAG_STRIKETHROUGH: u32 = 4u;
const FLAG_OVERLINE: u32 = 8u;
const FLAG_INVISIBLE: u32 = 64u;
const FLAG_CURSOR: u32 = 128u;
const FLAG_OUTLINE_CURSOR: u32 = 256u;
const FLAG_GLYPH: u32 = 512u;

struct Instance {
  rect: vec4f,
  color: vec4f,
  uv: vec4f,
  background: vec4f,
  attributes: vec4f,
  atlas: vec4f,
}

struct Viewport {
  size: vec2f,
  padding: vec2f,
}

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
  @location(1) uv: vec2f,
  @location(2) background: vec4f,
  @location(3) attributes: vec4f,
  @location(4) atlas: vec4f,
  @location(5) corner: vec2f,
}

@group(0) @binding(0) var<storage, read> instances: array<Instance>;
@group(0) @binding(1) var<uniform> viewport: Viewport;
@group(0) @binding(2) var atlasSampler: sampler;
@group(0) @binding(3) var grayscaleAtlas: texture_2d<f32>;
@group(0) @binding(4) var colorAtlas: texture_2d<f32>;

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
  let pixel = instance.rect.xy + corner * instance.rect.zw;
  var output: VertexOutput;
  output.position = vec4f(
    pixel.x / viewport.size.x * 2.0 - 1.0,
    1.0 - pixel.y / viewport.size.y * 2.0,
    0.0,
    1.0,
  );
  output.color = instance.color;
  output.uv = mix(instance.uv.xy, instance.uv.zw, corner);
  output.background = instance.background;
  output.attributes = instance.attributes;
  output.atlas = instance.atlas;
  output.corner = corner;
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

fn lineCoverage(distance: f32, thickness: f32) -> f32 {
  return select(0.0, 1.0, abs(distance) <= thickness);
}

fn decorationCoverage(flags: u32, cursorStyle: u32, corner: vec2f) -> f32 {
  var coverage = 0.0;
  if (hasFlag(flags, FLAG_UNDERLINE)) {
    coverage = max(coverage, lineCoverage(corner.y - 0.86, 0.045));
  }
  if (hasFlag(flags, FLAG_UNDERCURL)) {
    let wave = 0.86 + sin(corner.x * 18.8495559) * 0.07;
    coverage = max(coverage, lineCoverage(corner.y - wave, 0.035));
  }
  if (hasFlag(flags, FLAG_STRIKETHROUGH)) {
    coverage = max(coverage, lineCoverage(corner.y - 0.52, 0.045));
  }
  if (hasFlag(flags, FLAG_OVERLINE)) {
    coverage = max(coverage, lineCoverage(corner.y - 0.08, 0.045));
  }
  if (hasFlag(flags, FLAG_CURSOR) && cursorStyle == 1u) {
    coverage = max(coverage, select(0.0, 1.0, corner.x <= 0.15));
  }
  if (hasFlag(flags, FLAG_CURSOR) && cursorStyle == 2u) {
    coverage = max(coverage, select(0.0, 1.0, corner.y >= 0.84));
  }
  if (hasFlag(flags, FLAG_OUTLINE_CURSOR)) {
    let edge = min(min(corner.x, 1.0 - corner.x), min(corner.y, 1.0 - corner.y));
    coverage = max(coverage, select(0.0, 1.0, edge <= 0.08));
  }
  return coverage;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let flags = u32(input.attributes.x);
  let cursorStyle = u32(input.attributes.y);
  let minimumContrast = input.attributes.z;
  let hasGlyph = hasFlag(flags, FLAG_GLYPH) && !hasFlag(flags, FLAG_INVISIBLE);
  let grayscale = textureSample(grayscaleAtlas, atlasSampler, input.uv).r;
  let colorSample = textureSample(colorAtlas, atlasSampler, input.uv);
  let colorGlyph = input.atlas.z >= 0.5;
  let glyphCoverage = select(0.0, select(grayscale, colorSample.a, colorGlyph), hasGlyph);
  let decoration = decorationCoverage(flags, cursorStyle, input.corner);
  let coverage = max(glyphCoverage, decoration);
  let adjusted = contrastColor(input.color.rgb, input.background.rgb, minimumContrast);
  let rgb = select(adjusted, colorSample.rgb, colorGlyph && hasGlyph);
  let alpha = coverage * input.color.a;
  return vec4f(rgb * alpha, alpha);
}
`
