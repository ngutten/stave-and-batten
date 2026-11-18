// Small WebGL2 helpers. No framework.

export function program(gl, vsSrc, fsSrc, name = 'program') {
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) || '';
      const m = /\d+:(\d+)/.exec(log); let ctx = '';
      if (m) { const ln = +m[1], lines = src.split('\n'); ctx = '\n' + lines.slice(Math.max(0, ln - 3), ln + 2).map((l, i) => `${Math.max(1, ln - 2) + i}: ${l}`).join('\n'); }
      throw new Error(`${name} ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader: ${log}${ctx}`);
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} link: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const nm = info.name.replace(/\[0\]$/, ''); uniforms[nm] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size }; }
  const attribs = {}, na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); attribs[info.name] = gl.getAttribLocation(p, info.name); }
  return { p, uniforms, attribs, name };
}

// set uniforms from a plain object; textures are {tex, target?} or WebGLTexture and get units in order
export function use(gl, prog, values = {}) {
  gl.useProgram(prog.p);
  let unit = 0;
  for (const k in prog.uniforms) {
    const u = prog.uniforms[k], v = values[k];
    if (v === undefined) continue;
    switch (u.type) {
      case gl.FLOAT: if (u.size > 1 || v.length) gl.uniform1fv(u.loc, v); else gl.uniform1f(u.loc, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, v); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
      case gl.SAMPLER_2D: case gl.SAMPLER_2D_SHADOW: case gl.SAMPLER_CUBE: {
        const target = u.type === gl.SAMPLER_CUBE ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, v.tex || v); gl.uniform1i(u.loc, unit); unit++; break;
      }
      default: throw new Error(`uniform ${k}: unhandled type ${u.type}`);
    }
  }
}

export function texture(gl, w, h, { internal = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE, filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE, data = null, mips = false } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  return { tex, w, h, internal, format, type };
}

export function target(gl, w, h, specs, depth = false) {
  const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const tex = specs.map((s, i) => { const t = texture(gl, w, h, s); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.tex, 0); return t; });
  let depthTex = null;
  if (depth) {
    depthTex = texture(gl, w, h, { internal: gl.DEPTH_COMPONENT24, format: gl.DEPTH_COMPONENT, type: gl.UNSIGNED_INT, filter: gl.NEAREST });
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex.tex, 0);
  }
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete: 0x' + st.toString(16));
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, depthTex, w, h, n: specs.length };
}

export function bindTarget(gl, t) {
  if (!t) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); return; }
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.viewport(0, 0, t.w, t.h);
  const bufs = []; for (let i = 0; i < t.n; i++) bufs.push(gl.COLOR_ATTACHMENT0 + i);
  gl.drawBuffers(bufs.length ? bufs : [gl.NONE]);
}

export function freeTarget(gl, t) { if (!t) return; for (const x of t.tex) gl.deleteTexture(x.tex); if (t.depthTex) gl.deleteTexture(t.depthTex.tex); gl.deleteFramebuffer(t.fbo); }

// attrs: { name: {data: Float32Array, size} }, bound by explicit location map
export function vao(gl, locs, attrs, idx) {
  const v = gl.createVertexArray(); gl.bindVertexArray(v);
  const bufs = [];
  for (const name in attrs) {
    if (!(name in locs)) continue;
    const b = gl.createBuffer(); bufs.push(b);
    gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, attrs[name].data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(locs[name]); gl.vertexAttribPointer(locs[name], attrs[name].size, gl.FLOAT, false, 0, 0);
    if (attrs[name].divisor) gl.vertexAttribDivisor(locs[name], attrs[name].divisor);
  }
  let count = 0;
  if (idx) { const b = gl.createBuffer(); bufs.push(b); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW); count = idx.length; }
  gl.bindVertexArray(null);
  return { v, bufs, count, free() { gl.deleteVertexArray(v); for (const b of bufs) gl.deleteBuffer(b); } };
}

let quadVao = null, quadGl = null;
export function drawQuad(gl) {
  if (quadGl !== gl) { quadGl = gl; quadVao = gl.createVertexArray(); gl.bindVertexArray(quadVao); const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); }
  gl.bindVertexArray(quadVao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
}
export const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aP; out vec2 vUV; void main(){ vUV = aP*0.5+0.5; gl_Position = vec4(aP,0.,1.); }`;

// --- matrices (column-major Float32Array(16)) ---
export const M4 = {
  ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; },
  perspective(fovy, aspect, n, f) { const t = 1 / Math.tan(fovy / 2), o = new Float32Array(16); o[0] = t / aspect; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f); return o; },
  ortho(l, r, b, t, n, f) { const o = new Float32Array(16); o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n); o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1; return o; },
  lookAt(e, c, up) {
    const z = nrm3([e[0] - c[0], e[1] - c[1], e[2] - c[2]]), x = nrm3(crs(up, z)), y = crs(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dt(x, e), -dt(y, e), -dt(z, e), 1]);
  },
};
const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
