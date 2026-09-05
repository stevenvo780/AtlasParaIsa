/** A bounded texture compositor. CPU art is uploaded only when a chunk changes. */
export type GpuStatus = 'hardware' | 'software' | 'unverified' | 'unavailable' | 'context-lost';
export interface TerrainRaster { key: string; revision: number; canvas: HTMLCanvasElement; x: number; y: number; }
export interface TerrainCamera { x: number; y: number; zoom: number; width: number; height: number; dpr: number; }

export class BoundedCache<T> {
  private readonly values = new Map<string, T>();
  constructor(readonly capacity: number, private readonly release: (value: T, key: string) => void) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Cache capacity must be a positive integer');
  }
  get size(): number { return this.values.size; }
  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value !== undefined) { this.values.delete(key); this.values.set(key, value); }
    return value;
  }
  set(key: string, value: T): void {
    const old = this.values.get(key);
    if (old !== undefined && old !== value) this.release(old, key);
    this.values.delete(key); this.values.set(key, value);
    while (this.values.size > this.capacity) {
      const oldest = this.values.entries().next().value!;
      this.values.delete(oldest[0]); this.release(oldest[1], oldest[0]);
    }
  }
  clear(): void { for (const [key, value] of this.values) this.release(value, key); this.values.clear(); }
}

export function classifyRenderer(label: string): GpuStatus {
  if (/swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(label)) return 'software';
  if (/nvidia|radeon|amd|intel|apple|adreno|mali|powervr|vivante|videocore|tegra/i.test(label)) return 'hardware';
  return 'unverified';
}

export class GpuTerrain {
  readonly canvas = document.createElement('canvas');
  status: GpuStatus = 'unavailable';
  label = '';
  drawCalls = 0;
  uploads = 0;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private rect: WebGLUniformLocation | null = null;
  private viewport: WebGLUniformLocation | null = null;
  private destroyed = false;
  private readonly textures = new Map<string, { texture: WebGLTexture; revision: number }>();
  private readonly lost = (event: Event): void => {
    event.preventDefault(); this.status = 'context-lost'; this.program = null; this.buffer = null;
    this.textures.clear(); this.canvas.style.visibility = 'hidden';
  };
  private readonly restored = (): void => { if (!this.destroyed) this.initialize(); };

  constructor(overlay: HTMLCanvasElement, private readonly allowSoftware = false) {
    this.canvas.dataset.renderer = 'webgl2-terrain';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;image-rendering:pixelated;visibility:hidden';
    overlay.before(this.canvas);
    this.canvas.addEventListener('webglcontextlost', this.lost);
    this.canvas.addEventListener('webglcontextrestored', this.restored);
    try { this.gl = this.canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' }); this.initialize(); }
    catch { this.status = 'unavailable'; }
  }

  get active(): boolean { return this.program !== null && this.status !== 'context-lost'; }
  get textureCount(): number { return this.textures.size; }

  private initialize(): void {
    const gl = this.gl;
    if (!gl) return;
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    this.label = extension ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : '';
    this.status = classifyRenderer(this.label);
    // Software WebGL adds a compositor with no physical GPU benefit. Keep the cached 2D route.
    if (this.status === 'software' && !this.allowSoftware) return;
    const program = gl.createProgram();
    if (!program) { this.status = 'unavailable'; return; }
    const sources = [
      [gl.VERTEX_SHADER, '#version 300 es\nin vec2 position; uniform vec4 rect; uniform vec2 viewport; out vec2 uv; void main(){uv=position;vec2 p=rect.xy+position*rect.zw;gl_Position=vec4(p.x/viewport.x*2.-1.,1.-p.y/viewport.y*2.,0.,1.);}'],
      [gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float; in vec2 uv; uniform sampler2D terrain; out vec4 color; void main(){color=texture(terrain,uv);}'],
    ] as const;
    for (const [kind, source] of sources) {
      const shader = gl.createShader(kind);
      if (!shader) { gl.deleteProgram(program); this.status = 'unavailable'; return; }
      gl.shaderSource(shader, source); gl.compileShader(shader); gl.attachShader(program, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); this.status = 'unavailable'; return; }
    const buffer = gl.createBuffer();
    if (!buffer) { gl.deleteProgram(program); this.status = 'unavailable'; return; }
    this.program = program; this.buffer = buffer;
    gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.rect = gl.getUniformLocation(program, 'rect'); this.viewport = gl.getUniformLocation(program, 'viewport');
    gl.uniform1i(gl.getUniformLocation(program, 'terrain'), 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.canvas.style.visibility = 'visible';
  }

  drop(key: string): void {
    const item = this.textures.get(key);
    if (item) { this.gl?.deleteTexture(item.texture); this.textures.delete(key); }
  }

  render(chunks: readonly TerrainRaster[], camera: TerrainCamera): boolean {
    this.drawCalls = 0;
    if (!this.active || !this.gl) return false;
    const gl = this.gl;
    const width = Math.round(camera.width * camera.dpr), height = Math.round(camera.height * camera.dpr);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    gl.viewport(0, 0, width, height); gl.clearColor(66/255,95/255,80/255,1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program); gl.uniform2f(this.viewport, width, height);
    for (const chunk of chunks) {
      const x = Math.round((camera.width/2 + (chunk.x-camera.x)*camera.zoom)*camera.dpr);
      const y = Math.round((camera.height/2 + (chunk.y-camera.y)*camera.zoom)*camera.dpr);
      const endX = Math.round((camera.width/2 + (chunk.x+chunk.canvas.width/16-camera.x)*camera.zoom)*camera.dpr);
      const endY = Math.round((camera.height/2 + (chunk.y+chunk.canvas.height/16-camera.y)*camera.zoom)*camera.dpr);
      if (endX < 0 || endY < 0 || x > width || y > height) continue;
      let item = this.textures.get(chunk.key);
      if (!item) {
        const texture = gl.createTexture();
        if (!texture) { this.status = 'unavailable'; this.program = null; this.canvas.style.visibility = 'hidden'; return false; }
        item = { texture, revision: -1 }; this.textures.set(chunk.key, item);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else gl.bindTexture(gl.TEXTURE_2D, item.texture);
      if (item.revision !== chunk.revision) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, chunk.canvas);
        item.revision = chunk.revision; this.uploads++;
      }
      gl.uniform4f(this.rect, x, y, endX-x, endY-y); gl.drawArrays(gl.TRIANGLES, 0, 6); this.drawCalls++;
    }
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.canvas.removeEventListener('webglcontextlost', this.lost); this.canvas.removeEventListener('webglcontextrestored', this.restored);
    for (const key of this.textures.keys()) this.drop(key);
    this.gl?.deleteBuffer(this.buffer); this.gl?.deleteProgram(this.program);
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext(); this.gl = null; this.program = null;
    this.canvas.width = this.canvas.height = 0; this.canvas.remove();
  }
}
