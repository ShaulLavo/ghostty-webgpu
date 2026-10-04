#include <stdint.h>
#include <stddef.h>
#ifdef COMPOSE_SIMD
#include <wasm_simd128.h>
#endif

extern unsigned char __heap_base;
static uint32_t heap_start, heap_end;
typedef struct { uint32_t bytes, live, reserved0, reserved1; } Block;

static uint32_t memory_bytes(void) { return __builtin_wasm_memory_size(0) * 65536u; }
static int range(uint32_t ptr, uint64_t bytes) {
  return ptr >= (uint32_t)(uintptr_t)&__heap_base && bytes <= memory_bytes() && ptr <= memory_bytes() - bytes;
}

uint32_t compose_alloc(uint32_t bytes) {
  if (!bytes || bytes > 268435440u) return 0;
  bytes = (bytes + 15u) & ~15u;
  if (!heap_start) heap_start = heap_end = ((uint32_t)(uintptr_t)&__heap_base + 15u) & ~15u;
  for (uint32_t ptr = heap_start; ptr < heap_end;) {
    Block *block = (Block *)(uintptr_t)ptr;
    if (!block->live && block->bytes >= bytes) {
      uint32_t spare = block->bytes - bytes;
      if (spare >= sizeof(Block) + 16u) {
        Block *next = (Block *)(uintptr_t)(ptr + sizeof(Block) + bytes);
        *next = (Block){spare - sizeof(Block), 0, 0, 0};
        block->bytes = bytes;
      }
      block->live = 1;
      return ptr + sizeof(Block);
    }
    ptr += sizeof(Block) + block->bytes;
  }
  uint64_t next = (uint64_t)heap_end + sizeof(Block) + bytes;
  if (next > 268435456u) return 0;
  uint32_t available = memory_bytes();
  if (next > available && __builtin_wasm_memory_grow(0, (next - available + 65535u) / 65536u) == (size_t)-1) return 0;
  Block *block = (Block *)(uintptr_t)heap_end;
  *block = (Block){bytes, 1, 0, 0};
  uint32_t result = heap_end + sizeof(Block);
  heap_end = next;
  return result;
}

int compose_free(uint32_t offset) {
  uint32_t previous = 0;
  for (uint32_t ptr = heap_start; ptr < heap_end;) {
    Block *block = (Block *)(uintptr_t)ptr;
    if (ptr + sizeof(Block) != offset) { previous = ptr; ptr += sizeof(Block) + block->bytes; continue; }
    if (!block->live) return 0;
    block->live = 0;
    if (previous) {
      Block *before = (Block *)(uintptr_t)previous;
      if (!before->live) {
        before->bytes += sizeof(Block) + block->bytes;
        ptr = previous;
        block = before;
      }
    }
    uint32_t next = ptr + sizeof(Block) + block->bytes;
    while (next < heap_end) {
      Block *after = (Block *)(uintptr_t)next;
      if (after->live) break;
      block->bytes += sizeof(Block) + after->bytes;
      next = ptr + sizeof(Block) + block->bytes;
    }
    return 1;
  }
  return 0;
}

static int frame_valid(uint32_t ptr, uint32_t width, uint32_t height) {
  uint64_t pixels = (uint64_t)width * height;
  if (!width || !height || pixels > memory_bytes() / 4u) return 0;
  return range(ptr, pixels * 4u);
}
static int rect_valid(uint32_t width, uint32_t height, uint32_t x, uint32_t y, uint32_t w, uint32_t h) {
  return x <= width && y <= height && w <= width - x && h <= height - y;
}
static uint32_t read_pixel(const unsigned char *pixel) {
  return (uint32_t)pixel[0] | ((uint32_t)pixel[1] << 8) | ((uint32_t)pixel[2] << 16) | ((uint32_t)pixel[3] << 24);
}
static uint32_t divide255(uint32_t value) {
  value += 128u;
  return (value + (value >> 8)) >> 8;
}

static void over(unsigned char *destination, uint32_t rgba, uint32_t alpha) {
  if (!alpha) return;
  if (alpha == 255u) {
    for (uint32_t c = 0; c < 3; c++) destination[c] = rgba >> (c * 8);
    destination[3] = 255;
    return;
  }
  uint32_t ad = destination[3];
  uint32_t inverse = 255u - alpha;
  uint32_t denominator = alpha * 255u + ad * inverse;
#ifdef COMPOSE_SIMD
  v128_t bytes = wasm_i32x4_make(rgba, read_pixel(destination), 0, 0);
  v128_t channels = wasm_u16x8_extend_low_u8x16(bytes);
  // Products fit unsigned 16 bits; widen before adding or multiplying the destination weight.
  v128_t weights = wasm_i16x8_make(alpha, alpha, alpha, alpha, ad, ad, ad, ad);
  v128_t products = wasm_i16x8_mul(channels, weights);
  v128_t source = wasm_i32x4_mul(wasm_u32x4_extend_low_u16x8(products), wasm_i32x4_splat(255));
  v128_t retained = wasm_i32x4_mul(wasm_u32x4_extend_high_u16x8(products), wasm_i32x4_splat(inverse));
  v128_t numerator = wasm_i32x4_add(wasm_i32x4_add(source, retained), wasm_i32x4_splat(denominator / 2));
  uint32_t r = (uint32_t)wasm_i32x4_extract_lane(numerator, 0) / denominator;
  uint32_t g = (uint32_t)wasm_i32x4_extract_lane(numerator, 1) / denominator;
  uint32_t b = (uint32_t)wasm_i32x4_extract_lane(numerator, 2) / denominator;
  // Normalized lanes are 0..255, so signed saturating narrowing sees only positive values.
  v128_t result = wasm_u16x8_narrow_i32x4(wasm_i32x4_make(r, g, b, divide255(denominator)), wasm_i32x4_splat(0));
  result = wasm_u8x16_narrow_i16x8(result, wasm_i16x8_splat(0));
  uint32_t packed = wasm_i32x4_extract_lane(result, 0);
  for (uint32_t c = 0; c < 4; c++) destination[c] = packed >> (c * 8);
#else
  for (uint32_t c = 0; c < 3; c++) {
    uint32_t source = ((rgba >> (c * 8)) & 255u) * alpha * 255u;
    uint32_t retained = destination[c] * ad * inverse;
    destination[c] = (source + retained + denominator / 2) / denominator;
  }
  destination[3] = divide255(denominator);
#endif
}

