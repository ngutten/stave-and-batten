// A model is a set of UV islands plus render geometry at several LODs.
//
// An island is a patch of surface with its own rectangle in the atlas. Its
// "face-local" coordinates f = (fu, fv) are in metres, so texel density is
// uniform everywhere and grain runs along +U. Every island carries bake
// geometry that covers its whole rectangle: the bake draws that in UV space
// with position, normal and "log space" coordinates as varyings, so the
// material shader can cut each board out of a solid block of wood.
//
// Render geometry (per LOD) refers to islands; UVs are assigned after packing.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Materials. The bake shader branches on these.
export const MAT = { WOOD: 0, IRON: 1, DARK: 2, PAINTED_METAL: 3, ROPE: 4 };

export const NLOD = 2;

function newGeo() { return { p: [], n: [], t: [], f: [], isl: [], idx: [], nv: 0 }; }

export function createModel(name) {
  const lod = []; for (let i = 0; i < NLOD; i++) lod.push(newGeo());
  return { name, islands: [], lod, stamps: [], parts: 0 };
}

// dens: texel density relative to the rest of the atlas (insides get less)
export function addIsland(model, { w, h, mat = MAT.WOOD, seed = 0, extra = [0, 0, 0, 0], part = 0, tag = '', dens = 1 }) {
  const isl = { id: model.islands.length, w, h, mat, seed, extra, part, tag, dens, bp: [], bn: [], bt: [], bl: [], bf: [], br: [], bidx: [], bnv: 0, px: 0, py: 0 };
  model.islands.push(isl);
  return isl;
}

// Bake vertex: face-local f, position, normal, tangent (dP/dU), log coords.
// rest: where this point was before anything broke or fell. Markings are
// projected in that space, so a stencil stays on the pieces of a smashed crate.
export function bakeVert(isl, f, p, n, t, l, face, rest) {
  if (face) { if (!isl.bface) isl.bface = []; isl.bface[isl.bnv] = face; }
  const r = rest || p; isl.br.push(r[0], r[1], r[2]);
  isl.bf.push(f[0], f[1]); isl.bp.push(p[0], p[1], p[2]); isl.bn.push(n[0], n[1], n[2]);
  isl.bt.push(t[0], t[1], t[2]); isl.bl.push(l[0], l[1], l[2]);
  return isl.bnv++;
}
export function bakeTri(isl, a, b, c) { isl.bidx.push(a, b, c); }

export function geoVert(geo, isl, f, p, n, t) {
  geo.p.push(p[0], p[1], p[2]); geo.n.push(n[0], n[1], n[2]); geo.t.push(t[0], t[1], t[2]);
  geo.f.push(f[0], f[1]); geo.isl.push(isl.id);
  return geo.nv++;
}
export function geoTri(geo, a, b, c) { geo.idx.push(a, b, c); }

// Emit a triangle wound so that it faces away from `inside`.
function triOut(geo, a, b, c, inside) {
  const P = (i) => [geo.p[i * 3], geo.p[i * 3 + 1], geo.p[i * 3 + 2]];
  const pa = P(a), pb = P(b), pc = P(c);
  const n = cross(sub(pb, pa), sub(pc, pa));
  const cen = mul(add(add(pa, pb), pc), 1 / 3);
  if (dot(n, sub(cen, inside)) >= 0) geoTri(geo, a, b, c); else geoTri(geo, a, c, b);
}

export const FACE = { PZ: 1, NZ: 2, PY: 4, NY: 8, PX: 16, NX: 32, ALL: 63 };

