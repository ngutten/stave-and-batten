// A paper label pasted over battens is not a decal but a sheet of its own: it
// lies on whatever stands highest under it and is stretched taut across the
// steps and gaps between (Nich, 2026-11-20: "like an interpolating curve there
// for the stretch"). Built after the model, from the model's own LOD0 mesh.
//
// Height field: every LOD0 triangle that faces out of the target is rasterised
// into a grid over the label (max depth along the target normal, within the
// target's proud window). Paper then hangs from those supports like a taut
// sheet: P(p) = max over q of H(q) - k |p - q|^2, so it bridges a board gap
// and ramps down off a batten instead of following the step. Where it bridges
// it is stretched, and stretched paper tears first: torn cells are left out of
// the mesh (holes), at the mark's own wear. Weather ages its colour in the bake.
//
// The island carries mat PAPER and the mark's index in extra.x; the bake draws
// the label onto it and leaves the wood under it bare (mode 4).

import { addIsland, emitMesh, MAT, add, sub, mul, madd, cross, norm, dot } from './model.js';
import { rng } from './rng.js';

// SAG: the sheet falls away from a support as k*d^2 (a taut sheet barely dips over a 5 mm gap, and comes off
// a 22 mm batten within about 2.5 cm). LIFT keeps it clear of the arrises it is stretched over.
const STEP = 0.005, LIFT = 0.0009, SAG = 35, REACH = 0.035;

