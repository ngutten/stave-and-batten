// Where fallen pieces come to rest. Not physics: a height map of the ground
// and everything already lying on it. Each piece is dropped flat onto the map,
// tilted to rest on whatever is highest under its two ends and two edges, and
// then written into the map so the next piece can land on it.

import { cross, norm } from './model.js';

export function createGround(extent = 3, cell = 0.025) {
  const n = Math.ceil((2 * extent) / cell), hgt = new Float32Array(n * n), blocked = new Uint8Array(n * n);
  const ix = (x) => Math.floor((x + extent) / cell);
  const sample = (x, z) => { const i = ix(x), j = ix(z); if (i < 0 || j < 0 || i >= n || j >= n) return { h: 0, b: 0 }; const k = j * n + i; return { h: hgt[k], b: blocked[k] }; };
  // visit every cell whose centre lies inside an oriented rectangle
  const rectCells = (cx, cz, ux, uz, hl, hw, fn) => {
    const r = Math.hypot(hl, hw), i0 = Math.max(0, ix(cx - r)), i1 = Math.min(n - 1, ix(cx + r)), j0 = Math.max(0, ix(cz - r)), j1 = Math.min(n - 1, ix(cz + r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5) * cell - extent - cx, z = (j + 0.5) * cell - extent - cz, a = x * ux + z * uz, b = -x * uz + z * ux;
      if (Math.abs(a) <= hl && Math.abs(b) <= hw) fn(j * n + i, a, b);
    }
  };
  const G = {
    // something stands here: nothing may come to rest on it
    blockRect(cx, cz, ux, uz, hl, hw) { rectCells(cx, cz, ux, uz, hl, hw, (k) => { blocked[k] = 1; }); },
    blockDisc(cx, cz, r) { rectCells(cx, cz, 1, 0, r, r, (k, a, b) => { if (a * a + b * b <= r * r) blocked[k] = 1; }); },
    // a raised floor (the inside of a crate, the bottom head of a barrel)
    floorRect(cx, cz, ux, uz, hl, hw, h) { rectCells(cx, cz, ux, uz, hl, hw, (k) => { blocked[k] = 0; hgt[k] = Math.max(hgt[k], h); }); },
    floorDisc(cx, cz, r, h) { rectCells(cx, cz, 1, 0, r, r, (k, a, b) => { if (a * a + b * b <= r * r) { blocked[k] = 0; hgt[k] = Math.max(hgt[k], h); } }); },
    heightAt: (x, z) => sample(x, z).h,
    // something placed by other means lies here, about h high
    cover(cx, cz, yaw, L, W, h) { rectCells(cx, cz, Math.cos(yaw), Math.sin(yaw), L / 2, W / 2, (k) => { hgt[k] = Math.max(hgt[k], h); }); },

    // Rest a box (L along, W across, T thick) centred over (x, z), turned by yaw.
    // Returns its frame { c, ax, ay, az } with az upward, or null if it would
    // land on something standing.
    place(L, W, T, x, z, yaw, commit = true) {
      const ux = Math.cos(yaw), uz = Math.sin(yaw), NA = 7, NB = 3, hs = [];
      for (let i = 0; i < NA; i++) for (let j = 0; j < NB; j++) {
        const a = (i / (NA - 1) - 0.5) * L * 0.96, b = (j / (NB - 1) - 0.5) * W * 0.9, s = sample(x + a * ux - b * uz, z + a * uz + b * ux);
        if (s.b) return null;
        hs.push({ a, b, h: s.h });
      }
      const mx = (f) => Math.max(...hs.filter(f).map((q) => q.h));
      const hA = mx((q) => q.a < -L * 0.2), hB = mx((q) => q.a > L * 0.2), hL = mx((q) => q.b < -W * 0.2), hR = mx((q) => q.b > W * 0.2);
      const sp = Math.max(-0.75, Math.min(0.75, (hB - hA) / (L * 0.7))), sr = Math.max(-0.5, Math.min(0.5, (hR - hL) / (W * 0.7)));
      let y0 = -Infinity; for (const q of hs) y0 = Math.max(y0, q.h - sp * q.a - sr * q.b);
      const up = [0, 1, 0], axh = [ux, 0, uz], ayh = cross(up, axh);          // ayh points along -b
      const ax = norm([axh[0], sp, axh[2]]), ay0 = norm([ayh[0], -sr, ayh[2]]);
      const az = norm(cross(ax, ay0)), ay = cross(az, ax);
      const c = [x + az[0] * T / 2, y0 + az[1] * T / 2, z + az[2] * T / 2];
      if (commit) rectCells(x, z, ux, uz, L / 2, W / 2, (k, a, b) => { hgt[k] = Math.max(hgt[k], y0 + sp * a + sr * b + T / Math.max(0.5, az[1])); });
      return { c, ax, ay, az };
    },
    // Try near (x, z) first, then wander further out until it fits.
    find(L, W, T, x, z, yaw, R, tries = 14) {
      for (let i = 0; i < tries; i++) {
        const j = i * 0.06, f = G.place(L, W, T, x + R.sym(j), z + R.sym(j), yaw + R.sym(0.15 + i * 0.12));
        if (f) return f;
      }
      return null;
    },
  };
  return G;
}