int compose_clear(uint32_t ptr, uint32_t width, uint32_t height, uint32_t x, uint32_t y, uint32_t w, uint32_t h) {
  if (!frame_valid(ptr, width, height) || !rect_valid(width, height, x, y, w, h)) return 0;
  unsigned char *frame = (unsigned char *)(uintptr_t)ptr;
  for (uint32_t row = y; row < y + h; row++) {
    unsigned char *start = frame + ((uint64_t)row * width + x) * 4;
    uint32_t bytes = w * 4;
    uint32_t i = 0;
#ifdef COMPOSE_SIMD
    for (; i + 16 <= bytes; i += 16) wasm_v128_store(start + i, wasm_i32x4_splat(0));
#endif
    for (; i < bytes; i++) start[i] = 0;
  }
  return 1;
}

int compose_fill(uint32_t ptr, uint32_t width, uint32_t height, uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t rgba, uint32_t opacity) {
  if (!frame_valid(ptr, width, height) || !rect_valid(width, height, x, y, w, h) || opacity > 65535u) return 0;
  uint32_t alpha = (((uint64_t)(rgba >> 24) * opacity) + 32767u) / 65535u;
  unsigned char *frame = (unsigned char *)(uintptr_t)ptr;
  for (uint32_t row = y; row < y + h; row++)
    for (uint32_t column = x; column < x + w; column++)
      over(frame + ((uint64_t)row * width + column) * 4, rgba, alpha);
  return 1;
}

int compose_stamp(uint32_t ptr, uint32_t width, uint32_t height, uint32_t source, uint32_t sw, uint32_t sh, uint32_t stride, uint32_t kind, int32_t x, int32_t y, uint32_t cx, uint32_t cy, uint32_t cw, uint32_t ch, uint32_t tint, uint32_t opacity) {
  uint32_t bpp = kind == 1 ? 1 : 4;
  uint64_t rowbytes = (uint64_t)sw * bpp;
  uint64_t bytes = sh ? (uint64_t)(sh - 1) * stride + rowbytes : 0;
  if (!frame_valid(ptr, width, height) || !sw || !sh || (kind != 1 && kind != 4) || stride < rowbytes || !range(source, bytes) || opacity > 65535u || !rect_valid(width, height, cx, cy, cw, ch)) return 0;
  if ((uint64_t)source < (uint64_t)ptr + (uint64_t)width * height * 4u && (uint64_t)source + bytes > ptr) return 0;
  int64_t left = x > (int64_t)cx ? x : cx;
  int64_t top = y > (int64_t)cy ? y : cy;
  int64_t right = (int64_t)x + sw < (int64_t)cx + cw ? (int64_t)x + sw : (int64_t)cx + cw;
  int64_t bottom = (int64_t)y + sh < (int64_t)cy + ch ? (int64_t)y + sh : (int64_t)cy + ch;
  unsigned char *frame = (unsigned char *)(uintptr_t)ptr;
  unsigned char *pixels = (unsigned char *)(uintptr_t)source;
  for (int64_t row = top; row < bottom; row++) {
    for (int64_t column = left; column < right; column++) {
      unsigned char *pixel = pixels + (row - y) * stride + (column - x) * bpp;
      uint32_t rgba = kind == 1 ? tint : read_pixel(pixel);
      uint64_t numerator = (uint64_t)(rgba >> 24) * opacity;
      uint32_t denominator = 65535u;
      if (kind == 1) { numerator *= pixel[0]; denominator *= 255u; }
      uint32_t alpha = (numerator + denominator / 2) / denominator;
      over(frame + ((uint64_t)row * width + column) * 4, rgba, alpha);
    }
  }
  return 1;
}

int compose_move(uint32_t ptr, uint32_t width, uint32_t height, uint32_t source_y, uint32_t target_y, uint32_t rows) {
  if (!frame_valid(ptr, width, height) || source_y > height || target_y > height || rows > height - source_y || rows > height - target_y) return 0;
  uint32_t bytes = rows * width * 4u;
  unsigned char *frame = (unsigned char *)(uintptr_t)ptr;
  unsigned char *source = frame + source_y * width * 4u;
  unsigned char *target = frame + target_y * width * 4u;
  if (target < source) for (uint32_t i = 0; i < bytes; i++) target[i] = source[i];
  if (target > source) for (uint32_t i = bytes; i > 0; i--) target[i - 1] = source[i - 1];
  return 1;
}