// A board: a box with local axes ax (length, grain), ay (width), az (thickness).
//   c       centre
//   L,W,T   full sizes along ax, ay, az
//   mask    which faces can ever be seen (FACE bits); hidden faces get no island
//   bevel   chamfer width in metres for LOD0
//   shear   [s0, s1]: the -x and +x ends are cut at a slant, x += s * y (mitred braces)
//   log     {o, ax, ay, az}: affine map from local board coords into log space
// Returns the islands by face bit.
export function addBox(model, o) {
  const { c, ax, ay, az, L, W, T, mask = FACE.ALL, mat = MAT.WOOD, seed = 0, extra = [0, 0, 0, 0], tag = '' } = o;
  const shear = o.shear || [0, 0];
  const log = o.log || { o: [0, 0, 0], ax: [1, 0, 0], ay: [0, 1, 0], az: [0, 0, 1] };
  const hx = L / 2, hy = W / 2, hz = T / 2;
  const bevel = Math.min(o.bevel || 0, 0.3 * Math.min(L, W, T));
  const lowMask = o.lowMask || 0, lowDens = o.lowDens || 0.5;      // faces baked at reduced density
  const part = model.parts++;

  // corners: bit0 = +x, bit1 = +y, bit2 = +z
  const corner = [];
  for (let k = 0; k < 8; k++) {
    const sx = k & 1 ? 1 : -1, sy = k & 2 ? 1 : -1, sz = k & 4 ? 1 : -1;
    const x = sx * hx + shear[k & 1] * sy * hy;
    corner.push(add(add(madd(c, ax, x), mul(ay, sy * hy)), mul(az, sz * hz)));
  }
  const toLog = (p) => {
    const d = sub(p, c), lx = dot(d, ax), ly = dot(d, ay), lz = dot(d, az);
    return add(add(madd(log.o, log.ax, lx), mul(log.ay, ly)), mul(log.az, lz));
  };
  // o.rest: the frame { c, ax, ay, az } this box had before it was disturbed
  const R0 = o.rest;
  const toRest = (p) => { if (!R0) return p; const d = sub(p, c); return add(add(madd(R0.c, R0.ax, dot(d, ax)), mul(R0.ay, dot(d, ay))), mul(R0.az, dot(d, az))); };
  const ayS = (s) => norm(madd(ay, ax, s));
  const neg = (v) => mul(v, -1);
  // [bit, U, V, corner test]
  const faces = [
    [FACE.PZ, ax, ay, (k) => (k & 4) !== 0],
    [FACE.NZ, ax, neg(ay), (k) => (k & 4) === 0],
    [FACE.PY, ax, neg(az), (k) => (k & 2) !== 0],
    [FACE.NY, ax, az, (k) => (k & 2) === 0],
    [FACE.PX, ayS(shear[1]), az, (k) => (k & 1) !== 0],
    [FACE.NX, ayS(shear[0]), neg(az), (k) => (k & 1) === 0],
  ];
  const info = faces.map(([bit, U, Vv, test]) => {
    const N = norm(cross(U, Vv));
    const ks = []; for (let k = 0; k < 8; k++) if (test(k)) ks.push(k);
    let mnu = Infinity, mnv = Infinity, mxu = -Infinity, mxv = -Infinity;
    for (const k of ks) {
      const d = sub(corner[k], c), u = dot(d, U), v = dot(d, Vv);
      mnu = Math.min(mnu, u); mxu = Math.max(mxu, u); mnv = Math.min(mnv, v); mxv = Math.max(mxv, v);
    }
    const fOf = (p) => { const d = sub(p, c); return [dot(d, U) - mnu, dot(d, Vv) - mnv]; };
    // order corners counter-clockwise seen from outside
    const cu = (mnu + mxu) / 2, cv = (mnv + mxv) / 2;
    ks.sort((a, b) => {
      const fa = fOf(corner[a]), fb = fOf(corner[b]);
      return Math.atan2(fa[1] + mnv - cv, fa[0] + mnu - cu) - Math.atan2(fb[1] + mnv - cv, fb[0] + mnu - cu);
    });
    return { bit, U, V: Vv, N, ks, w: mxu - mnu, h: mxv - mnv, fOf, visible: (mask & bit) !== 0, isl: null, inset: {} };
  });

  const out = {};
  for (const F of info) {
    if (!F.visible) continue;
    const isl = addIsland(model, { w: F.w, h: F.h, mat, seed, extra, part, tag, dens: lowMask & F.bit ? lowDens : 1 });
    isl.U = F.U; isl.V = F.V; isl.N = F.N; isl.fOf = F.fOf;
    F.isl = isl; out[F.bit] = isl;
    const vi = F.ks.map((k) => bakeVert(isl, F.fOf(corner[k]), corner[k], F.N, F.U, toLog(corner[k]), undefined, toRest(corner[k])));
    bakeTri(isl, vi[0], vi[1], vi[2]); bakeTri(isl, vi[0], vi[2], vi[3]);
  }

  // inset corner positions per face (used by chamfers even on hidden faces)
  for (const F of info) {
    for (let i = 0; i < 4; i++) {
      const cur = corner[F.ks[i]], nx = corner[F.ks[(i + 1) % 4]], pv = corner[F.ks[(i + 3) % 4]];
      const d1 = norm(sub(nx, cur)), d2 = norm(sub(pv, cur));
      F.inset[F.ks[i]] = bevel > 0 ? add(cur, mul(add(d1, d2), bevel)) : cur;
    }
  }

  // LOD1: plain faces
  {
    const g = model.lod[1];
    for (const F of info) {
      if (!F.visible) continue;
      const vi = F.ks.map((k) => geoVert(g, F.isl, F.fOf(corner[k]), corner[k], F.N, F.U));
      geoTri(g, vi[0], vi[1], vi[2]); geoTri(g, vi[0], vi[2], vi[3]);
    }
  }
  // LOD0: chamfered
  {
    const g = model.lod[0];
    // chamfer vertices take their UV by projection onto the owning face; on a
    // mitred end that can land a hair outside the island, so clamp
    const fIn = (F, p) => { const f = F.fOf(p); return [Math.min(F.w, Math.max(0, f[0])), Math.min(F.h, Math.max(0, f[1]))]; };
    for (const F of info) {
      if (!F.visible) continue;
      const vi = F.ks.map((k) => geoVert(g, F.isl, F.fOf(F.inset[k]), F.inset[k], F.N, F.U));
      geoTri(g, vi[0], vi[1], vi[2]); geoTri(g, vi[0], vi[2], vi[3]);
    }
    if (bevel > 0) {
      // edges: corner pairs differing in one bit
      for (let a = 0; a < 8; a++) for (let bitn = 0; bitn < 3; bitn++) {
        const b = a | (1 << bitn); if (b === a) continue;
        const sh = info.filter((F) => F.ks.includes(a) && F.ks.includes(b));
        const own = sh.find((F) => F.visible); if (!own) continue;
        const oth = sh[0] === own ? sh[1] : sh[0];
        const v0 = geoVert(g, own.isl, fIn(own, own.inset[a]), own.inset[a], own.N, own.U);
        const v1 = geoVert(g, own.isl, fIn(own, own.inset[b]), own.inset[b], own.N, own.U);
        const v2 = geoVert(g, own.isl, fIn(own, oth.inset[b]), oth.inset[b], oth.N, own.U);
        const v3 = geoVert(g, own.isl, fIn(own, oth.inset[a]), oth.inset[a], oth.N, own.U);
        triOut(g, v0, v1, v2, c); triOut(g, v0, v2, v3, c);
      }
      for (let k = 0; k < 8; k++) {
        const sh = info.filter((F) => F.ks.includes(k));
        const own = sh.find((F) => F.visible); if (!own) continue;
        const vi = sh.map((F) => geoVert(g, own.isl, fIn(own, F.inset[k]), F.inset[k], F.N, own.U));
        triOut(g, vi[0], vi[1], vi[2], c);
      }
    }
  }
  return out;
}

