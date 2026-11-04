import type { Scene, Source, Transform, TransitionSettings, VideoFilter } from '@shared/types';
import { hexToRgba } from '@shared/util';
import { itemBox, itemUv } from '@shared/transform';
import {
  BLUR_FS,
  CHROMA_KEY_FS,
  COLOR_CORRECTION_FS,
  COLOR_KEY_FS,
  DRAW_FS,
  FULL_VS,
  LUT_FS,
  MASK_FS,
  PIXELATE_FS,
  QUAD_VS,
  RESAMPLE_FS,
  SCROLL_FS,
  SHARPEN_FS,
  TRANSITION_FS,
  YUV_PACK_FS,
} from './shaders';
import { RenderTarget, createProgram, createTexture, mul, rotate, scale, translate, type Program, type TexInfo } from './glUtil';

export interface SourceRuntimeLike {
  width: number;
  height: number;
  sceneId?: string;
  texture(g: Gfx): TexInfo | null;
}

export interface RenderWorld {
  getScene(id: string): Scene | undefined;
  getSource(id: string): Source | undefined;
  getRuntime(id: string): SourceRuntimeLike | undefined;
  /** Resolve an image path (mask / LUT) to a loadable URL */
  mediaUrl(path: string): string;
  now: number;
}

export interface TransitionState {
  from: string;
  to: string;
  start: number;
  settings: TransitionSettings;
  /** Stinger video (if any) */
  stinger?: SourceRuntimeLike | null;
  durationMs: number;
}

/** GL context plus helpers that source runtimes use to upload their content. */
export class Gfx {
  readonly gl: WebGL2RenderingContext;
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  newTexture(): TexInfo {
    return { tex: createTexture(this.gl), width: 0, height: 0, bgra: false, version: 0, mipsVersion: -1 };
  }

  /** Upload a DOM image / video / canvas / ImageBitmap (premultiplying alpha on upload). */
  uploadElement(t: TexInfo, el: TexImageSource, width: number, height: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    if (t.width !== width || t.height !== height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, el);
      t.width = width;
      t.height = height;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, el);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    t.bgra = false;
    t.version++;
  }

  /** Upload raw premultiplied BGRA pixels (browser sources), optionally only a sub-rectangle. */
  uploadBgra(t: TexInfo, fullW: number, fullH: number, x: number, y: number, w: number, h: number, data: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    if (t.width !== fullW || t.height !== fullH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, fullW, fullH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      t.width = fullW;
      t.height = fullH;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    t.bgra = true;
    t.version++;
  }

  uploadSolid(t: TexInfo, rgba: [number, number, number, number]): void {
    const gl = this.gl;
    const a = rgba[3];
    const px = new Uint8Array([Math.round(rgba[0] * a * 255), Math.round(rgba[1] * a * 255), Math.round(rgba[2] * a * 255), Math.round(a * 255)]);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    t.width = 1;
    t.height = 1;
    t.bgra = false;
    t.version++;
  }

  deleteTexture(t: TexInfo | null | undefined): void {
    if (t) this.gl.deleteTexture(t.tex);
  }
}

interface FilterResources {
  a: RenderTarget;
  b: RenderTarget;
  masks: Map<string, { url: string; tex: TexInfo | null; loading: boolean }>;
  luts: Map<string, { url: string; tex: WebGLTexture | null; size: number; loading: boolean }>;
  lastUsed: number;
}

interface PendingRead {
  pbo: WebGLBuffer;
  sync: WebGLSync | null;
  tsUs: number;
  busy: boolean;
  issuedAt: number;
}

const TRANSITION_TYPE: Record<string, number> = { fade: 0, fade_color: 1, slide: 2, swipe: 3, zoom: 4, luma_wipe: 5 };
const LUMA_PATTERN: Record<string, number> = { linear_h: 0, linear_v: 1, radial: 2, clock: 3, diamond: 4, blinds: 5 };
const MASK_MODE: Record<string, number> = { alpha_mask_alpha: 0, alpha_mask_color: 1, blend_multiply: 2, blend_add: 3, blend_subtract: 4 };

