export type Uniforms = Record<string, WebGLUniformLocation | null>;

export interface Program {
  program: WebGLProgram;
  u: Uniforms;
  aPos: number;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile error: ${info}`);
  }
  return sh;
}

export function createProgram(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const p = gl.createProgram();
  if (!p) throw new Error('createProgram failed');
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`program link error: ${gl.getProgramInfoLog(p)}`);
  gl.deleteShader(v);
  gl.deleteShader(f);
  const u: Uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    if (info) u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { program: p, u, aPos: 0 };
}

/** Texture handle plus metadata. Contents are premultiplied RGBA with v=0 at the top. */
export interface TexInfo {
  tex: WebGLTexture;
  width: number;
  height: number;
  /** Data was uploaded as BGRA bytes (browser sources) and must be swizzled when sampled. */
  bgra: boolean;
  /** Incremented whenever the content changes. */
  version: number;
  mipsVersion: number;
}

export function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture();
  if (!t) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export class RenderTarget {
  readonly fbo: WebGLFramebuffer;
  readonly info: TexInfo;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    public width: number,
    public height: number,
  ) {
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('createFramebuffer failed');
    this.fbo = fbo;
    const tex = createTexture(gl);
    this.info = { tex, width, height, bgra: false, version: 0, mipsVersion: -1 };
    this.allocate();
  }

  private allocate() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.info.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.info.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.info.width = this.width;
    this.info.height = this.height;
    this.info.mipsVersion = -1;
  }

  resize(w: number, h: number) {
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    if (W === this.width && H === this.height) return;
    this.width = W;
    this.height = H;
    // Storage must be re-created (mip levels from a previous size would be inconsistent).
    const gl = this.gl;
    gl.deleteTexture(this.info.tex);
    this.info.tex = createTexture(gl);
    this.allocate();
  }

  bind(clear = true, color: [number, number, number, number] = [0, 0, 0, 0]) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    if (clear) {
      gl.clearColor(color[0], color[1], color[2], color[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.info.version++;
  }

  dispose() {
    this.gl.deleteFramebuffer(this.fbo);
    this.gl.deleteTexture(this.info.tex);
  }
}

/** 3x3 matrix helpers (column-major for WebGL). */
export type Mat3 = Float32Array;

export function mat3(): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

export function mul(a: Mat3, b: Mat3): Mat3 {
  const o = new Float32Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      o[c * 3 + r] = a[0 * 3 + r] * b[c * 3 + 0] + a[1 * 3 + r] * b[c * 3 + 1] + a[2 * 3 + r] * b[c * 3 + 2];
    }
  }
  return o;
}

export function translate(x: number, y: number): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, x, y, 1]);
}

export function scale(x: number, y: number): Mat3 {
  return new Float32Array([x, 0, 0, 0, y, 0, 0, 0, 1]);
}

export function rotate(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1]);
}
