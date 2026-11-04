// GLSL ES 3.0 shaders. All textures hold premultiplied-alpha RGBA with v = 0 at the TOP row.

export const QUAD_VS = `#version 300 es
in vec2 a_pos;            // unit quad 0..1
uniform mat3 u_matrix;    // unit quad -> clip space
uniform vec4 u_uv;        // u0, v0, u1, v1
out vec2 v_uv;
void main() {
  vec3 p = u_matrix * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = mix(u_uv.xy, u_uv.zw, a_pos);
}`;

/** Full-target pass: a_pos 0..1 covers the whole target, uv 0..1 (top-down). */
export const FULL_VS = `#version 300 es
in vec2 a_pos;
uniform float u_flipY;    // 1.0 when drawing to the default framebuffer
out vec2 v_uv;
void main() {
  float y = mix(a_pos.y * 2.0 - 1.0, 1.0 - a_pos.y * 2.0, u_flipY);
  gl_Position = vec4(a_pos.x * 2.0 - 1.0, y, 0.0, 1.0);
  v_uv = a_pos;
}`;

export const DRAW_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform bool u_bgra;
uniform vec4 u_solid;     // used when u_useSolid
uniform bool u_useSolid;
out vec4 o;
void main() {
  if (u_useSolid) { o = u_solid * u_opacity; return; }
  vec4 c = texture(u_tex, v_uv);
  if (u_bgra) c = c.bgra;
  o = c * u_opacity;
}`;

const UNPREMUL = `
vec4 unpremul(vec4 c) { return c.a > 0.0001 ? vec4(c.rgb / c.a, c.a) : vec4(0.0); }
vec4 premul(vec4 c) { return vec4(c.rgb * c.a, c.a); }
`;

export const CHROMA_KEY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform vec3 u_key;        // key color (rgb)
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_spill;
uniform float u_opacity;
uniform float u_contrast;
uniform float u_brightness;
uniform float u_gamma;
out vec4 o;
${UNPREMUL}
vec2 rgb2cbcr(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return vec2((c.b - y) * 0.5389, (c.r - y) * 0.6350);
}
float keyDist(vec2 uv, vec2 keyCC) {
  return distance(rgb2cbcr(unpremul(texture(u_tex, uv)).rgb), keyCC);
}
void main() {
  vec4 c = unpremul(texture(u_tex, v_uv));
  vec2 keyCC = rgb2cbcr(u_key);
  // 3x3 box filter on the chroma distance reduces noise on compressed webcams
  float d = 0.0;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) d += keyDist(v_uv + vec2(x, y) * u_texel, keyCC);
  d /= 9.0;
  float base = d - u_similarity;
  float mask = pow(clamp(base / max(u_smoothness, 0.0001), 0.0, 1.0), 1.5);
  float spillVal = pow(clamp(base / max(u_spill, 0.0001), 0.0, 1.0), 1.5);
  float desat = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 rgb = mix(vec3(desat), c.rgb, spillVal);
  rgb = pow(max(rgb, vec3(0.0)), vec3(exp(-u_gamma)));
  rgb = (rgb - 0.5) * (u_contrast + 1.0) + 0.5 + u_brightness;
  o = premul(vec4(clamp(rgb, 0.0, 1.0), c.a * mask * u_opacity));
}`;