// Low-level: put explicit vertices and triangles on an island, for baking and
// for the given LODs. verts: [{ p, n, t, f, l, face? }]. Triangles are wound to
// agree with their first vertex's normal.
export function emitMesh(model, isl, verts, tris, lods = null) {
  const bi = verts.map((v) => bakeVert(isl, v.f, v.p, v.n, v.t, v.l || [0, 0, 0], v.face, v.rest));
  for (const [a, b, d] of tris) bakeTri(isl, bi[a], bi[b], bi[d]);
  model.lod.forEach((g, li) => {
    if (lods && !lods.includes(li)) return;
    const gi = verts.map((v) => geoVert(g, isl, v.f, v.p, v.n, v.t));
    for (const [a, b, d] of tris) {
      const gn = cross(sub(verts[b].p, verts[a].p), sub(verts[d].p, verts[a].p));
      if (dot(gn, verts[a].n) >= 0) geoTri(g, gi[a], gi[b], gi[d]); else geoTri(g, gi[a], gi[d], gi[b]);
    }
  });
}

// A plank whose ends may be broken. Local axes as addBox. Across the width
// there are stations y[k]; at each, the left and right ends sit at
// xl/xr (top face) and xlb/xrb (bottom face), so a break can be ragged in plan
// and slanted through the thickness, the way wood tears along its grain.
//   o.left / o.right: null for a square end, or { top: [..], bot: [..] } of
//   x offsets (metres, positive = into the plank... measured from the nominal end)
//   o.logShift: this piece's centre in the coordinates of the board it was
//   part of, so both halves of a snapped board show the same tree.
export function addPlank(model, o) {
  const { c, ax, ay, az, L, W, T, mask = FACE.ALL, mat = MAT.WOOD, seed = 0, tag = '' } = o;
  const log = o.log || { o: [0, 0, 0], ax: [1, 0, 0], ay: [0, 1, 0], az: [0, 0, 1] };
  const sh = o.logShift || [0, 0, 0], lowMask = o.lowMask || 0, lowDens = o.lowDens || 0.5;
  const hx = L / 2, hy = W / 2, hz = T / 2, part = o.part !== undefined ? o.part : model.parts++;
  const K = o.left ? o.left.top.length - 1 : o.right ? o.right.top.length - 1 : 1;
  const ys = o.stations || Array.from({ length: K + 1 }, (_, k) => -hy + (W * k) / K);
  const off = (e, which, k) => (e ? e[which][k] : 0);
  const xl = ys.map((_, k) => -hx + off(o.left, 'top', k)), xlb = ys.map((_, k) => -hx + off(o.left, 'bot', k));
  const xr = ys.map((_, k) => hx - off(o.right, 'top', k)), xrb = ys.map((_, k) => hx - off(o.right, 'bot', k));
  const P = (x, y, z) => add(add(madd(c, ax, x), mul(ay, y)), mul(az, z));
  const toLog = (x, y, z) => add(add(madd(log.o, log.ax, x + sh[0]), mul(log.ay, y + sh[1])), mul(log.az, z + sh[2]));
  // o.rest: the frame of the whole board before it broke; this piece sits at logShift within it
  const R0 = o.rest;
  const toRest = (x, y, z) => (R0 ? add(add(madd(R0.c, R0.ax, x + sh[0]), mul(R0.ay, y + sh[1])), mul(R0.az, z + sh[2])) : P(x, y, z));
  const neg = (v) => mul(v, -1);
  const dens = (bit) => (lowMask & bit ? lowDens : 1);
  const out = {};
  // verts: [{x, y, z, f, face, n?}]. mode 'all': bake and every LOD; 'near': bake and LOD0;
  // 'far': the lower LODs only, where a ragged end is drawn as one straight cut
  const emit = (isl, verts, tris, n, t, mode = 'all') => {
    if (mode !== 'far') {
      const bi = verts.map((v) => bakeVert(isl, v.f, P(v.x, v.y, v.z), v.n || n, t, toLog(v.x, v.y, v.z), v.face, toRest(v.x, v.y, v.z)));
      for (const [a, b, d] of tris) bakeTri(isl, bi[a], bi[b], bi[d]);
    }
    for (let li = 0; li < model.lod.length; li++) {
      if ((mode === 'near' && li > 0) || (mode === 'far' && li === 0)) continue;
      const g = model.lod[li];
      const gi = verts.map((v) => geoVert(g, isl, v.f, P(v.x, v.y, v.z), v.n || n, t));
      for (const [a, b, d] of tris) {
        // wind to agree with the normal
        const pa = P(verts[a].x, verts[a].y, verts[a].z), pb = P(verts[b].x, verts[b].y, verts[b].z), pd = P(verts[d].x, verts[d].y, verts[d].z);
        const gn = cross(sub(pb, pa), sub(pd, pa)), nn = verts[a].n || n;
        if (dot(gn, nn) >= 0) geoTri(g, gi[a], gi[b], gi[d]); else geoTri(g, gi[a], gi[d], gi[b]);
      }
    }
  };
  // broad faces
  for (const [bit, z, XL, XR, U, Vv, flipV] of [[FACE.PZ, hz, xl, xr, ax, ay, false], [FACE.NZ, -hz, xlb, xrb, ax, neg(ay), true]]) {
    if (!(mask & bit)) continue;
    const xmin = Math.min(...XL), xmax = Math.max(...XR);
    const isl = addIsland(model, { w: xmax - xmin, h: W, mat, seed, extra: o.extra || [0, 0, 0, 0], part, tag, dens: dens(bit) });
    const N = norm(cross(U, Vv));
    isl.U = U; isl.V = Vv; isl.N = N;
    isl.fOf = (p) => { const d = sub(p, c); return [dot(d, ax) - xmin, flipV ? hy - dot(d, ay) : dot(d, ay) + hy]; };
    const verts = [], tris = [];
    ys.forEach((y, k) => {
      const fv = flipV ? hy - y : y + hy, len = XR[k] - XL[k];
      verts.push({ x: XL[k], y, z, f: [XL[k] - xmin, fv], face: [0, fv, len, W] }, { x: XR[k], y, z, f: [XR[k] - xmin, fv], face: [len, fv, len, W] });
    });
    for (let k = 0; k < K; k++) tris.push([2 * k, 2 * k + 1, 2 * k + 3], [2 * k, 2 * k + 3, 2 * k + 2]);
    if (K > 1) { emit(isl, verts, tris, N, U, 'near'); emit(isl, [verts[0], verts[1], verts[2 * K], verts[2 * K + 1]], [[0, 1, 3], [0, 3, 2]], N, U, 'far'); }
    else emit(isl, verts, tris, N, U);
    out[bit] = isl;
  }
  // long edges
  for (const [bit, k, y, U, Vv] of [[FACE.PY, K, hy, ax, neg(az)], [FACE.NY, 0, -hy, ax, az]]) {
    if (!(mask & bit)) continue;
    const xs = [xl[k], xr[k], xrb[k], xlb[k]], xmin = Math.min(...xs), xmax = Math.max(...xs), top = bit === FACE.PY;
    const isl = addIsland(model, { w: xmax - xmin, h: T, mat, seed, extra: o.extra || [0, 0, 0, 0], part, tag, dens: dens(bit) });
    const fv = (z) => (top ? hz - z : z + hz), lt = xr[k] - xl[k], lb = xrb[k] - xlb[k];
    emit(isl, [
      { x: xl[k], y, z: hz, f: [xl[k] - xmin, fv(hz)], face: [0, fv(hz), lt, T] }, { x: xr[k], y, z: hz, f: [xr[k] - xmin, fv(hz)], face: [lt, fv(hz), lt, T] },
      { x: xrb[k], y, z: -hz, f: [xrb[k] - xmin, fv(-hz)], face: [lb, fv(-hz), lb, T] }, { x: xlb[k], y, z: -hz, f: [xlb[k] - xmin, fv(-hz)], face: [0, fv(-hz), lb, T] },
    ], [[0, 1, 2], [0, 2, 3]], norm(cross(U, Vv)), U);
    out[bit] = isl;
  }
  // ends: one wall per station gap if broken, a single quad if square
  for (const [bit, e, XT, XB, sgn] of [[FACE.NX, o.left, xl, xlb, -1], [FACE.PX, o.right, xr, xrb, 1]]) {
    if (!(mask & bit)) continue;
    const segs = e ? ys.map((_, k) => k).slice(0, K).map((k) => [k, k + 1]) : [[0, K]];
    let total = 0; const lens = segs.map(([a, b]) => { const l = Math.hypot(XT[b] - XT[a], ys[b] - ys[a]); total += l; return l; });
    const brk = e && !o.cutEnds;       // shaped ends are fresh breaks unless they were cut that way
    const isl = addIsland(model, { w: total, h: T, mat, seed, extra: [0, brk ? 1 : 0, (o.extra || [])[2] || 0, 0], part, tag: brk ? 'break' : tag, dens: brk ? 1 : dens(bit) });
    const wall = (a, b, sA, sB, mode) => {
      // outward normal of this wall in the plank's frame; it leans where top and bottom profiles differ
      const dxT = XT[b] - XT[a], dy = ys[b] - ys[a];
      let n2 = [dy, -dxT]; if (n2[0] * sgn < 0) n2 = [-n2[0], -n2[1]];
      let gn = [-dy * T, dxT * T, -dy * (XB[a] - XT[a])];
      if (gn[0] * n2[0] + gn[1] * n2[1] < 0) gn = [-gn[0], -gn[1], -gn[2]];
      const n3 = norm(add(add(mul(ax, gn[0]), mul(ay, gn[1])), mul(az, gn[2])));
      const tdir = norm(add(mul(ax, dxT), mul(ay, dy)));
      const f = (s, z) => [s, z + hz], fc = (s, z) => [0.5, z + hz, 1, T];
      emit(isl, [
        { x: XT[a], y: ys[a], z: hz, f: f(sA, hz), face: fc(sA, hz) }, { x: XT[b], y: ys[b], z: hz, f: f(sB, hz), face: fc(sB, hz) },
        { x: XB[b], y: ys[b], z: -hz, f: f(sB, -hz), face: fc(sB, -hz) }, { x: XB[a], y: ys[a], z: -hz, f: f(sA, -hz), face: fc(sA, -hz) },
      ], [[0, 1, 2], [0, 2, 3]], n3, tdir, mode);
    };
    let s0 = 0;
    segs.forEach(([a, b], i) => { wall(a, b, s0, s0 + lens[i], segs.length > 1 ? 'near' : 'all'); s0 += lens[i]; });
    if (segs.length > 1) wall(0, K, 0, total, 'far');
    out[bit] = isl;
  }
  return out;
}

