// The far level of detail: a few flat cards with the real model photographed
// onto them. Holes are alpha, so a stove-in side is a hole in a picture, not
// two hundred triangles, and whatever lies broken on the ground is one card.
//
// Each maker lists its cards (model.proxy.cards): a flat polygon, its outward
// normal, and how far behind and in front of it the photograph reaches. Here
// each card gets a rectangle in a second, smaller atlas, and LOD0 is drawn
// into that rectangle with an orthographic camera looking straight at the
// card. Normals are re-expressed in the card's own frame, so the cards light
// like the thing they stand for.

import { program, use, target, bindTarget, freeTarget, vao, drawQuad, QUAD_VS, M4 } from './gl.js';
import { geoArrays, cross, norm, dot, sub, add, mul } from './model.js';

const CAPTURE_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec4 aTan; layout(location=3) in vec2 aUV;
uniform mat4 uVP;
out vec3 vNrm; out vec4 vTan; out vec2 vUV;
void main(){ vNrm = aNrm; vTan = aTan; vUV = aUV; gl_Position = uVP * vec4(aPos, 1.0); }`;
const CAPTURE_FS = `#version 300 es
precision highp float;
uniform sampler2D uAlbedo, uNormal, uOrm; uniform vec3 uU, uV, uN;
in vec3 vNrm; in vec4 vTan; in vec2 vUV;
layout(location=0) out vec4 oA; layout(location=1) out vec4 oN; layout(location=2) out vec4 oM;
void main(){
  vec3 nt = texture(uNormal, vUV).xyz * 2.0 - 1.0;
  vec3 Ng = normalize(vNrm), T = normalize(vTan.xyz - Ng * dot(Ng, vTan.xyz)), B = cross(Ng, T) * vTan.w;
  vec3 N = normalize(T * nt.x + B * nt.y + Ng * nt.z);
  if(!gl_FrontFacing) N = -N;
  // into the card's frame; a surface seen edge-on still has to face the viewer a little
  vec3 nc = vec3(dot(N, uU), dot(N, uV), max(dot(N, uN), 0.08));
  oA = vec4(texture(uAlbedo, vUV).rgb, 1.0);
  oN = vec4(normalize(nc) * 0.5 + 0.5, 1.0);
  oM = vec4(texture(uOrm, vUV).rgb, 1.0);
}`;
// Spread colour outward into the empty texels without touching alpha, so
// filtering and mip-mapping never pull black in round the edge of a cut-out.
// The normal map's alpha is the "has colour" flag while this runs.
const SPREAD_FS = `#version 300 es
precision highp float;
uniform sampler2D uA, uB, uC; uniform int uLast;
layout(location=0) out vec4 oA; layout(location=1) out vec4 oB; layout(location=2) out vec4 oC;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uA, p, 0), b = texelFetch(uB, p, 0), c = texelFetch(uC, p, 0);
  if(b.a < 0.5){
    vec3 sa = vec3(0.0), sb = vec3(0.0), sc = vec3(0.0); float n = 0.0;
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
      ivec2 q = p + ivec2(x, y); vec4 t = texelFetch(uB, q, 0);
      if(t.a > 0.5){ float w = (x==0||y==0) ? 2.0 : 1.0; sa += texelFetch(uA, q, 0).rgb * w; sb += t.rgb * w; sc += texelFetch(uC, q, 0).rgb * w; n += w; }
    }
    if(n > 0.0){ a.rgb = sa / n; b = vec4(sb / n, 1.0); c.rgb = sc / n; }
  }
  if(uLast == 1){ if(b.a < 0.5){ a.rgb = vec3(0.1, 0.08, 0.06); b.rgb = vec3(0.5, 0.5, 1.0); c.rgb = vec3(1.0, 1.0, 0.0); } b.a = 1.0; c.a = 1.0; }
  oA = a; oB = b; oC = c;
}`;

// The frame of a card: u to the right and v up as seen from outside, u x v = n.
function frameOf(card) {
  const n = norm(card.n);
  let u = cross([0, 1, 0], n); u = Math.hypot(...u) < 1e-4 ? [1, 0, 0] : norm(u);
  const v = cross(n, u), o = mul(card.pts.reduce((a, p) => add(a, p), [0, 0, 0]), 1 / card.pts.length);
  const poly = card.pts.map((p) => { const d = sub(p, o); return [dot(d, u), dot(d, v)]; });
  const us = poly.map((q) => q[0]), vs = poly.map((q) => q[1]);
  return { ...card, n, u, v, o, poly, u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
}

// Cards for a model, packed into a square atlas. Cheap: no GPU, no LOD0 arrays
// unless there is debris to measure.
export function planCards(model, size, G = null) {
  const px = model.proxy || { cards: [] }, cards = px.cards.map(frameOf);
  const g0 = model.lod[0], isLoose = (isl) => px.allLoose || isl.loose;
  let looseIdx = null, solidIdx = null;
  if (px.allLoose || model.islands.some((i) => i.loose)) {
    // whatever lies on the ground: one card under all of it, photographed from above
    G = G || geoArrays(model, 0);
    const idx = [], solid = []; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let t = 0; t < g0.idx.length; t += 3) {
      if (!isLoose(model.islands[g0.isl[g0.idx[t]]])) { solid.push(G.idx[t], G.idx[t + 1], G.idx[t + 2]); continue; }
      for (let k = 0; k < 3; k++) { const i = G.idx[t + k]; idx.push(i); const x = G.pos[i * 3], z = G.pos[i * 3 + 2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    }
    if (idx.length) {
      looseIdx = new Uint32Array(idx); solidIdx = new Uint32Array(solid);
      const m = 0.01, y = 0.012, top = model.lod[0].p.reduce((a, v, i) => (i % 3 === 1 ? Math.max(a, v) : a), 0);
      cards.push({ ...frameOf({ name: 'debris', n: [0, 1, 0], pts: [[x0 - m, y, z1 + m], [x1 + m, y, z1 + m], [x1 + m, y, z0 - m], [x0 - m, y, z0 - m]], in: 0.05, out: top + 0.05 }), loose: true, dens: 0.6 });
    }
  }
  // shelf-pack at the largest uniform density that fits
  const pad = 4, order = cards.slice().sort((a, b) => (b.v1 - b.v0) * (b.dens || 1) - (a.v1 - a.v0) * (a.dens || 1));
  const tryPack = (s, commit) => {
    let x = 0, y = 0, shelf = 0;
    for (const c of order) {
      const d = s * (c.dens || 1), w = Math.ceil((c.u1 - c.u0) * d) + 2 * pad, h = Math.ceil((c.v1 - c.v0) * d) + 2 * pad;
      if (w > size) return false;
      if (x + w > size) { x = 0; y += shelf; shelf = 0; }
      if (y + h > size) return false;
      if (commit) c.rect = [x + pad, y + pad, w - 2 * pad, h - 2 * pad];
      x += w; shelf = Math.max(shelf, h);
    }
    return true;
  };
  let lo = 1, hi = 1e5;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (tryPack(mid, false)) lo = mid; else hi = mid; }
  if (cards.length) tryPack(lo, true);
  // the mesh: each card a fan
  const pos = [], nrm = [], tan = [], uv = [], idx = [];
  for (const c of cards) {
    const base = pos.length / 3, [rx, ry, rw, rh] = c.rect;
    c.pts.forEach((p, i) => {
      pos.push(...p); nrm.push(...c.n); tan.push(...c.u, 1);
      uv.push((rx + ((c.poly[i][0] - c.u0) / (c.u1 - c.u0)) * rw) / size, (ry + ((c.poly[i][1] - c.v0) / (c.v1 - c.v0)) * rh) / size);
    });
    for (let i = 1; i + 1 < c.pts.length; i++) idx.push(base, base + i, base + i + 1);
  }
  const geo = { pos: new Float32Array(pos), nrm: new Float32Array(nrm), tan: new Float32Array(tan), uv: new Float32Array(uv), idx: new Uint32Array(idx), nv: pos.length / 3, ntri: idx.length / 3 };
  return { cards, geo, size, pxPerM: lo, looseIdx, solidIdx, G };
}

export function createImpostor(gl) {
  const P = { capture: program(gl, CAPTURE_VS, CAPTURE_FS, 'capture'), spread: program(gl, QUAD_VS, SPREAD_FS, 'spread') };
  const st = { size: 0, a: null, b: null, result: null };
  const specs = () => [{ internal: gl.SRGB8_ALPHA8, filter: gl.NEAREST }, { filter: gl.NEAREST }, { filter: gl.NEAREST }];

  // tex: the full-quality bake of the model { albedo, normal, orm }
  function bake(model, tex, size) {
    if (st.size !== size) { freeTarget(gl, st.a); freeTarget(gl, st.b); st.a = target(gl, size, size, specs(), true); st.b = target(gl, size, size, specs()); st.size = size; }
    const G = geoArrays(model, 0), plan = planCards(model, size, G);
    const attrs = { pos: { data: G.pos, size: 3 }, nrm: { data: G.nrm, size: 3 }, tan: { data: G.tan, size: 4 }, uv: { data: G.uv, size: 2 } }, locs = { pos: 0, nrm: 1, tan: 2, uv: 3 };
    const whole = vao(gl, locs, attrs, G.idx), loose = plan.looseIdx ? vao(gl, locs, attrs, plan.looseIdx) : null;
    const solid = plan.solidIdx && plan.solidIdx.length ? vao(gl, locs, attrs, plan.solidIdx) : whole;
    bindTarget(gl, st.a);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.depthMask(true);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]); gl.clearBufferfv(gl.COLOR, 1, [0.5, 0.5, 1, 0]); gl.clearBufferfv(gl.COLOR, 2, [1, 1, 0, 0]);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.enable(gl.SCISSOR_TEST);
    for (const c of plan.cards) {
      const [rx, ry, rw, rh] = c.rect;
      gl.viewport(rx, ry, rw, rh); gl.scissor(rx, ry, rw, rh); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
      const eye = add(c.o, mul(c.n, c.out)), VP = M4.mul(M4.ortho(c.u0, c.u1, c.v0, c.v1, 0, c.out + c.in), M4.lookAt(eye, sub(c.o, c.n), c.v));
      use(gl, P.capture, { uVP: VP, uAlbedo: tex.albedo, uNormal: tex.normal, uOrm: tex.orm, uU: c.u, uV: c.v, uN: c.n });
      // walls show what still stands; the floor shows everything on it; the ground card shows what fell
      const va = c.loose ? loose : c.name === 'floor' ? whole : solid;
      gl.bindVertexArray(va.v); gl.drawElements(gl.TRIANGLES, va.count, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.DEPTH_TEST); gl.bindVertexArray(null);
    whole.free(); if (loose) loose.free(); if (solid !== whole) solid.free();
    let src = st.a, dst = st.b; const iters = 8;
    for (let i = 0; i < iters; i++) {
      bindTarget(gl, dst);
      use(gl, P.spread, { uA: src.tex[0], uB: src.tex[1], uC: src.tex[2], uLast: i === iters - 1 ? 1 : 0 });
      drawQuad(gl);
      [src, dst] = [dst, src];
    }
    bindTarget(gl, null);
    st.result = { albedo: src.tex[0], normal: src.tex[1], orm: src.tex[2], fbo: src.fbo, size, geo: plan.geo, cards: plan.cards, pxPerM: plan.pxPerM };
    return st.result;
  }
  // one map as RGBA8, top row first; only base colour keeps its alpha
  function read(index) {
    const r = st.result, px = new Uint8Array(r.size * r.size * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo); gl.readBuffer(gl.COLOR_ATTACHMENT0 + index);
    gl.readPixels(0, 0, r.size, r.size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const row = r.size * 4, out = new Uint8ClampedArray(px.length);
    for (let y = 0; y < r.size; y++) out.set(px.subarray(y * row, (y + 1) * row), (r.size - 1 - y) * row);
    if (index !== 0) for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return out;
  }
  return { bake, read };
}