export const COLOR_KEY_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec3 u_key;
uniform float u_similarity;
uniform float u_smoothness;
uniform float u_opacity;
out vec4 o;
${UNPREMUL}
void main() {
  vec4 c = unpremul(texture(u_tex, v_uv));
  float d = distance(c.rgb, u_key);
  float mask = clamp((d - u_similarity) / max(u_smoothness, 0.0001), 0.0, 1.0);
  o = premul(vec4(c.rgb, c.a * mask * u_opacity));
}`;

export const COLOR_CORRECTION_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_gamma;
uniform float u_contrast;
uniform float u_brightness;
uniform float u_saturation;
uniform float u_hue;        // radians
uniform float u_opacity;
uniform vec3 u_mul;
uniform vec3 u_add;
out vec4 o;
${UNPREMUL}
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
void main() {
  vec4 c = unpremul(texture(u_tex, v_uv));
  vec3 rgb = pow(max(c.rgb, vec3(0.0)), vec3(exp(-u_gamma)));
  rgb = (rgb - 0.5) * (u_contrast + 1.0) + 0.5 + u_brightness;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, u_saturation + 1.0);
  rgb = hueRotate(rgb, u_hue);
  rgb = rgb * u_mul + u_add;
  o = premul(vec4(clamp(rgb, 0.0, 1.0), c.a * u_opacity));
}`;

/** Separable Gaussian blur; operates on premultiplied colours directly (correct for blur). */
export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;        // texel step along the blur direction
uniform float u_radius;
out vec4 o;
void main() {
  int r = int(min(u_radius, 48.0));
  float sigma = max(u_radius / 2.0, 0.5);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -48; i <= 48; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-float(i * i) / (2.0 * sigma * sigma));
    acc += texture(u_tex, v_uv + u_dir * float(i)) * w;
    wsum += w;
  }
  o = acc / wsum;
}`;

export const SHARPEN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
uniform float u_amount;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec4 n = texture(u_tex, v_uv + vec2(0.0, -u_texel.y)) + texture(u_tex, v_uv + vec2(0.0, u_texel.y))
         + texture(u_tex, v_uv + vec2(-u_texel.x, 0.0)) + texture(u_tex, v_uv + vec2(u_texel.x, 0.0));
  vec4 s = c * (1.0 + 4.0 * u_amount * 4.0) - n * u_amount * 4.0;
  o = vec4(clamp(s.rgb, vec3(0.0), vec3(s.a)), c.a);
}`;

export const PIXELATE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_size;      // source size in px
uniform float u_block;
out vec4 o;
void main() {
  vec2 px = floor(v_uv * u_size / u_block) * u_block + u_block * 0.5;
  o = texture(u_tex, min(px, u_size - 0.5) / u_size);
}`;

export const SCROLL_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_offset;    // in uv units
uniform bool u_loop;
out vec4 o;
void main() {
  vec2 uv = v_uv + u_offset;
  if (u_loop) uv = fract(uv);
  else if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = vec4(0.0); return; }
  o = texture(u_tex, uv);
}`;

export const MASK_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform int u_mode;        // 0 alpha(mask alpha) 1 alpha(mask luma) 2 multiply 3 add 4 subtract
uniform vec3 u_color;
uniform float u_opacity;
out vec4 o;
${UNPREMUL}
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec4 m = texture(u_mask, v_uv);
  vec4 mu = unpremul(m);
  if (u_mode == 0) { o = c * m.a * u_opacity; return; }
  if (u_mode == 1) { o = c * dot(mu.rgb, vec3(0.2126, 0.7152, 0.0722)) * m.a * u_opacity; return; }
  vec4 cu = unpremul(c);
  vec3 mc = mu.rgb * u_color;
  vec3 rgb = cu.rgb;
  if (u_mode == 2) rgb = mix(rgb, rgb * mc, m.a * u_opacity);
  else if (u_mode == 3) rgb = clamp(rgb + mc * m.a * u_opacity, 0.0, 1.0);
  else rgb = clamp(rgb - mc * m.a * u_opacity, 0.0, 1.0);
  o = premul(vec4(rgb, cu.a));
}`;

export const LUT_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler3D u_lut;
uniform float u_size;
uniform float u_amount;
out vec4 o;
${UNPREMUL}
void main() {
  vec4 c = unpremul(texture(u_tex, v_uv));
  vec3 coord = clamp(c.rgb, 0.0, 1.0) * ((u_size - 1.0) / u_size) + 0.5 / u_size;
  vec3 graded = texture(u_lut, coord).rgb;
  o = premul(vec4(mix(c.rgb, graded, u_amount), c.a));
}`;