// A parametric patch with its own island. fn(u, v) for u, v in 0..1 returns
// { p, n, t, f, l, face? }: position, normal, tangent (dP/dU of the island),
// island coords in metres, log coords, and optionally the face rectangle
// [x, y, w, h] used for edge distance when the patch does not fill its island.
// The bake grid and each LOD's grid may differ; they sample the same surface.
export function addSurface(model, o) {
  const { w, h, mat = MAT.WOOD, seed = 0, extra = [0, 0, 0, 0], tag = '' } = o;
  const isl = addIsland(model, { w, h, mat, seed, extra, tag, dens: o.dens || 1, part: o.part !== undefined ? o.part : model.parts++ });
  // o.xf: a rigid motion { p(point), v(vector) } applied to what fn returns (a stave that has sprung, a hoop that has dropped)
  const fn = o.xf ? (u, v, lod) => { const s = o.fn(u, v, lod); return { ...s, rest: s.p, p: o.xf.p(s.p), n: o.xf.v(s.n), t: o.xf.v(s.t) }; } : o.fn;
  const grid = (nu, nv, lod, emitV, emitT) => {
    const id = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) id.push(emitV(fn(i / nu, j / nv, lod)));
    // orientation: make triangles agree with the supplied normal
    const a = fn(0.5, 0.5, lod), b = fn(0.5 + 0.5 / nu, 0.5, lod), c = fn(0.5, 0.5 + 0.5 / nv, lod);
    const flip = dot(cross(sub(b.p, a.p), sub(c.p, a.p)), a.n) < 0;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const v0 = id[j * (nu + 1) + i], v1 = id[j * (nu + 1) + i + 1], v2 = id[(j + 1) * (nu + 1) + i + 1], v3 = id[(j + 1) * (nu + 1) + i];
      if (flip) { emitT(v0, v2, v1); emitT(v0, v3, v2); } else { emitT(v0, v1, v2); emitT(v0, v2, v3); }
    }
  };
  const [bu, bv] = o.bakeGrid || o.lodGrid[0];
  grid(bu, bv, -1, (s) => bakeVert(isl, s.f, s.p, s.n, s.t, s.l || [0, 0, 0], s.face, s.rest), (a, b, c) => bakeTri(isl, a, b, c));
  o.lodGrid.forEach((g, li) => { if (!g) return; const geo = model.lod[li]; grid(g[0], g[1], li, (s) => geoVert(geo, isl, s.f, s.p, s.n, s.t), (a, b, c) => geoTri(geo, a, b, c)); });
  return isl;
}