// value noise in two dimensions, for where it tears (the bake has its own for colour)
function noise2(seed) {
  const h = (x, y) => { let n = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0; n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

// mk: { target, x, y, size, rot, wear, aspect }, i: its slot. Returns the island or null.
export function addLabelSheet(model, mk, i, seed) {
  const tg = (model.targets || []).find((t) => t.id === mk.target);
  if (!tg || tg.kind !== 'plane') return null;
  const w = mk.size, h = mk.size / (mk.aspect || 1);
  const cx = mk.x * Math.max(0, tg.w - w) / 2, cy = mk.y * Math.max(0, tg.h - h) / 2, rot = (mk.rot || 0) * Math.PI / 180;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  // label frame in the target plane, turned as decalAt turns it: local x = cr*u + sr*v, y = -sr*u + cr*v
  const LX = add(mul(tg.u, cr), mul(tg.v, sr)), LY = add(mul(tg.u, -sr), mul(tg.v, cr)), N = tg.n;
  const C = add(add(tg.o, mul(tg.u, cx)), mul(tg.v, cy));
  const nx = Math.max(2, Math.round(w / STEP) + 1), ny = Math.max(2, Math.round(h / STEP) + 1);
  const gx = (ix) => -w / 2 + (w * ix) / (nx - 1), gy = (iy) => -h / 2 + (h * iy) / (ny - 1);
  const H = new Float32Array(nx * ny).fill(-1);
  const [dmin, dmax] = tg.proud;

  // 1. supports: rasterise the outward-facing LOD0 triangles
  const g = model.lod[0], P = g.p, I = g.idx;
  for (let t = 0; t < I.length; t += 3) {
    const v = [0, 1, 2].map((k) => { const j = I[t + k] * 3; const d = sub([P[j], P[j + 1], P[j + 2]], C); return [dot(d, LX), dot(d, LY), dot(d, N)]; });
    if (v.every((q) => q[2] < dmin || q[2] > dmax)) continue;
    const e1 = sub(v[1], v[0]), e2 = sub(v[2], v[0]), nz = e1[0] * e2[1] - e1[1] * e2[0];
    const tn = norm(cross(e1, e2));
    if (Math.abs(tn[2]) < 0.6) continue;                     // a side, not a face the paper could lie on
    const x0 = Math.max(0, Math.floor((Math.min(v[0][0], v[1][0], v[2][0]) + w / 2) / w * (nx - 1))), x1 = Math.min(nx - 1, Math.ceil((Math.max(v[0][0], v[1][0], v[2][0]) + w / 2) / w * (nx - 1)));
    const y0 = Math.max(0, Math.floor((Math.min(v[0][1], v[1][1], v[2][1]) + h / 2) / h * (ny - 1))), y1 = Math.min(ny - 1, Math.ceil((Math.max(v[0][1], v[1][1], v[2][1]) + h / 2) / h * (ny - 1)));
    if (Math.abs(nz) < 1e-12) continue;
    for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
      const px = gx(ix) - v[0][0], py = gy(iy) - v[0][1];
      const b1 = (px * e2[1] - py * e2[0]) / nz, b2 = (e1[0] * py - e1[1] * px) / nz;
      if (b1 < -1e-6 || b2 < -1e-6 || b1 + b2 > 1 + 1e-6) continue;
      const d = v[0][2] + b1 * e1[2] + b2 * e2[2];
      if (d < dmin || d > dmax) continue;
      const k = iy * nx + ix; if (d > H[k]) H[k] = d;
    }
  }
  // 2. the taut sheet: hang from the supports, never below them; nothing where no support is in reach
  const R = Math.ceil(REACH / STEP), Pz = new Float32Array(nx * ny).fill(-1);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    let best = -1;
    for (let dy = -R; dy <= R; dy++) { const y = iy + dy; if (y < 0 || y >= ny) continue;
      for (let dx = -R; dx <= R; dx++) { const x = ix + dx; if (x < 0 || x >= nx) continue;
        const hq = H[y * nx + x]; if (hq < -0.5) continue;
        const v = hq - SAG * STEP * STEP * (dx * dx + dy * dy); if (v > best) best = v; } }
    Pz[iy * nx + ix] = best;
  }
  // a little smoothing, so the ramps are curves; never below a support
  for (let pass = 0; pass < 2; pass++) {
    const Q = Pz.slice();
    for (let iy = 1; iy < ny - 1; iy++) for (let ix = 1; ix < nx - 1; ix++) {
      const k = iy * nx + ix; if (Q[k] < -0.5) continue;
      let s = 0, c = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const q = Q[k + dy * nx + dx]; if (q > -0.5) { s += q; c++; } }
      let hm = H[k]; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) hm = Math.max(hm, H[k + dy * nx + dx]);
      Pz[k] = Math.max(hm, s / c);
    }
  }
  // 3. where it tears: stretched paper first, and pieces, not specks. drive < 0.5 is paper; the mesh is
  // clipped along the 0.5 contour of this field, so a torn edge is a smooth line, not grid steps.
  const n1 = noise2(Math.floor(seed * 1000) + 31 * i), n2 = noise2(Math.floor(seed * 1000) + 57 * i + 7);
  const wear = mk.wear || 0, drive = new Float32Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const k = iy * nx + ix; if (Pz[k] < -0.5) { drive[k] = 2; continue; }
    const stretch = Math.min(1, Math.max(0, (Pz[k] - Math.max(H[k], -0.001)) / 0.004));      // off the surface it is resting on
    const blot = n1(gx(ix) * 30, gy(iy) * 30), fine = n2(gx(ix) * 70, gy(iy) * 70);
    const edge = Math.min(ix, nx - 1 - ix, iy, ny - 1 - iy) * STEP;
    drive[k] = wear * (0.2 + 1.7 * blot * blot) + stretch * wear * 1.6 + (1 - Math.min(1, edge / 0.02)) * wear * 0.6 + 0.14 * (fine - 0.5);
  }
  const isl = addIsland(model, { w, h, mat: MAT.PAPER, seed: rng(seed, 'label', i)(), extra: [i, 0, 0, 0], tag: 'label' });
  isl.U = LX; isl.V = LY; isl.N = N;
  isl.fOf = (p) => { const d = sub(p, C); return [dot(d, LX) + w / 2, dot(d, LY) + h / 2]; };
  const pos = (ix, iy) => madd(add(add(C, mul(LX, gx(ix))), mul(LY, gy(iy))), N, Pz[iy * nx + ix] + LIFT);
  const z = (ix, iy) => { const q = Pz[Math.min(ny - 1, Math.max(0, iy)) * nx + Math.min(nx - 1, Math.max(0, ix))]; return q < -0.5 ? Pz[iy * nx + ix] : q; };
  // a point of the sheet at fractional grid coordinates (fx, fy), on an edge of a cell
  const hAt = (fx, fy) => {
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    const q = (x, y) => Pz[y * nx + x];
    return (q(x0, y0) * (1 - tx) + q(x1, y0) * tx) * (1 - ty) + (q(x0, y1) * (1 - tx) + q(x1, y1) * tx) * ty;
  };
  const mesh = (sk) => {
    const verts = [], tris = [], cache = new Map();
    const vert = (fx, fy, dr) => {
      const key = Math.round(fx * 64) + ',' + Math.round(fy * 64); if (cache.has(key)) return cache.get(key);
      const ix = Math.round(fx), iy = Math.round(fy);
      const dzx = (z(ix + sk, iy) - z(ix - sk, iy)) / (2 * sk * STEP), dzy = (z(ix, iy + sk) - z(ix, iy - sk)) / (2 * sk * STEP);
      const n = norm(sub(sub(N, mul(LX, dzx)), mul(LY, dzy)));
      const x = -w / 2 + (w * fx) / (nx - 1), y = -h / 2 + (h * fy) / (ny - 1);
      const p = madd(add(add(C, mul(LX, x)), mul(LY, y)), N, hAt(fx, fy) + LIFT);
      // face.x carries how far inside the paper this point is (0 on a torn edge), for the bake's pale fibres
      verts.push({ p, n, t: norm(madd(LX, N, dzx)), f: [x + w / 2, y + h / 2], face: [Math.max(0, 0.5 - dr) * 0.02, 1, 2, 2], rest: p });
      cache.set(key, verts.length - 1); return verts.length - 1;
    };
    // clip a triangle of grid points against drive < 0.5 (one plane, linear along each edge)
    const clip = (pts) => {
      const out = [];
      for (let a = 0; a < 3; a++) {
        const P0 = pts[a], P1 = pts[(a + 1) % 3], in0 = P0[2] < 0.5, in1 = P1[2] < 0.5;
        if (in0) out.push(P0);
        if (in0 !== in1) { const t = (0.5 - P0[2]) / (P1[2] - P0[2]); out.push([P0[0] + (P1[0] - P0[0]) * t, P0[1] + (P1[1] - P0[1]) * t, 0.5]); }
      }
      return out;
    };
    const D = (x, y) => [x, y, drive[y * nx + x]];
    for (let iy = 0; iy + sk < ny; iy += sk) for (let ix = 0; ix + sk < nx; ix += sk) {
      const c4 = [D(ix, iy), D(ix + sk, iy), D(ix + sk, iy + sk), D(ix, iy + sk)];
      if (c4.some((q) => q[2] >= 1.5)) continue;                   // no paper reaches here
      if (c4.every((q) => q[2] >= 0.5)) continue;
      for (const tri of [[c4[0], c4[1], c4[2]], [c4[0], c4[2], c4[3]]]) {
        const poly = clip(tri); if (poly.length < 3) continue;
        const vi = poly.map((q) => vert(q[0], q[1], q[2]));
        for (let k = 1; k + 1 < vi.length; k++) tris.push([vi[0], vi[k], vi[k + 1]]);
      }
    }
    return { verts, tris };
  };
  const fine = mesh(1); emitMesh(model, isl, fine.verts, fine.tris, [0]);
  // the far level: the same sheet every 4th station (bake vertices only once, from the fine mesh)
  const coarse = mesh(4);
  model.lod.forEach((geo, li) => {
    if (li === 0) return;
    const gi = coarse.verts.map((v) => { geo.p.push(...v.p); geo.n.push(...v.n); geo.t.push(...v.t); geo.f.push(...v.f); geo.isl.push(isl.id); return geo.nv++; });
    for (const [a, b, c] of coarse.tris) {
      const gn = cross(sub(coarse.verts[b].p, coarse.verts[a].p), sub(coarse.verts[c].p, coarse.verts[a].p));
      if (dot(gn, coarse.verts[a].n) >= 0) geo.idx.push(gi[a], gi[b], gi[c]); else geo.idx.push(gi[a], gi[c], gi[b]);
    }
  });
  return isl;
}

// which marks become sheets: paper labels pasted over battens on a flat target
export const isSheet = (mk, model) => mk && mk.mode === 'label' && mk.over && (model.targets || []).some((t) => t.id === mk.target && t.kind === 'plane');
