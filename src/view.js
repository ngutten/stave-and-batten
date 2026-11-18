// The viewport: a small forward PBR renderer with a key, fill and rim light,
// a shadow map, soft ground contact, and a wireframe overlay.

import { program, use, target, bindTarget, vao, M4, texture } from './gl.js';
import { geoArrays, bounds } from './model.js';
import { NOISE } from './shaders/noise.js';
import { STYLE_GLSL } from './shaders/style.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec4 aTan; layout(location=3) in vec2 aUV;
uniform mat4 uVP, uShadowVP; uniform float uInflate;
out vec3 vPos, vNrm; out vec4 vTan; out vec2 vUV; out vec4 vSh;
void main(){ vec3 p = aPos + aNrm * uInflate; vPos = p; vNrm = aNrm; vTan = aTan; vUV = aUV; vSh = uShadowVP * vec4(p, 1.0); gl_Position = uVP * vec4(p, 1.0); }`;

const LIGHTING = `
uniform vec3 uEye, uKeyDir, uKeyCol, uFillDir, uFillCol, uRimDir, uRimCol, uSkyCol, uGroundCol;
uniform sampler2D uShadow;
float shadowAt(vec4 sh, float ndl){
  vec3 s = sh.xyz / sh.w * 0.5 + 0.5;
  if(s.x < 0.0 || s.x > 1.0 || s.y < 0.0 || s.y > 1.0 || s.z > 1.0) return 1.0;
  vec2 ts = 1.0 / vec2(textureSize(uShadow, 0));
  float bias = 0.0012 + 0.004 * (1.0 - ndl), v = 0.0;
  float a = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2832; mat2 R = mat2(cos(a), sin(a), -sin(a), cos(a));
  const vec2 P[8] = vec2[8](vec2(-0.613,0.617), vec2(0.170,-0.040), vec2(-0.299,-0.781), vec2(0.645,0.493), vec2(-0.651,-0.127), vec2(0.421,-0.627), vec2(-0.108,0.868), vec2(0.914,-0.137));
  for(int i=0;i<8;i++) v += step(s.z - bias, texture(uShadow, s.xy + R * P[i] * ts * 2.2).r);
  return v / 8.0;
}
float D_GGX(float nh, float a){ float a2 = a*a, d = nh*nh*(a2-1.0)+1.0; return a2 / (3.14159 * d * d + 1e-6); }
float V_Smith(float nv, float nl, float a){ float k = a*0.5; return 0.25 / ((nv*(1.0-k)+k) * (nl*(1.0-k)+k) + 1e-5); }
vec3 F_Schlick(vec3 f0, float vh){ return f0 + (1.0 - f0) * pow(1.0 - vh, 5.0); }
vec3 lightOne(vec3 N, vec3 V, vec3 L, vec3 lc, vec3 diff, vec3 f0, float rough){
  float nl = max(dot(N, L), 0.0); if(nl <= 0.0) return vec3(0.0);
  vec3 H = normalize(L + V); float nh = max(dot(N,H),0.0), nv = max(dot(N,V), 1e-3), vh = max(dot(V,H),0.0), a = rough*rough;
  return (diff / 3.14159 + D_GGX(nh, a) * V_Smith(nv, nl, a) * F_Schlick(f0, vh)) * lc * nl;
}
// a studio sky that blurs with roughness
vec3 envAt(vec3 d, float rough){
  float t = d.y * 0.5 + 0.5, k = mix(6.0, 1.0, rough);
  vec3 c = mix(uGroundCol, uSkyCol, smoothstep(0.5 - 0.5/k, 0.5 + 0.5/k, t));
  c += uKeyCol * 0.25 * pow(max(dot(d, uKeyDir), 0.0), mix(60.0, 2.0, rough)) * (1.0 - rough * 0.7);
  c += uSkyCol * 0.8 * pow(max(d.y, 0.0), 3.0) * (1.0 - rough);          // overhead softbox
  return c;
}
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
`;

const BGFUNC = `
uniform vec3 uBgTop, uBgBot; uniform vec2 uViewport;
vec3 bgAt(vec2 fc){ vec2 uv = fc / uViewport; float v = length(uv - vec2(0.5, 0.5)); return mix(uBgBot, uBgTop, smoothstep(0.0, 1.0, uv.y)) * (1.0 - 0.45 * v * v); }`;

const FS = `#version 300 es
precision highp float; precision highp int;
${LIGHTING}
${NOISE}
${STYLE_GLSL}
uniform sampler2D uAlbedo, uNormal, uOrm; uniform int uMode, uShade; uniform float uExposure, uAlphaCut;
uniform vec3 uInkCol, uPaperCol; uniform vec4 uStyleP; uniform vec2 uWrap;      // uStyleP: strength, pen width, hatch spacing
in vec3 vPos, vNrm; in vec4 vTan; in vec2 vUV; in vec4 vSh;
out vec4 o;
void main(){
  vec4 alb = texture(uAlbedo, vUV);
  if(alb.a < uAlphaCut) discard; vec3 orm = texture(uOrm, vUV).rgb; vec3 nt = texture(uNormal, vUV).xyz * 2.0 - 1.0;
  vec3 Ng = normalize(vNrm), T = normalize(vTan.xyz - Ng * dot(Ng, vTan.xyz)), B = cross(Ng, T) * vTan.w;
  vec3 N = normalize(T * nt.x + B * nt.y + Ng * nt.z);
  if(!gl_FrontFacing) N = -N;
  vec3 V = normalize(uEye - vPos);
  float ao = orm.r, rough = orm.g, metal = orm.b;
  if(uMode == 1){ o = vec4(pow(alb.rgb, vec3(1.0/2.2)), 1.0); return; }
  if(uMode == 2){ o = vec4(nt * 0.5 + 0.5, 1.0); return; }
  if(uMode == 3){ o = vec4(vec3(rough), 1.0); return; }
  if(uMode == 4){ o = vec4(vec3(ao), 1.0); return; }
  if(uMode == 5){ o = vec4(vec3(metal), 1.0); return; }
  if(uMode == 6){ vec2 c = floor(vUV * 64.0); float ch = mod(c.x + c.y, 2.0); o = vec4(mix(vec3(0.25), vec3(0.8), ch) * vec3(vUV, 1.0 - vUV.x) * 1.4, 1.0); return; }
  if(uMode == 7){ alb.rgb = vec3(0.6); rough = 0.7; metal = 0.0; N = Ng; }
  float sh = shadowAt(vSh, max(dot(Ng, uKeyDir), 0.0));
  if(uShade == 2 && uMode == 0){
    // unlit: the picture is the texture; only a cast shadow is added so it sits on the ground
    o = vec4(pow(alb.rgb * mix(0.80, 1.0, sh), vec3(1.0/2.2)), 1.0); return;
  }
  if(uShade != 0 && uMode == 0){
    // a drawn style, lit by this viewer's own light with the functions a game would use
    vec3 c;
    if(uShade == 1) c = styleCel(alb.rgb, N, V, uKeyDir, sh, ao, uRimDir);
    else {
      float light = styleLight(N, uKeyDir, sh, ao); vec2 pp = styleSheet(vPos, Ng, uWrap);
      // the size of a pixel on the sheet; for the ink style the surface normal is the geometric one, so flat faces shade as one
      float aa = max(length(dFdx(vPos)), length(dFdy(vPos)));
      if(uShade == 3) light = styleLight(Ng, uKeyDir, sh, ao);
      c = uShade == 3 ? styleInk(alb.rgb, uInkCol, pp, light, uStyleP.x, uStyleP.y, uStyleP.z, aa) : styleWash(alb.rgb, uPaperCol, pp, light, uStyleP.x);
    }
    o = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0/2.2)), 1.0); return;
  }
  vec3 diff = alb.rgb * (1.0 - metal), f0 = mix(vec3(0.04), alb.rgb, metal);
  vec3 c = lightOne(N, V, uKeyDir, uKeyCol, diff, f0, rough) * sh;
  c += lightOne(N, V, uFillDir, uFillCol, diff, f0, rough);
  c += lightOne(N, V, uRimDir, uRimCol, diff, f0, rough);
  vec3 amb = mix(uGroundCol, uSkyCol, N.y * 0.5 + 0.5);
  c += diff * amb * ao;
  float nv = max(dot(N, V), 1e-3);
  vec3 R = reflect(-V, N);
  vec4 r4 = rough * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
  float a004 = min(r4.x*r4.x, exp2(-9.28*nv)) * r4.x + r4.y; vec2 ab = vec2(-1.04, 1.04) * a004 + r4.zw;
  float so = clamp(pow(nv + ao, exp2(-16.0*rough - 1.0)) - 1.0 + ao, 0.0, 1.0);
  c += envAt(R, rough) * (f0 * ab.x + ab.y) * so;
  o = vec4(pow(aces(c * uExposure), vec3(1.0/2.2)), 1.0);
}`;

const GROUND_VS = `#version 300 es
layout(location=0) in vec2 aP; uniform mat4 uVP, uShadowVP; uniform float uR; out vec3 vPos; out vec4 vSh;
void main(){ vec3 p = vec3(aP.x * uR, 0.0, aP.y * uR); vPos = p; vSh = uShadowVP * vec4(p, 1.0); gl_Position = uVP * vec4(p, 1.0); }`;
const GROUND_FS = `#version 300 es
precision highp float;
${LIGHTING}
${BGFUNC}
uniform sampler2D uOccl; uniform vec4 uOcclRect; uniform float uR, uExposure; uniform vec3 uFloor;
in vec3 vPos; in vec4 vSh; out vec4 o;
void main(){
  vec3 N = vec3(0.0, 1.0, 0.0), V = normalize(uEye - vPos);
  float sh = shadowAt(vSh, uKeyDir.y);
  vec2 uv = (vPos.xz - uOcclRect.xy) / uOcclRect.zw;
  float occ = 0.0; if(uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) occ = textureLod(uOccl, uv, 3.0).r * 0.5 + textureLod(uOccl, uv, 4.5).r * 0.5;
  vec3 c = lightOne(N, V, uKeyDir, uKeyCol, uFloor, vec3(0.03), 0.8) * sh + lightOne(N, V, uFillDir, uFillCol, uFloor, vec3(0.03), 0.8);
  c += uFloor * uSkyCol * (1.0 - 0.85 * occ);
  c = pow(aces(c * uExposure), vec3(1.0/2.2));
  float fade = smoothstep(uR * 0.25, uR * 0.95, length(vPos.xz));
  o = vec4(mix(c, bgAt(gl_FragCoord.xy), fade), 1.0);
}`;
const BG_FS = `#version 300 es
precision highp float; ${BGFUNC} in vec2 vUV; out vec4 o;
void main(){ o = vec4(bgAt(gl_FragCoord.xy), 1.0); }`;
const ATLAS_FS = `#version 300 es
precision highp float; uniform sampler2D uTex; uniform vec2 uViewport; uniform int uSrgb; uniform vec3 uZoom; out vec4 o;
void main(){ float s = min(uViewport.x, uViewport.y); vec2 uv = (gl_FragCoord.xy - 0.5 * (uViewport - s)) / s; uv = (uv - 0.5) / uZoom.z + uZoom.xy;
  if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0){ o = vec4(0.08, 0.08, 0.09, 1.0); return; }
  vec3 c = texture(uTex, uv).rgb; o = vec4(uSrgb == 1 ? pow(c, vec3(1.0/2.2)) : c, 1.0); }`;
const FLAT_FS = `#version 300 es
precision highp float; uniform vec4 uColor; out vec4 o; void main(){ o = uColor; }`;
const DEPTH_FS = `#version 300 es
precision highp float; uniform sampler2D uAlbedo; uniform float uAlphaCut; in vec2 vUV; out vec4 o;
void main(){ if(uAlphaCut > 0.0 && texture(uAlbedo, vUV).a < uAlphaCut) discard; o = vec4(1.0); }`;

export function createView(gl, canvas) {
  const P = {
    main: program(gl, VS, FS, 'view'),
    ground: program(gl, GROUND_VS, GROUND_FS, 'ground'),
    bg: program(gl, `#version 300 es