/** Transition between two full-canvas textures. */
export const TRANSITION_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_p;        // progress 0..1 (eased)
uniform int u_type;       // 0 fade 1 fade_color 2 slide 3 swipe 4 zoom 5 luma
uniform vec2 u_dir;       // direction for slide/swipe (unit, in uv)
uniform vec4 u_color;
uniform int u_pattern;    // luma pattern
uniform float u_softness;
uniform bool u_invert;
uniform float u_aspect;
out vec4 o;
vec4 sampleOr0(sampler2D t, vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
  return texture(t, uv);
}
float lumaPattern(vec2 uv) {
  vec2 c = uv - 0.5;
  c.x *= u_aspect;
  if (u_pattern == 0) return uv.x;
  if (u_pattern == 1) return uv.y;
  if (u_pattern == 2) return clamp(length(c) / length(vec2(0.5 * u_aspect, 0.5)), 0.0, 1.0);
  if (u_pattern == 3) return fract(atan(c.x, -c.y) / 6.2831853 + 1.0);
  if (u_pattern == 4) return clamp((abs(c.x) / u_aspect + abs(c.y)), 0.0, 1.0);
  return fract(uv.x * 8.0);
}
void main() {
  float p = u_p;
  if (u_type == 0) { o = mix(texture(u_a, v_uv), texture(u_b, v_uv), p); return; }
  if (u_type == 1) {
    o = p < 0.5 ? mix(texture(u_a, v_uv), u_color, p * 2.0) : mix(u_color, texture(u_b, v_uv), (p - 0.5) * 2.0);
    return;
  }
  if (u_type == 2) {
    vec2 ua = v_uv + u_dir * p;
    vec2 ub = v_uv + u_dir * (p - 1.0);
    bool inB = ub.x >= 0.0 && ub.y >= 0.0 && ub.x <= 1.0 && ub.y <= 1.0;
    o = inB ? texture(u_b, ub) : sampleOr0(u_a, ua);
    return;
  }
  if (u_type == 3) {
    vec2 ub = v_uv + u_dir * (p - 1.0);
    bool inB = ub.x >= 0.0 && ub.y >= 0.0 && ub.x <= 1.0 && ub.y <= 1.0;
    o = inB ? texture(u_b, ub) : texture(u_a, v_uv);
    return;
  }
  if (u_type == 4) {
    float za = 1.0 + p * 0.5;
    vec4 a = texture(u_a, (v_uv - 0.5) / za + 0.5);
    float zb = 0.7 + 0.3 * p;
    vec4 b = sampleOr0(u_b, (v_uv - 0.5) / zb + 0.5);
    o = mix(a, b, smoothstep(0.0, 1.0, p));
    return;
  }
  float l = lumaPattern(v_uv);
  if (u_invert) l = 1.0 - l;
  float s = max(u_softness, 0.001);
  float t = p * (1.0 + 2.0 * s) - s;
  float m = smoothstep(l - s, l + s, t);
  o = mix(texture(u_a, v_uv), texture(u_b, v_uv), m);
}`;

/**
 * High quality separable resampler (bilinear / bicubic / Lanczos-3) used to scale the base canvas to
 * the output resolution. The kernel is widened when downscaling so it also low-pass filters.
 */
export const RESAMPLE_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_srcSize;
uniform vec2 u_axis;       // (1,0) horizontal pass, (0,1) vertical pass
uniform float u_scale;     // src/dst along the axis (>1 means downscale)
uniform int u_filter;      // 0 bilinear 1 bicubic 2 lanczos
out vec4 o;
const float PI = 3.14159265;
float cubic(float x) {
  x = abs(x);
  const float B = 0.0; const float C = 0.5; // Catmull-Rom
  if (x < 1.0) return ((12.0 - 9.0 * B - 6.0 * C) * x * x * x + (-18.0 + 12.0 * B + 6.0 * C) * x * x + (6.0 - 2.0 * B)) / 6.0;
  if (x < 2.0) return ((-B - 6.0 * C) * x * x * x + (6.0 * B + 30.0 * C) * x * x + (-12.0 * B - 48.0 * C) * x + (8.0 * B + 24.0 * C)) / 6.0;
  return 0.0;
}
float sinc(float x) { return x == 0.0 ? 1.0 : sin(PI * x) / (PI * x); }
float lanczos(float x) { x = abs(x); return x < 3.0 ? sinc(x) * sinc(x / 3.0) : 0.0; }
float tri(float x) { x = abs(x); return max(0.0, 1.0 - x); }
void main() {
  float srcLen = dot(u_srcSize, u_axis);
  float pos = dot(v_uv, u_axis) * srcLen - 0.5;       // source pixel coordinate
  float support = u_filter == 0 ? 1.0 : (u_filter == 1 ? 2.0 : 3.0);
  float stretch = max(u_scale, 1.0);
  float radius = support * stretch;
  float start = floor(pos - radius) + 1.0;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 64; i++) {
    float sp = start + float(i);
    if (sp > pos + radius) break;
    float d = (sp - pos) / stretch;
    float w = u_filter == 0 ? tri(d) : (u_filter == 1 ? cubic(d) : lanczos(d));
    if (w == 0.0) continue;
    float c = clamp(sp, 0.0, srcLen - 1.0);
    vec2 uv = v_uv;
    if (u_axis.x > 0.5) uv.x = (c + 0.5) / srcLen; else uv.y = (c + 0.5) / srcLen;
    acc += texture(u_tex, uv) * w;
    wsum += w;
  }
  vec4 r = acc / max(wsum, 1e-6);
  o = vec4(clamp(r.rgb, vec3(0.0), vec3(1.0)), clamp(r.a, 0.0, 1.0));
}`;

