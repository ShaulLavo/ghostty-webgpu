const vertexHeader = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 viewport;
const vec2 corners[6] = vec2[6](
  vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
);
vec4 clipPosition(vec2 pixel) {
  return vec4(pixel.x / viewport.x * 2.0 - 1.0,
    1.0 - pixel.y / viewport.y * 2.0, 0.0, 1.0);
}
`

const fragmentHeader = `#version 300 es
precision highp float;
precision highp int;
out vec4 outputColor;

float srgbChannelToLinear(float value) {
  if (value <= 0.04045) return value / 12.92;
  return pow((value + 0.055) / 1.055, 2.4);
}

float luminance(vec3 color) {
  vec3 linear = vec3(srgbChannelToLinear(color.r),
    srgbChannelToLinear(color.g), srgbChannelToLinear(color.b));
  return dot(linear, vec3(0.2126, 0.7152, 0.0722));
}

float contrastRatio(vec3 first, vec3 second) {
  float bright = max(luminance(first), luminance(second));
  float dark = min(luminance(first), luminance(second));
  return (bright + 0.05) / (dark + 0.05);
}

vec3 contrastColor(vec3 foreground, vec3 background, float minimum) {
  if (minimum <= 1.0 || contrastRatio(foreground, background) >= minimum) return foreground;
  if (contrastRatio(vec3(1.0), background) >= contrastRatio(vec3(0.0), background)) {
    return vec3(1.0);
  }
  return vec3(0.0);
}

bool hasFlag(uint flags, uint flag) {
  return (flags & flag) != 0u;
}
`

export const cellVertexShader = `${vertexHeader}
layout(location = 0) in vec4 rect;
layout(location = 1) in vec4 foreground;
layout(location = 2) in vec4 background;
layout(location = 3) in vec4 metadata;
flat out vec4 v_foreground;
flat out vec4 v_background;
flat out vec4 v_metadata;
out vec2 v_local;
flat out vec2 v_size;

void main() {
  vec2 local = corners[gl_VertexID] * rect.zw;
  gl_Position = clipPosition(rect.xy + local);
  v_foreground = foreground;
  v_background = background;
  v_metadata = metadata;
  v_local = local;
  v_size = rect.zw;
}
`

export const cellFragmentShader = `${fragmentHeader}
flat in vec4 v_foreground;
flat in vec4 v_background;
flat in vec4 v_metadata;
in vec2 v_local;
flat in vec2 v_size;

float lineCoverage(float position, float center) {
  return abs(position - center) <= 0.5 ? 1.0 : 0.0;
}

float underlineCoverage(uint style, vec2 local, vec2 size) {
  if (style == 0u) return 0.0;
  float lower = size.y - 2.0;
  if (style == 1u) return lineCoverage(local.y, lower);
  if (style == 2u) return max(lineCoverage(local.y, lower), lineCoverage(local.y, lower - 3.0));
  if (style == 3u) {
    float wave = lower - 1.0 + sin(local.x * 1.5707963);
    return lineCoverage(local.y, wave);
  }
  if (style == 4u) {
    float dotCoverage = mod(local.x, 4.0) < 2.0 ? 1.0 : 0.0;
    return dotCoverage * lineCoverage(local.y, lower);
  }
  float dash = mod(local.x, 8.0) < 5.0 ? 1.0 : 0.0;
  return dash * lineCoverage(local.y, lower);
}

float decorationCoverage(uint flags, uint underline, vec2 local, vec2 size) {
  float coverage = underlineCoverage(underline, local, size);
  if (hasFlag(flags, 4u)) coverage = max(coverage, lineCoverage(local.y, floor(size.y * 0.52)));
  if (hasFlag(flags, 2u)) coverage = max(coverage, lineCoverage(local.y, 1.0));
  return coverage;
}

float cursorCoverage(uint flags, uint style, vec2 local, vec2 size) {
  if (!hasFlag(flags, 1u) || style == 0u) return 0.0;
  if (style == 1u) return local.x < max(1.0, floor(size.x * 0.15)) ? 1.0 : 0.0;
  if (style == 2u) return local.y >= size.y - max(1.0, floor(size.y * 0.16)) ? 1.0 : 0.0;
  float thickness = max(1.0, floor(min(size.x, size.y) * 0.08));
  float edge = min(min(local.x, size.x - local.x), min(local.y, size.y - local.y));
  return edge < thickness ? 1.0 : 0.0;
}

void main() {
  uint flags = uint(v_metadata.x);
  float decoration = decorationCoverage(flags, uint(v_metadata.y), v_local, v_size);
  float cursor = cursorCoverage(flags, uint(v_metadata.z), v_local, v_size);
  float effectAlpha = max(decoration, cursor) * v_foreground.a;
  vec3 adjusted = contrastColor(v_foreground.rgb, v_background.rgb, v_metadata.w);
  vec4 background = vec4(v_background.rgb * v_background.a, v_background.a);
  vec4 effect = vec4(adjusted * effectAlpha, effectAlpha);
  outputColor = effect + background * (1.0 - effectAlpha);
}
`

export const glyphVertexShader = `${vertexHeader}
layout(location = 0) in vec4 rect;
layout(location = 1) in vec4 color;
layout(location = 2) in vec4 uv;
layout(location = 3) in vec4 background;
layout(location = 4) in vec4 attributes;
layout(location = 5) in vec4 atlas;
flat out vec4 v_color;
out vec2 v_uv;
flat out vec4 v_background;
flat out vec4 v_attributes;
flat out vec4 v_atlas;

void main() {
  vec2 corner = corners[gl_VertexID];
  gl_Position = clipPosition(rect.xy + corner * rect.zw);
  v_color = color;
  v_uv = mix(uv.xy, uv.zw, corner);
  v_background = background;
  v_attributes = attributes;
  v_atlas = atlas;
}
`

export const glyphFragmentShader = `${fragmentHeader}
precision highp sampler2DArray;
uniform sampler2DArray grayscaleAtlas;
uniform sampler2DArray colorAtlas;
flat in vec4 v_color;
in vec2 v_uv;
flat in vec4 v_background;
flat in vec4 v_attributes;
flat in vec4 v_atlas;

void main() {
  bool hasGlyph = hasFlag(uint(v_attributes.x), 1u);
  vec3 coordinate = vec3(v_uv, v_atlas.x);
  float grayscale = texture(grayscaleAtlas, coordinate).r;
  vec4 colorSample = texture(colorAtlas, coordinate);
  bool colorGlyph = v_atlas.z >= 0.5;
  float coverage = colorGlyph ? colorSample.a : grayscale;
  if (!hasGlyph) coverage = 0.0;
  vec3 rgb = contrastColor(v_color.rgb, v_background.rgb, v_attributes.z);
  if (colorGlyph && hasGlyph) rgb = colorSample.rgb;
  float alpha = coverage * v_color.a;
  outputColor = vec4(rgb * alpha, alpha);
}
`