// A box that takes one tiny island (flat colour). Used for the dark liner
// that stops you seeing through the gaps between boards.
export function addSolidBox(model, c, size, mat = MAT.DARK, facing = 1) {
  const s = 0.012, isl = addIsland(model, { w: s, h: s, mat, tag: 'liner', part: model.parts++ });
  const b = [bakeVert(isl, [0, 0], c, [0, 1, 0], [1, 0, 0], [0, 0, 0]), bakeVert(isl, [s, 0], c, [0, 1, 0], [1, 0, 0], [0, 0, 0]),
    bakeVert(isl, [s, s], c, [0, 1, 0], [1, 0, 0], [0, 0, 0]), bakeVert(isl, [0, s], c, [0, 1, 0], [1, 0, 0], [0, 0, 0])];
  bakeTri(isl, b[0], b[1], b[2]); bakeTri(isl, b[0], b[2], b[3]);
  const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1], ng = (v) => mul(v, -1);
  const fs = [[X, Y, Z], [ng(X), Y, ng(Z)], [ng(Z), Y, X], [Z, Y, ng(X)], [X, ng(Z), Y], [X, Z, ng(Y)]];
  const h = mul(size, 0.5), ext = (v) => Math.abs(v[0]) * h[0] + Math.abs(v[1]) * h[1] + Math.abs(v[2]) * h[2];
  for (const g of model.lod) for (const [U, Vv, N] of fs) {
    const o = madd(c, N, ext(N)), eu = ext(U), ev = ext(Vv), q = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const vi = q.map(([a, bb]) => geoVert(g, isl, [s / 2, s / 2], add(madd(o, U, a * eu), mul(Vv, bb * ev)), mul(N, facing), U));
    if (facing > 0) { geoTri(g, vi[0], vi[1], vi[2]); geoTri(g, vi[0], vi[2], vi[3]); } else { geoTri(g, vi[0], vi[2], vi[1]); geoTri(g, vi[0], vi[3], vi[2]); }
  }
  return isl;
}

