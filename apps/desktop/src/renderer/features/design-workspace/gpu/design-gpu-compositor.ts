import type { DesignGpuTextures } from "./design-gpu-pages";

/** One batch of instanced quads: device-pixel rectangles, each with a
 * normalized source rectangle (textured) or a premultiplied color (solid). */
export interface DesignGpuBatch {
  readonly texture: WebGLTexture | null;
  /** 8 floats per quad: x, y, width, height, then u, v, du, dv or r, g, b, a. */
  readonly data: Float32Array;
  readonly count: number;
}

const VERTEX = `#version 300 es
in vec2 aCorner;
in vec4 aRect;
in vec4 aData;
uniform vec2 uViewport;
out vec4 vData;
out vec2 vCorner;
void main() {
  vec2 p = aRect.xy + aCorner * aRect.zw;
  gl_Position = vec4(p.x * 2.0 / uViewport.x - 1.0, 1.0 - p.y * 2.0 / uViewport.y, 0.0, 1.0);
  vData = aData;
  vCorner = aCorner;
}`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uPage;
uniform bool uSolid;
in vec4 vData;
in vec2 vCorner;
out vec4 color;
void main() {
  color = uSolid ? vData : texture(uPage, vData.xy + vCorner * vData.zw);
}`;

/** The plane's WebGL2 context: it uploads raster pages and draws the visible
 * composite in the camera's own paint, so pixels and DOM chrome land in the
 * same compositor frame. A lost context drops every texture; the owner
 * re-rasterizes from the worker's pictures once it is restored. */
export class DesignGpuCompositor implements DesignGpuTextures<WebGLTexture> {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private instances: WebGLBuffer | null = null;
  private corners: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: { viewport: WebGLUniformLocation | null; solid: WebGLUniformLocation | null; page: WebGLUniformLocation | null } =
    { viewport: null, solid: null, page: null };
  private capacity = 0;
  lost = false;
  losses = 0;

  constructor(readonly canvas: HTMLCanvasElement, private readonly events: { lost(): void; restored(): void }) {
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }

  /** Creates the context and program; false when WebGL2 is unavailable. */
  start(): boolean {
    const gl = this.canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false,
      stencil: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
    if (!gl) return false;
    this.gl = gl;
    return this.build();
  }

  private build(): boolean {
    const gl = this.gl!;
    const compile = (kind: number, source: string) => {
      const shader = gl.createShader(kind)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX), fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return false; }
    this.program = program;
    this.uniforms = { viewport: gl.getUniformLocation(program, "uViewport"), solid: gl.getUniformLocation(program, "uSolid"),
      page: gl.getUniformLocation(program, "uPage") };
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, "aCorner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    this.capacity = 0;
    for (const [name, offset] of [["aRect", 0], ["aData", 16]] as const) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 32, offset);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    // Pages carry premultiplied pixels, exactly as the worker drew them.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    return true;
  }

  upload(source: unknown, width: number, height: number): WebGLTexture | null {
    const gl = this.gl;
    if (!gl || this.lost) return null;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    return texture;
  }

  release(texture: WebGLTexture): void {
    if (!this.lost) this.gl?.deleteTexture(texture);
  }

  resize(width: number, height: number, cssWidth: number, cssHeight: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const style = this.canvas.style;
    if (style.width !== `${cssWidth}px`) style.width = `${cssWidth}px`;
    if (style.height !== `${cssHeight}px`) style.height = `${cssHeight}px`;
  }

  draw(batches: readonly DesignGpuBatch[]): boolean {
    const gl = this.gl;
    if (!gl || this.lost || !this.program) return false;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uniforms.viewport, this.canvas.width, this.canvas.height);
    gl.uniform1i(this.uniforms.page, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    const needed = batches.reduce((total, batch) => Math.max(total, batch.count * 32), 0);
    if (needed > this.capacity) {
      this.capacity = Math.max(needed, this.capacity * 2, 32 * 1024);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
    }
    for (const batch of batches) {
      if (!batch.count) continue;
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.data, 0, batch.count * 8);
      gl.uniform1i(this.uniforms.solid, batch.texture ? 0 : 1);
      if (batch.texture) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, batch.texture); }
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
    }
    gl.bindVertexArray(null);
    return true;
  }

  /** Test and bench hook: loses and restores the context like a GPU reset. */
  loseContext(): void {
    const extension = this.gl?.getExtension("WEBGL_lose_context");
    extension?.loseContext();
    setTimeout(() => extension?.restoreContext(), 0);
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    const gl = this.gl;
    if (gl && !this.lost) {
      gl.deleteBuffer(this.instances);
      gl.deleteBuffer(this.corners);
      gl.deleteVertexArray(this.vao);
      gl.deleteProgram(this.program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.gl = null;
    this.program = null;
  }

  private readonly onLost = (event: Event) => {
    event.preventDefault();
    this.lost = true;
    this.losses++;
    this.program = null;
    this.events.lost();
  };

  private readonly onRestored = () => {
    this.lost = !this.build();
    if (!this.lost) this.events.restored();
  };
}