layout(location=0) in vec2 aP; out vec2 vUV; void main(){ vUV = aP*0.5+0.5; gl_Position = vec4(aP, 0.9999, 1.0); }`, BG_FS, 'bg'),
    flat: program(gl, VS, FLAT_FS, 'flat'),
    atlas: program(gl, `#version 300 es
layout(location=0) in vec2 aP; void main(){ gl_Position = vec4(aP, 0.0, 1.0); }`, ATLAS_FS, 'atlas'),
    depth: program(gl, VS, DEPTH_FS, 'viewDepth'),
  };
  const shadow = target(gl, 2048, 2048, [], true);
  gl.bindTexture(gl.TEXTURE_2D, shadow.depthTex.tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const occl = target(gl, 256, 256, [{ internal: gl.R8, format: gl.RED, filter: gl.LINEAR }], true);
  const gq = vao(gl, { p: 0 }, { p: { data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), size: 2 } });
  const cam = { yaw: 0.65, pitch: 0.38, dist: 2.6, target: [0, 0.4, 0], fov: 32 * Math.PI / 180 };
  const S = { shade: 'pbr', style: null, lightAz: 327, lightEl: 46, lods: [], bb: null, atlas: '', atlasZoom: [0.5, 0.5, 1], mode: 0, wire: false, lod: 0, tex: null, dirty: true, exposure: 1.0, spin: false };
  const nrm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const L = {
    uKeyDir: nrm([-0.38, 0.72, 0.58]), uKeyCol: [3.3, 3.05, 2.7], uFillDir: nrm([0.85, 0.3, 0.3]), uFillCol: [0.50, 0.58, 0.72],
    uRimDir: nrm([0.35, 0.45, -0.85]), uRimCol: [0.9, 0.95, 1.1], uSkyCol: [0.30, 0.33, 0.39], uGroundCol: [0.13, 0.115, 0.10],
  };
  const bgTop = [0.13, 0.135, 0.15], bgBot = [0.20, 0.205, 0.215];

  const meshOf = (G) => {
      const v = vao(gl, { pos: 0, nrm: 1, tan: 2, uv: 3 }, { pos: { data: G.pos, size: 3 }, nrm: { data: G.nrm, size: 3 }, tan: { data: G.tan, size: 4 }, uv: { data: G.uv, size: 2 } }, G.idx);
      // unique edges for the wireframe
      const seen = new Set(), lines = [];
      for (let t = 0; t < G.idx.length; t += 3) for (let e = 0; e < 3; e++) {
        const a = G.idx[t + e], b = G.idx[t + (e + 1) % 3], k = a < b ? a * 1e7 + b : b * 1e7 + a;
        if (!seen.has(k)) { seen.add(k); lines.push(a, b); }
      }
      const w = vao(gl, { pos: 0, nrm: 1 }, { pos: { data: G.pos, size: 3 }, nrm: { data: G.nrm, size: 3 } }, new Uint32Array(lines));
      return { v, w, ntri: G.ntri, nv: G.nv };
  };
  const mip = (t) => {
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    for (const tex of [t.albedo, t.normal, t.orm]) {
      gl.bindTexture(gl.TEXTURE_2D, tex.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, 8);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
  };
  // the card level of detail has its own mesh and its own textures, cut out by alpha
  function setCards(r) {
    if (S.cards) { S.cards.v.free(); S.cards.w.free(); S.cards = null; }
    if (r) { S.cards = { ...meshOf(r.geo), tex: r, cut: 0.4 }; mip(r); }
    S.dirty = true;
  }
  function setModel(model) {
    for (const l of S.lods) { l.v.free(); l.w.free(); }
    setCards(null);
    S.lods = model.lod.map((_, i) => meshOf(geoArrays(model, i)));
    const first = !S.bb;
    S.bb = bounds(model, 0);
    const b = S.bb, r = 0.5 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    S.radius = r; cam.target = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    // refit when the thing changes size by much (debris spreads), but leave the angle alone
    if (first || S.autoFrame || Math.abs(r - (S.fitR || 0)) > 0.1 * (S.fitR || 1)) { cam.dist = r / Math.sin(cam.fov / 2) * 1.12; S.fitR = r; S.autoFrame = false; }
    S.dirty = true; S.shadowDirty = true;
  }
  function setTextures(t) { S.tex = t; mip(t); S.dirty = true; }

  function eye() {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    return [cam.target[0] + cam.dist * cp * Math.sin(cam.yaw), cam.target[1] + cam.dist * sp, cam.target[2] + cam.dist * cp * Math.cos(cam.yaw)];
  }

  function render() {
    S.dirty = false;
    if (!S.lods.length || !S.tex) return;
    // the key light can be walked round, to see a style answer it
    { const az = S.lightAz * Math.PI / 180, el = S.lightEl * Math.PI / 180; L.uKeyDir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)]; }
    const cards = S.lod >= S.lods.length && S.cards, lod = cards || S.lods[Math.min(S.lod, S.lods.length - 1)];
    const tex = cards ? cards.tex : S.tex, cut = cards ? cards.cut : 0;
    const b = S.bb, r = S.radius, cen = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    // shadow map from the key light
    const sr = r * 1.6, se = [cen[0] + L.uKeyDir[0] * r * 4, cen[1] + L.uKeyDir[1] * r * 4, cen[2] + L.uKeyDir[2] * r * 4];
    const SVP = M4.mul(M4.ortho(-sr, sr, -sr, sr, r * 1.5, r * 7), M4.lookAt(se, cen, [0, 1, 0]));
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    bindTarget(gl, shadow); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    use(gl, P.depth, { uVP: SVP, uShadowVP: SVP, uInflate: 0, uAlbedo: tex.albedo, uAlphaCut: cut });
    gl.bindVertexArray(lod.v.v); gl.drawElements(gl.TRIANGLES, lod.v.count, gl.UNSIGNED_INT, 0);
    // top-down occupancy for ground contact
    const or = r * 1.7, OVP = M4.mul(M4.ortho(-or, or, -or, or, 0.01, b.max[1] + 2), M4.lookAt([cen[0], b.max[1] + 1, cen[2]], [cen[0], 0, cen[2]], [0, 0, -1]));
    bindTarget(gl, occl); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    use(gl, P.depth, { uVP: OVP, uShadowVP: OVP, uInflate: 0, uAlbedo: tex.albedo, uAlphaCut: cut });
    gl.drawElements(gl.TRIANGLES, lod.v.count, gl.UNSIGNED_INT, 0);
    gl.bindTexture(gl.TEXTURE_2D, occl.tex[0].tex); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.generateMipmap(gl.TEXTURE_2D);

    bindTarget(gl, null);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, e = eye();
    const VP = M4.mul(M4.perspective(cam.fov, w / h, cam.dist * 0.02, cam.dist * 20 + 50), M4.lookAt(e, cam.target, [0, 1, 0]));
    gl.clearColor(bgBot[0], bgBot[1], bgBot[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (S.atlas) {
      gl.disable(gl.DEPTH_TEST);
      use(gl, P.atlas, { uTex: tex[S.atlas], uViewport: [w, h], uSrgb: S.atlas === 'albedo' ? 1 : 0, uZoom: S.atlasZoom });
      gl.bindVertexArray(gq.v); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.bindVertexArray(null); return;
    }
    const common = { ...L, uViewport: [w, h], uEye: e, uVP: VP, uShadowVP: SVP, uShadow: shadow.depthTex, uExposure: S.exposure, uBgTop: bgTop, uBgBot: bgBot };
    gl.depthMask(false); use(gl, P.bg, common); gl.bindVertexArray(gq.v); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.depthMask(true);
    // ground: x in OVP maps world x; the occupancy map is flipped in z by the lookAt up vector
    use(gl, P.ground, { ...common, uR: Math.max(6, r * 8), uOccl: occl.tex[0], uOcclRect: [cen[0] - or, cen[2] - or, 2 * or, 2 * or], uFloor: [0.115, 0.115, 0.118] });
    gl.bindVertexArray(gq.v); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (!cards) { gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); }         // cards are seen from both sides
    if (S.wire) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); }
    use(gl, P.main, { ...common, uAlbedo: tex.albedo, uNormal: tex.normal, uOrm: tex.orm, uMode: S.mode, uInflate: 0, uAlphaCut: cut, uShade: { pbr: 0, toon: 1, unlit: 2, ink: 3, wash: 4 }[S.shade] || 0,
      ...(S.style || { uInkCol: [0, 0, 0], uPaperCol: [1, 1, 1], uStyleP: [1, 0.001, 0.01, 0], uWrap: [0, 1] }) });
    gl.bindVertexArray(lod.v.v); gl.drawElements(gl.TRIANGLES, lod.v.count, gl.UNSIGNED_INT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if (S.wire) {
      use(gl, P.flat, { uVP: VP, uShadowVP: SVP, uInflate: 0, uColor: [0.35, 0.95, 1.0, 1.0] });
      gl.bindVertexArray(lod.w.v); gl.drawElements(gl.LINES, lod.w.count, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.CULL_FACE); gl.bindVertexArray(null);
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(2, Math.round(canvas.clientWidth * dpr)), h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; S.dirty = true; }
  }

  // orbit controls
  let drag = null;
  canvas.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, pan: ev.button === 2 || ev.shiftKey }; canvas.setPointerCapture(ev.pointerId); });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drag) return; const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y; drag.x = ev.clientX; drag.y = ev.clientY;
    if (S.atlas) { const k = 1 / (Math.min(canvas.clientWidth, canvas.clientHeight) * S.atlasZoom[2]); S.atlasZoom[0] -= dx * k; S.atlasZoom[1] += dy * k; S.dirty = true; return; }
    if (drag.pan) { const s = cam.dist * 0.0012; cam.target[0] -= Math.cos(cam.yaw) * dx * s; cam.target[2] += Math.sin(cam.yaw) * dx * s; cam.target[1] += dy * s; }
    else { cam.yaw -= dx * 0.008; cam.pitch = Math.max(-0.2, Math.min(1.5, cam.pitch + dy * 0.008)); }
    S.dirty = true;
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); if (S.atlas) S.atlasZoom[2] = Math.max(1, Math.min(64, S.atlasZoom[2] * Math.exp(-ev.deltaY * 0.0015))); else cam.dist *= Math.exp(ev.deltaY * 0.0012); S.dirty = true; }, { passive: false });

  return { S, cam, setModel, setTextures, setCards, render, resize };
}