// Shelf-pack islands into a square atlas at the largest uniform texel density that fits.
export function packAtlas(model, size = 2048, padPx = 3) {
  const order = model.islands.slice().sort((a, b) => b.h - a.h || b.w - a.w);
  const tryPack = (s, commit) => {
    let x = 0, y = 0, shelf = 0;
    for (const isl of order) {
      const w = Math.ceil(isl.w * s * isl.dens) + 2 * padPx, h = Math.ceil(isl.h * s * isl.dens) + 2 * padPx;
      if (w > size) return false;
      if (x + w > size) { x = 0; y += shelf; shelf = 0; }
      if (y + h > size) return false;
      if (commit) { isl.px = x + padPx; isl.py = y + padPx; }
      x += w; shelf = Math.max(shelf, h);
    }
    return true;
  };
  let lo = 1, hi = 1e5;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (tryPack(mid, false)) lo = mid; else hi = mid; }
  tryPack(lo, true);
  model.atlas = { size, pxPerM: lo, padPx };
  return model.atlas;
}

// Flat typed arrays for rendering one LOD. Identical vertices are welded.
export function geoArrays(model, lodIndex) {
  const g = model.lod[lodIndex], { size, pxPerM } = model.atlas;
  const map = new Map(), remap = new Uint32Array(g.nv), pos = [], nrm = [], tan = [], uv = [];
  const q = (x) => Math.round(x * 1e5);
  let nv = 0;
  for (let i = 0; i < g.nv; i++) {
    const isl = model.islands[g.isl[i]];
    const u = (isl.px + g.f[i * 2] * pxPerM * isl.dens) / size, v = (isl.py + g.f[i * 2 + 1] * pxPerM * isl.dens) / size;
    const key = `${q(g.p[i * 3])},${q(g.p[i * 3 + 1])},${q(g.p[i * 3 + 2])},${q(g.n[i * 3])},${q(g.n[i * 3 + 1])},${q(g.n[i * 3 + 2])},${q(u)},${q(v)}`;
    let j = map.get(key);
    if (j === undefined) {
      j = nv++; map.set(key, j);
      pos.push(g.p[i * 3], g.p[i * 3 + 1], g.p[i * 3 + 2]); nrm.push(g.n[i * 3], g.n[i * 3 + 1], g.n[i * 3 + 2]);
      tan.push(g.t[i * 3], g.t[i * 3 + 1], g.t[i * 3 + 2], 1); uv.push(u, v);
    }
    remap[i] = j;
  }
  const idx = new Uint32Array(g.idx.length);
  for (let i = 0; i < idx.length; i++) idx[i] = remap[g.idx[i]];
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), tan: new Float32Array(tan), uv: new Float32Array(uv), idx, nv, ntri: idx.length / 3 };
}