/**
 * Packs an RGBA frame (premultiplied over black) into planar I420 (BT.709, limited range) laid out
 * as an RGBA8 texture of size (W/4) x (H*3/2) so a single readPixels returns the exact I420 bytes.
 */
export const YUV_PACK_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_tex;
uniform ivec2 u_size;      // W, H of the source frame
out vec4 o;
vec3 rgbAt(ivec2 p) { return texelFetch(u_tex, p, 0).rgb; }
float lumaByte(vec3 c) { return 16.0 + 219.0 * dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec2 chromaBytes(vec3 c) {
  float cb = 128.0 + 224.0 * dot(c, vec3(-0.114572, -0.385428, 0.5));
  float cr = 128.0 + 224.0 * dot(c, vec3(0.5, -0.454153, -0.045847));
  return vec2(cb, cr);
}
void main() {
  int W = u_size.x;
  int H = u_size.y;
  ivec2 t = ivec2(gl_FragCoord.xy);
  int row = t.y;
  float b[4];
  if (row < H) {
    for (int k = 0; k < 4; k++) b[k] = lumaByte(rgbAt(ivec2(t.x * 4 + k, row)));
  } else {
    int r2 = row - H;
    int plane = r2 < H / 4 ? 0 : 1;      // 0 = U (Cb), 1 = V (Cr)
    int pr = plane == 0 ? r2 : r2 - H / 4;
    int cw = W / 2;
    for (int k = 0; k < 4; k++) {
      int idx = pr * W + t.x * 4 + k;    // byte index inside the chroma plane
      int cx = idx % cw;
      int cy = idx / cw;
      ivec2 p = ivec2(cx * 2, cy * 2);
      vec3 avg = (rgbAt(p) + rgbAt(p + ivec2(1, 0)) + rgbAt(p + ivec2(0, 1)) + rgbAt(p + ivec2(1, 1))) * 0.25;
      vec2 cc = chromaBytes(avg);
      b[k] = plane == 0 ? cc.x : cc.y;
    }
  }
  o = vec4(b[0], b[1], b[2], b[3]) / 255.0;
}`;