export class Compositor {
  readonly canvas: OffscreenCanvas;
  readonly gl: WebGL2RenderingContext;
  readonly gfx: Gfx;
  private vao: WebGLVertexArrayObject;
  private p: Record<string, Program> = {};
  baseW: number;
  baseH: number;
  readonly program: RenderTarget;
  readonly preview: RenderTarget;
  private transA: RenderTarget;
  private transB: RenderTarget;
  private sceneTargets = new Map<string, RenderTarget>();
  private filterRes = new Map<string, FilterResources>();
  private out: RenderTarget | null = null;
  private outMid: RenderTarget | null = null;
  private yuv: RenderTarget | null = null;
  private reads: PendingRead[] = [];
  private readBuffer: Uint8Array | null = null;
  outW = 0;
  outH = 0;
  scaleFilter: 'bilinear' | 'bicubic' | 'lanczos' = 'bicubic';
  contextLost = false;

  constructor(baseW: number, baseH: number) {
    this.baseW = baseW;
    this.baseH = baseH;
    this.canvas = new OffscreenCanvas(baseW, baseH);
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL 2 is not available. Update your graphics driver or enable hardware acceleration.');
    this.gl = gl;
    this.gfx = new Gfx(gl);
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    this.vao = vao;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.p.draw = createProgram(gl, QUAD_VS, DRAW_FS);
    this.p.blit = createProgram(gl, FULL_VS, DRAW_FS);
    this.p.chroma_key = createProgram(gl, FULL_VS, CHROMA_KEY_FS);
    this.p.color_key = createProgram(gl, FULL_VS, COLOR_KEY_FS);
    this.p.color_correction = createProgram(gl, FULL_VS, COLOR_CORRECTION_FS);
    this.p.blur = createProgram(gl, FULL_VS, BLUR_FS);
    this.p.sharpen = createProgram(gl, FULL_VS, SHARPEN_FS);
    this.p.pixelate = createProgram(gl, FULL_VS, PIXELATE_FS);
    this.p.scroll = createProgram(gl, FULL_VS, SCROLL_FS);
    this.p.image_mask = createProgram(gl, FULL_VS, MASK_FS);
    this.p.lut = createProgram(gl, FULL_VS, LUT_FS);
    this.p.transition = createProgram(gl, FULL_VS, TRANSITION_FS);
    this.p.resample = createProgram(gl, FULL_VS, RESAMPLE_FS);
    this.p.yuv = createProgram(gl, FULL_VS, YUV_PACK_FS);
    this.program = new RenderTarget(gl, baseW, baseH);
    this.preview = new RenderTarget(gl, baseW, baseH);
    this.transA = new RenderTarget(gl, baseW, baseH);
    this.transB = new RenderTarget(gl, baseW, baseH);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  resizeBase(w: number, h: number): void {
    this.baseW = w;
    this.baseH = h;
    this.canvas.width = w;
    this.canvas.height = h;
    for (const t of [this.program, this.preview, this.transA, this.transB, ...this.sceneTargets.values()]) t.resize(w, h);
  }

  // ---------------------------------------------------------------------------
  // Drawing primitives
  // ---------------------------------------------------------------------------

  private use(name: string): Program {
    const prog = this.p[name];
    this.gl.useProgram(prog.program);
    this.gl.bindVertexArray(this.vao);
    return prog;
  }

  private bindTex(unit: number, t: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
  }

  private ensureMips(t: TexInfo) {
    if (t.mipsVersion === t.version) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    t.mipsVersion = t.version;
  }

  private noMips(t: TexInfo) {
    if (t.mipsVersion === -2) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    t.mipsVersion = -2;
  }

  /** Draw a texture as a scene item into the currently bound target (size tw x th). */
  private drawItem(t: TexInfo, natW: number, natH: number, tr: Transform, tw: number, th: number, opacity = 1) {
    const gl = this.gl;
    const b = itemBox(tr, natW, natH);
    if (b.w <= 0 || b.h <= 0) return;
    // unit quad -> item box (pixels) -> rotate around centre -> canvas -> clip (row 0 = top)
    let m = scale(b.w, b.h);
    m = mul(translate(-b.w / 2, -b.h / 2), m);
    m = mul(rotate((tr.rotation * Math.PI) / 180), m);
    m = mul(translate(tr.x + b.w / 2, tr.y + b.h / 2), m);
    m = mul(scale(2 / tw, 2 / th), m);
    m = mul(translate(-1, -1), m);
    // Downscaled content looks much better with mipmaps.
    const texelScale = Math.min(b.w / Math.max(1, b.cw * (t.width / Math.max(1, natW))), b.h / Math.max(1, b.ch * (t.height / Math.max(1, natH))));
    if (texelScale < 0.6 && t.width > 1 && t.height > 1) this.ensureMips(t);
    else if (t.mipsVersion !== -2 && t.mipsVersion !== -1) this.noMips(t);
    const prog = this.use('draw');
    gl.uniformMatrix3fv(prog.u.u_matrix, false, m);
    gl.uniform4fv(prog.u.u_uv, itemUv(tr, natW, natH));
    gl.uniform1f(prog.u.u_opacity, opacity);
    gl.uniform1i(prog.u.u_bgra, t.bgra ? 1 : 0);
    gl.uniform1i(prog.u.u_useSolid, 0);
    gl.uniform1i(prog.u.u_tex, 0);
    this.bindTex(0, t.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Draw a texture over the whole currently bound target. */
  private blit(t: TexInfo, flipY: boolean, opacity = 1) {
    const gl = this.gl;
    const prog = this.use('blit');
    gl.uniform1f(prog.u.u_flipY, flipY ? 1 : 0);
    gl.uniform1f(prog.u.u_opacity, opacity);
    gl.uniform1i(prog.u.u_bgra, t.bgra ? 1 : 0);
    gl.uniform1i(prog.u.u_useSolid, 0);
    gl.uniform1i(prog.u.u_tex, 0);
    this.bindTex(0, t.tex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---------------------------------------------------------------------------
  // Scenes
  // ---------------------------------------------------------------------------

  /** Render a scene into a target (cleared to transparent unless `background` is given). */
  renderScene(sceneId: string, target: RenderTarget, world: RenderWorld, background: [number, number, number, number] = [0, 0, 0, 0], depth = 0, stack: string[] = []): void {
    target.bind(true, background);
    const scene = world.getScene(sceneId);
    if (!scene || depth > 8 || stack.includes(sceneId)) return;
    const nextStack = [...stack, sceneId];
    for (const item of scene.items) {
      if (!item.visible) continue;
      const src = world.getSource(item.sourceId);
      const rt = world.getRuntime(item.sourceId);
      if (!src || !rt) continue;
      let tex: TexInfo | null;
      let natW = rt.width;
      let natH = rt.height;
      if (src.type === 'scene' && rt.sceneId) {
        if (nextStack.includes(rt.sceneId)) continue;
        let st = this.sceneTargets.get(src.id);
        if (!st) {
          st = new RenderTarget(this.gl, this.baseW, this.baseH);
          this.sceneTargets.set(src.id, st);
        }
        this.renderScene(rt.sceneId, st, world, [0, 0, 0, 0], depth + 1, nextStack);
        tex = st.info;
        natW = this.baseW;
        natH = this.baseH;
      } else {
        tex = rt.texture(this.gfx);
      }
      if (!tex || natW <= 0 || natH <= 0 || tex.width <= 0) continue;
      const filtered = this.applyFilters(src, tex, world);
      target.bind(false);
      this.drawItem(filtered, natW, natH, item.transform, target.width, target.height);
    }
  }

  /** Render the program output, handling an in-progress transition. Returns true while transitioning. */
  renderProgram(sceneId: string, world: RenderWorld, transition: TransitionState | null): boolean {
    const black: [number, number, number, number] = [0, 0, 0, 1];
    if (!transition) {
      this.renderScene(sceneId, this.program, world, black);
      return false;
    }
    const elapsed = world.now - transition.start;
    const dur = Math.max(1, transition.durationMs);
    const raw = Math.min(1, elapsed / dur);
    const s = transition.settings;
    if (s.type === 'stinger') {
      const point = Math.min(dur, Math.max(0, s.stingerPointMs));
      this.renderScene(elapsed < point ? transition.from : transition.to, this.program, world, black);
      const st = transition.stinger?.texture(this.gfx);
      if (st && st.width > 0) {
        this.program.bind(false);
        this.blit(st, false);
      }
      return raw < 1;
    }
    this.renderScene(transition.from, this.transA, world, black);
    this.renderScene(transition.to, this.transB, world, black);
    const p = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2; // ease in-out
    this.program.bind(true, black);
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const prog = this.use('transition');
    gl.uniform1f(prog.u.u_flipY, 0);
    gl.uniform1i(prog.u.u_a, 0);
    gl.uniform1i(prog.u.u_b, 1);
    this.bindTex(0, this.transA.info.tex);
    this.bindTex(1, this.transB.info.tex);
    gl.uniform1f(prog.u.u_p, s.type === 'cut' ? 1 : p);
    gl.uniform1i(prog.u.u_type, TRANSITION_TYPE[s.type] ?? 0);
    const dirs: Record<string, [number, number]> = { left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1] };
    gl.uniform2fv(prog.u.u_dir, dirs[s.direction] ?? [1, 0]);
    gl.uniform4fv(prog.u.u_color, hexToRgba(s.color));
    gl.uniform1i(prog.u.u_pattern, LUMA_PATTERN[s.lumaPattern] ?? 0);
    gl.uniform1f(prog.u.u_softness, Math.max(0.001, s.softness));
    gl.uniform1i(prog.u.u_invert, s.invert ? 1 : 0);
    gl.uniform1f(prog.u.u_aspect, this.baseW / this.baseH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.enable(gl.BLEND);
    this.bindTex(1, this.transB.info.tex);
    gl.activeTexture(gl.TEXTURE0);
    return raw < 1;
  }

  renderPreview(sceneId: string, world: RenderWorld): void {
    this.renderScene(sceneId, this.preview, world, [0, 0, 0, 1]);
  }

  /** Drop per-source GPU resources for sources that no longer exist. */
  gc(liveSourceIds: Set<string>): void {
    for (const [id, t] of this.sceneTargets) {
      if (!liveSourceIds.has(id)) {
        t.dispose();
        this.sceneTargets.delete(id);
      }
    }
    for (const [id, r] of this.filterRes) {
      if (!liveSourceIds.has(id)) this.disposeFilterRes(id, r);
    }
  }

  private disposeFilterRes(id: string, r: FilterResources) {
    r.a.dispose();
    r.b.dispose();
    for (const m of r.masks.values()) if (m.tex) this.gl.deleteTexture(m.tex.tex);
    for (const l of r.luts.values()) if (l.tex) this.gl.deleteTexture(l.tex);
    this.filterRes.delete(id);
  }

  // ---------------------------------------------------------------------------
  // Filters
  // ---------------------------------------------------------------------------

  private applyFilters(src: Source, input: TexInfo, world: RenderWorld): TexInfo {
    const filters = src.filters.filter((f) => f.enabled);
    if (!filters.length) {
      const r = this.filterRes.get(src.id);
      if (r) this.disposeFilterRes(src.id, r);
      return input;
    }
    const gl = this.gl;
    const w = input.width;
    const h = input.height;
    let res = this.filterRes.get(src.id);
    if (!res) {
      res = { a: new RenderTarget(gl, w, h), b: new RenderTarget(gl, w, h), masks: new Map(), luts: new Map(), lastUsed: 0 };
      this.filterRes.set(src.id, res);
    }
    res.a.resize(w, h);
    res.b.resize(w, h);
    res.lastUsed = world.now;
    let cur = input;
    let flip = false;
    gl.disable(gl.BLEND);
    for (const f of filters) {
      const passes = this.filterPasses(f, cur, res, world);
      for (const pass of passes) {
        const target = flip ? res.b : res.a;
        flip = !flip;
        target.bind(true);
        pass(cur, target);
        cur = target.info;
      }
    }
    gl.enable(gl.BLEND);
    return cur;
  }

  /** Each pass draws `input` into the bound `target`. */
  private filterPasses(f: VideoFilter, input: TexInfo, res: FilterResources, world: RenderWorld): ((input: TexInfo, target: RenderTarget) => void)[] {
    const gl = this.gl;
    const s = f.settings;
    const num = (k: string, d = 0) => (typeof s[k] === 'number' ? (s[k] as number) : d);
    const str = (k: string, d = '') => (typeof s[k] === 'string' ? (s[k] as string) : d);
    const setup = (name: string, inp: TexInfo) => {
      const prog = this.use(name);
      gl.uniform1f(prog.u.u_flipY, 0);
      gl.uniform1i(prog.u.u_tex, 0);
      this.bindTex(0, inp.tex);
      return prog;
    };
    // Browser source textures are BGRA: normalise them first with a plain copy.
    const normalise = input.bgra
      ? [
          (inp: TexInfo) => {
            this.blit(inp, false);
          },
        ]
      : [];
    const draw = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    switch (f.type) {
      case 'chroma_key':
        return [
          ...normalise,
          (inp) => {
            const p = setup('chroma_key', inp);
            gl.uniform2f(p.u.u_texel, 1 / inp.width, 1 / inp.height);
            gl.uniform3fv(p.u.u_key, hexToRgba(str('keyColor', '#00ff00')).slice(0, 3));
            gl.uniform1f(p.u.u_similarity, num('similarity', 400) / 1000);
            gl.uniform1f(p.u.u_smoothness, num('smoothness', 80) / 1000);
            gl.uniform1f(p.u.u_spill, num('spill', 100) / 1000);
            gl.uniform1f(p.u.u_opacity, num('opacity', 100) / 100);
            gl.uniform1f(p.u.u_contrast, num('contrast', 0));
            gl.uniform1f(p.u.u_brightness, num('brightness', 0));
            gl.uniform1f(p.u.u_gamma, num('gamma', 0));
            draw();
          },
        ];
      case 'color_key':
        return [
          ...normalise,
          (inp) => {
            const p = setup('color_key', inp);
            gl.uniform3fv(p.u.u_key, hexToRgba(str('keyColor', '#00ff00')).slice(0, 3));
            gl.uniform1f(p.u.u_similarity, num('similarity', 80) / 1000);
            gl.uniform1f(p.u.u_smoothness, num('smoothness', 50) / 1000);
            gl.uniform1f(p.u.u_opacity, num('opacity', 100) / 100);
            draw();
          },
        ];
      case 'color_correction':
        return [
          ...normalise,
          (inp) => {
            const p = setup('color_correction', inp);
            gl.uniform1f(p.u.u_gamma, num('gamma'));
            gl.uniform1f(p.u.u_contrast, num('contrast'));
            gl.uniform1f(p.u.u_brightness, num('brightness'));
            gl.uniform1f(p.u.u_saturation, num('saturation'));
            gl.uniform1f(p.u.u_hue, (num('hue') * Math.PI) / 180);
            gl.uniform1f(p.u.u_opacity, num('opacity', 100) / 100);
            gl.uniform3fv(p.u.u_mul, hexToRgba(str('colorMultiply', '#ffffff')).slice(0, 3));
            gl.uniform3fv(p.u.u_add, hexToRgba(str('colorAdd', '#000000')).slice(0, 3));
            draw();
          },
        ];
      case 'blur': {
        const r = Math.max(0, Math.min(48, num('radius', 8)));
        if (r < 0.5) return normalise;
        const pass = (dx: number, dy: number) => (inp: TexInfo) => {
          const p = setup('blur', inp);
          gl.uniform2f(p.u.u_dir, dx / inp.width, dy / inp.height);
          gl.uniform1f(p.u.u_radius, r);
          draw();
        };
        return [...normalise, pass(1, 0), pass(0, 1)];
      }
      case 'sharpen':
        return [
          ...normalise,
          (inp) => {
            const p = setup('sharpen', inp);
            gl.uniform2f(p.u.u_texel, 1 / inp.width, 1 / inp.height);
            gl.uniform1f(p.u.u_amount, Math.max(0, Math.min(1, num('amount', 0.08))));
            draw();
          },
        ];
      case 'pixelate':
        return [
          ...normalise,
          (inp) => {
            const p = setup('pixelate', inp);
            gl.uniform2f(p.u.u_size, inp.width, inp.height);
            gl.uniform1f(p.u.u_block, Math.max(1, num('size', 16)));
            draw();
          },
        ];
      case 'scroll':
        return [
          ...normalise,
          (inp) => {
            const p = setup('scroll', inp);
            const t = world.now / 1000;
            gl.uniform2f(p.u.u_offset, ((num('speedX', 50) * t) / inp.width) % 1, ((num('speedY', 0) * t) / inp.height) % 1);
            gl.uniform1i(p.u.u_loop, s.loop === false ? 0 : 1);
            draw();
          },
        ];
      case 'image_mask': {
        const path = str('path');
        if (!path) return normalise;
        const mask = this.loadMask(res, f.id, world.mediaUrl(path));
        if (!mask) return normalise;
        return [
          ...normalise,
          (inp) => {
            const p = setup('image_mask', inp);
            gl.uniform1i(p.u.u_mask, 1);
            this.bindTex(1, mask.tex);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(p.u.u_mode, MASK_MODE[str('mode', 'alpha_mask_alpha')] ?? 0);
            gl.uniform3fv(p.u.u_color, hexToRgba(str('color', '#ffffff')).slice(0, 3));
            gl.uniform1f(p.u.u_opacity, num('opacity', 100) / 100);
            draw();
          },
        ];
      }
      case 'lut': {
        const path = str('path');
        if (!path) return normalise;
        const lut = this.loadLut(res, f.id, world.mediaUrl(path));
        if (!lut) return normalise;
        return [
          ...normalise,
          (inp) => {
            const p = setup('lut', inp);
            gl.uniform1i(p.u.u_lut, 2);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_3D, lut.tex);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1f(p.u.u_size, lut.size);
            gl.uniform1f(p.u.u_amount, num('amount', 100) / 100);
            draw();
          },
        ];
      }
    }
    return normalise;
  }

  private loadMask(res: FilterResources, key: string, url: string): TexInfo | null {
    let m = res.masks.get(key);
    if (m && m.url !== url) {
      if (m.tex) this.gl.deleteTexture(m.tex.tex);
      m = undefined;
    }
    if (!m) {
      m = { url, tex: null, loading: true };
      res.masks.set(key, m);
      const entry = m;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (res.masks.get(key) !== entry) return;
        const t = this.gfx.newTexture();
        this.gfx.uploadElement(t, img, img.naturalWidth, img.naturalHeight);
        entry.tex = t;
        entry.loading = false;
      };
      img.onerror = () => {
        entry.loading = false;
      };
      img.src = url;
    }
    return m.tex;
  }

  private loadLut(res: FilterResources, key: string, url: string): { tex: WebGLTexture; size: number } | null {
    let l = res.luts.get(key);
    if (l && l.url !== url) {
      if (l.tex) this.gl.deleteTexture(l.tex);
      l = undefined;
    }
    if (!l) {
      l = { url, tex: null, size: 0, loading: true };
      res.luts.set(key, l);
      const entry = l;
      void fetch(url)
        .then((r) => r.text())
        .then((text) => {
          if (res.luts.get(key) !== entry) return;
          const parsed = parseCubeLut(text);
          const gl = this.gl;
          const tex = gl.createTexture();
          if (!tex) return;
          gl.bindTexture(gl.TEXTURE_3D, tex);
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, parsed.size, parsed.size, parsed.size, 0, gl.RGB, gl.UNSIGNED_BYTE, parsed.data);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
          entry.tex = tex;
          entry.size = parsed.size;
          entry.loading = false;
        })
        .catch(() => {
          entry.loading = false;
        });
    }
    return l.tex ? { tex: l.tex, size: l.size } : null;
  }

  // ---------------------------------------------------------------------------
  // Display
  // ---------------------------------------------------------------------------

  /** Snapshot a target as an ImageBitmap for display (zero-copy on the GPU). */
  snapshot(target: RenderTarget): ImageBitmap {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    this.blit(target.info, true);
    gl.enable(gl.BLEND);
    return this.canvas.transferToImageBitmap();
  }

  // ---------------------------------------------------------------------------
  // Output capture: scale -> I420 pack -> async readback
  // ---------------------------------------------------------------------------

  configureOutput(w: number, h: number, filter: 'bilinear' | 'bicubic' | 'lanczos'): void {
    const gl = this.gl;
    this.scaleFilter = filter;
    if (this.outW === w && this.outH === h && this.out) return;
    this.releaseOutput();
    this.outW = w;
    this.outH = h;
    this.out = new RenderTarget(gl, w, h);
    this.outMid = new RenderTarget(gl, w, this.baseH);
    this.yuv = new RenderTarget(gl, w / 4, (h * 3) / 2);
    const bytes = w * h * 1.5;
    this.readBuffer = new Uint8Array(bytes);
    for (let i = 0; i < 3; i++) {
      const pbo = gl.createBuffer();
      if (!pbo) throw new Error('createBuffer failed');
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
      this.reads.push({ pbo, sync: null, tsUs: 0, busy: false, issuedAt: 0 });
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  releaseOutput(): void {
    const gl = this.gl;
    this.out?.dispose();
    this.outMid?.dispose();
    this.yuv?.dispose();
    this.out = this.outMid = this.yuv = null;
    for (const r of this.reads) {
      if (r.sync) gl.deleteSync(r.sync);
      gl.deleteBuffer(r.pbo);
    }
    this.reads = [];
    this.readBuffer = null;
    this.outW = this.outH = 0;
  }

  /**
   * Hand every finished readback to `consume` in timestamp order. The data buffer is reused, so the
   * callback must use (copy/send) it synchronously.
   */
  collectFrames(consume: (tsUs: number, data: Uint8Array) => void, now = performance.now(), maxAgeMs = 60): number {
    const gl = this.gl;
    let n = 0;
    const busy = this.reads.filter((r) => r.busy).sort((a, b) => a.tsUs - b.tsUs);
    for (const r of busy) {
      if (!r.sync) continue;
      // Chromium refreshes fence status lazily (especially for off-screen canvases), so a readback
      // older than `maxAgeMs` is read anyway: getBufferSubData then simply waits for the GPU.
      const st = gl.clientWaitSync(r.sync, 0, 0);
      const signaled = st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED;
      if (!signaled && now - r.issuedAt < maxAgeMs) break; // keep order
      gl.deleteSync(r.sync);
      r.sync = null;
      r.busy = false;
      if (!this.readBuffer) continue;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, r.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readBuffer);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      consume(r.tsUs, this.readBuffer);
      n++;
    }
    return n;
  }

  /** Number of readbacks the GPU has not finished yet (a measure of GPU load while capturing). */
  get pendingReads(): number {
    return this.reads.filter((r) => r.busy).length;
  }

  /** Scale the program to the output size, pack it as I420 and start an async readback. */
  captureProgram(tsUs: number): boolean {
    const gl = this.gl;
    const slot = this.reads.find((r) => !r.busy);
    if (!slot || !this.out || !this.outMid || !this.yuv) return false;
    gl.disable(gl.BLEND);
    let src: TexInfo = this.program.info;
    if (this.outW !== this.baseW || this.outH !== this.baseH) {
      const f = this.scaleFilter === 'bilinear' ? 0 : this.scaleFilter === 'bicubic' ? 1 : 2;
      // horizontal: base -> (outW x baseH)
      this.outMid.bind(false);
      let prog = this.use('resample');
      gl.uniform1f(prog.u.u_flipY, 0);
      gl.uniform1i(prog.u.u_tex, 0);
      this.bindTex(0, this.program.info.tex);
      gl.uniform2f(prog.u.u_srcSize, this.baseW, this.baseH);
      gl.uniform2f(prog.u.u_axis, 1, 0);
      gl.uniform1f(prog.u.u_scale, this.baseW / this.outW);
      gl.uniform1i(prog.u.u_filter, f);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // vertical: (outW x baseH) -> (outW x outH)
      this.out.bind(false);
      prog = this.use('resample');
      this.bindTex(0, this.outMid.info.tex);
      gl.uniform2f(prog.u.u_srcSize, this.outW, this.baseH);
      gl.uniform2f(prog.u.u_axis, 0, 1);
      gl.uniform1f(prog.u.u_scale, this.baseH / this.outH);
      gl.uniform1i(prog.u.u_filter, f);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      src = this.out.info;
    }
    this.yuv.bind(false);
    const yp = this.use('yuv');
    gl.uniform1f(yp.u.u_flipY, 0);
    gl.uniform1i(yp.u.u_tex, 0);
    this.bindTex(0, src.tex);
    gl.uniform2i(yp.u.u_size, this.outW, this.outH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    gl.readPixels(0, 0, this.outW / 4, (this.outH * 3) / 2, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    slot.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    slot.tsUs = tsUs;
    slot.busy = true;
    slot.issuedAt = performance.now();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    gl.flush();
    return true;
  }

  /** PNG of the current program output (for screenshots). */
  async programPng(): Promise<Uint8Array> {
    const gl = this.gl;
    const w = this.baseW;
    const h = this.baseH;
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.program.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  }
}

/** Parse an Adobe/Resolve .cube 3D LUT into RGB8 data (red fastest). */
export function parseCubeLut(text: string): { size: number; data: Uint8Array } {
  let size = 0;
  const values: number[] = [];
  let domainMin = [0, 0, 0];
  let domainMax = [1, 1, 1];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'LUT_3D_SIZE') size = parseInt(parts[1], 10);
    else if (key === 'DOMAIN_MIN') domainMin = parts.slice(1, 4).map(Number);
    else if (key === 'DOMAIN_MAX') domainMax = parts.slice(1, 4).map(Number);
    else if (/^[-+\d.]/.test(parts[0]) && parts.length >= 3) values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (!size || size < 2 || size > 256 || values.length < size * size * size * 3) throw new Error('Not a valid 3D .cube LUT');
  const data = new Uint8Array(size * size * size * 3);
  for (let i = 0; i < data.length; i++) {
    const c = i % 3;
    const v = (values[i] - domainMin[c]) / (domainMax[c] - domainMin[c] || 1);
    data[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  return { size, data };
}