// Flat typed arrays for the UV-space bake.
export function bakeArrays(model) {
  const { size, pxPerM } = model.atlas;
  let nv = 0, ni = 0;
  for (const isl of model.islands) { nv += isl.bnv; ni += isl.bidx.length; }
  const A = {
    uv: new Float32Array(nv * 2), pos: new Float32Array(nv * 3), nrm: new Float32Array(nv * 3), tan: new Float32Array(nv * 3),
    log: new Float32Array(nv * 3), rest: new Float32Array(nv * 3), face: new Float32Array(nv * 4), ids: new Float32Array(nv * 4), extra: new Float32Array(nv * 4),
    idx: new Uint32Array(ni), nv,
  };
  let v = 0, k = 0;
  for (const isl of model.islands) {
    const base = v;
    for (let i = 0; i < isl.bnv; i++, v++) {
      A.uv[v * 2] = (isl.px + isl.bf[i * 2] * pxPerM * isl.dens) / size;
      A.uv[v * 2 + 1] = (isl.py + isl.bf[i * 2 + 1] * pxPerM * isl.dens) / size;
      for (let j = 0; j < 3; j++) {
        A.pos[v * 3 + j] = isl.bp[i * 3 + j]; A.nrm[v * 3 + j] = isl.bn[i * 3 + j];
        A.tan[v * 3 + j] = isl.bt[i * 3 + j]; A.log[v * 3 + j] = isl.bl[i * 3 + j]; A.rest[v * 3 + j] = isl.br[i * 3 + j];
      }
      A.face.set((isl.bface && isl.bface[i]) || [isl.bf[i * 2], isl.bf[i * 2 + 1], isl.w, isl.h], v * 4);
      A.ids.set([isl.mat, (isl.seed % 65536) / 65536, isl.part, isl.dens], v * 4);
      A.extra.set(isl.extra, v * 4);
    }
    for (const i of isl.bidx) A.idx[k++] = base + i;
  }
  return A;
}

export function bounds(model, lodIndex = 0) {
  const p = model.lod[lodIndex].p, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let j = 0; j < 3; j++) { mn[j] = Math.min(mn[j], p[i + j]); mx[j] = Math.max(mx[j], p[i + j]); }
  return { min: mn, max: mx };
}
