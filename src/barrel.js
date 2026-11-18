// The barrel: quarter-sawn staves bent to a bilge curve (clear timber: a
// cooper will not use a stave with a knot in it, because knots leak), heads set in below
// the chime, iron hoops driven on from each end, and a bung in the bilge.
// Each stave is unrolled flat in the atlas at its true width, so the grain is
// not stretched where the barrel narrows.
//
// Damage follows what holds a barrel together. Hoops slip and then come off:
// one from below the bilge drops round the foot of the barrel, one from above
// can only leave over the top and lies beside it. Staves that lose every hoop
// at their upper end spring outward like petals; staves near a blow snap and
// are stove in; the head, with nothing gripping it, falls through.

import { rng } from './rng.js';
import { createModel, addSurface, addIsland, addPlank, emitMesh, MAT, FACE, add, sub, mul, madd, cross, norm, dot } from './model.js';
import { logFrame } from './wood.js';
import { ragged, damageField, rigid, frameMap, compose } from './damage.js';
import { createGround } from './settle.js';

export const BARREL_PARAMS = [
  { key: 'H', label: 'Height', min: 0.3, max: 1.6, step: 0.01, def: 0.92, unit: 'm', group: 'Size' },
  { key: 'bilge', label: 'Bilge diameter', min: 0.2, max: 1.2, step: 0.01, def: 0.66, unit: 'm', group: 'Size' },
  { key: 'head', label: 'Head / bilge', min: 0.6, max: 1.0, step: 0.01, def: 0.82, group: 'Size' },
  { key: 'staves', label: 'Staves', min: 8, max: 36, step: 1, def: 22, group: 'Cooperage' },
  { key: 'staveT', label: 'Stave thickness', min: 0.01, max: 0.05, step: 0.001, def: 0.024, unit: 'm', group: 'Cooperage' },
  { key: 'chime', label: 'Chime depth', min: 0.01, max: 0.08, step: 0.001, def: 0.032, unit: 'm', group: 'Cooperage' },
  { key: 'hoops', label: 'Hoops per end', min: 1, max: 4, step: 1, def: 3, group: 'Cooperage' },
  { key: 'hoopW', label: 'Hoop width', min: 0.015, max: 0.08, step: 0.001, def: 0.036, unit: 'm', group: 'Cooperage' },
  { key: 'bung', label: 'Bung', type: 'bool', def: true, group: 'Cooperage' },
  { key: 'slop', label: 'Cooper\'s slop', min: 0, max: 1, step: 0.01, def: 0.35, group: 'Cooperage' },
  { key: 'damage', label: 'Damage', min: 0, max: 1, step: 0.01, def: 0, group: 'Damage', hint: 'Hoops slip and fall, staves spring and snap, the head drops in' },
  { key: 'blows', label: 'Blows', min: 1, max: 4, step: 1, def: 2, group: 'Damage', hint: 'How many places it was hit' },
  { key: 'rubble', label: 'Debris left', min: 0, max: 1, step: 0.01, def: 0.75, group: 'Damage', hint: 'How much of what fell is still lying there' },
];
export function barrelDefaults() { const p = {}; for (const d of BARREL_PARAMS) p[d.key] = d.def; return p; }

const HOOP_AT = { 1: [0.06], 2: [0.035, 0.24], 3: [0.03, 0.15, 0.30], 4: [0.028, 0.12, 0.22, 0.33] };

export function buildBarrel(params, seed) {
  const P = Object.assign(barrelDefaults(), params);
  const m = createModel('barrel');
  const { H, staveT: T, chime, slop } = P;
  const rb = P.bilge / 2, rh = rb * P.head, N = Math.round(P.staves);
  const rOf = (y) => { const k = (2 * y) / H - 1; return rh + (rb - rh) * (1 - k * k); };
  const drOf = (y) => { const k = (2 * y) / H - 1; return -(rb - rh) * 2 * k * (2 / H); };
  // arc length along the profile
  const NS = 96, sTab = [0];
  for (let i = 1; i <= NS; i++) { const y0 = ((i - 1) / NS) * H, y1 = (i / NS) * H; sTab.push(sTab[i - 1] + Math.hypot(y1 - y0, rOf(y1) - rOf(y0))); }
  const S = sTab[NS];
  const sOf = (y) => { const x = Math.max(0, Math.min(NS, (y / H) * NS)), i = Math.min(NS - 1, Math.floor(x)); return sTab[i] + (sTab[i + 1] - sTab[i]) * (x - i); };
  const er = (th) => [Math.cos(th), 0, Math.sin(th)], et = (th) => [-Math.sin(th), 0, Math.cos(th)];
  const Y = [0, 1, 0], G = [0, -1, 0];
  const toLog = (lf, x, y, z) => add(add(madd(lf.o, lf.ax, x), mul(lf.ay, y)), mul(lf.az, z));
  const lerp = (a, b, t) => a + (b - a) * t;
  // piecewise-linear lookup over stations, v in 0..1
  const val = (arr, v) => { const x = Math.max(0, Math.min(arr.length - 1, v * (arr.length - 1))), i = Math.min(arr.length - 2, Math.floor(x)); return lerp(arr[i], arr[i + 1], x - i); };

  // ---------- where it was hit ----------
  const dmg = Math.max(0, Math.min(1, P.damage));
  const Rd = rng(seed, 'damage'), blows = [];
  for (let i = 0; i < Math.round(P.blows); i++) { const th = Rd.range(0, 6.283), y = Rd.range(0.3, 0.98) * H; blows.push([Math.cos(th) * rOf(y), y, Math.sin(th) * rOf(y)]); }
  const { damaged, hurt, near } = damageField(dmg, blows, Math.hypot(H, 2 * rb));

  // ---------- plan the hoops ----------
  const fr = HOOP_AT[Math.max(1, Math.min(4, Math.round(P.hoops)))], hoops = [], hoopT = 0.003;
  fr.forEach((f, k) => { for (const top of [true, false]) hoops.push({ y: top ? H - f * H : f * H, w: P.hoopW * (k === 0 ? 1.15 : 1), k, top }); });
  hoops.forEach((hp, hi) => {
    const R = rng(seed, 'hoop', hi); hp.R = R; hp.seed = R.seed(); hp.lap = R.range(0.15, 0.85);
    hp.tiltA = R.range(0, 6.28); hp.tilt = R.sym(0.012 * slop);
    // the nearest point of the hoop to a blow
    const nb = near([0, hp.y, 0]), a = Math.atan2(nb[2], nb[0]);
    const s = hurt([Math.cos(a) * rOf(hp.y), hp.y, Math.sin(a) * rOf(hp.y)], R()) - 0.18;
    hp.state = s <= 0 ? 0 : s < 0.2 ? 1 : 2;         // sound, slipped, off
    if (hp.state === 1) { hp.tilt += R.sym(0.05) + 0.02; hp.drop = hp.top ? 0 : R.range(0.005, 0.03); } else hp.drop = 0;
    hp.y0 = hp.y; hp.y -= hp.drop;
    hp.yAt = (th) => hp.y + hp.tilt * Math.cos(th - hp.tiltA) * (rOf(hp.y) + hoopT) * 2;
    hp.holds = hp.state < 2;
  });
  const holdHigh = hoops.filter((h) => h.top && h.holds), holdLow = hoops.filter((h) => !h.top && h.holds);
  const standing = holdHigh.length + holdLow.length > 0;         // with no hoop at all it is no longer a barrel
  const topOpen = damaged && holdHigh.length === 0;              // the upper ends are free to spring

  // ---------- staves ----------
  const R0 = rng(seed, 'staves');
  let ws = []; for (let i = 0; i < N; i++) ws.push(1 + R0.sym(0.25 * (0.3 + slop)));
  const tot = ws.reduce((a, b) => a + b, 0); ws = ws.map((w) => (w / tot) * Math.PI * 2);
  let th0 = R0.range(0, 6.28);
  const pieces = [];           // every stave piece that exists, for the hoop stains
  const fallenStaves = [], petals = [], loose = [];
  const staveInfo = [];
  const gapJ = 0.0006;         // staves do not quite touch at the surface

  // One piece of one stave. as: stations across (-1..1); yLo/yHi: where the
  // outer face ends at each station; yLoI/yHiI: the same for the inner face.
  function stavePiece(st, o) {
    const { thc, dth, lf, sd, wmax, part } = st, K = o.as.length - 1, xf = o.xf;
    const thOf = (a) => thc + (a * dth) / 2;
    const yMin = Math.min(...o.yLo, ...o.yLoI), yMax = Math.max(...o.yHi, ...o.yHiI), sMin = sOf(yMin), Sp = sOf(yMax) - sMin;
    const ny = (n) => Math.max(1, Math.round((n * (yMax - yMin)) / H));
    const Kl = o.ragLo || o.ragHi ? K : 1;
    const surf = (th, y, inner) => {
      const r = rOf(y) - (inner ? T : 0), dr = drOf(y), k = 1 / Math.hypot(1, dr), e = er(th), sg = inner ? -1 : 1;
      return { p: [e[0] * r, y, e[2] * r], n: [sg * e[0] * k, -sg * dr * k, sg * e[2] * k], t: [e[0] * dr * k, k, e[2] * dr * k] };
    };
    const P_ = (p) => (xf ? xf.p(p) : p), V_ = (v) => (xf ? xf.v(v) : v);
    // outer face
    const outer = addSurface(m, {
      w: Sp, h: wmax, seed: sd, part, tag: 'stave', extra: [1, 0, 1, 1], xf,          // the last 1: this is the face markings go on
      lodGrid: [[ny(8), K], [ny(4), Kl]], bakeGrid: [ny(12), K],
      fn: (u, v) => {
        const a = val(o.as, v), y0 = val(o.yLo, v), y1 = val(o.yHi, v), y = lerp(y0, y1, u), wl = dth * rOf(y), q = surf(thOf(a), y, false);
        return { ...q, f: [sOf(y) - sMin, wmax / 2 + (a * wl) / 2], face: [sOf(y) - sOf(y0), ((a + 1) / 2) * wl - gapJ, sOf(y1) - sOf(y0), wl - 2 * gapJ], l: toLog(lf, sOf(y) - S / 2, (a * wl) / 2, T / 2) };
      },
    });
    pieces.push({ isl: outer, st, yMin, yMax, sMin });
    // inner face: all of it once the barrel can be seen into, otherwise just the chime
    const inner = (yA, yB, tag) => {
      const a0 = Math.min(...yA), b0 = Math.max(...yB); if (b0 - a0 < 1e-4) return;
      addSurface(m, {
        w: sOf(b0) - sOf(a0), h: wmax, seed: sd, part, tag, extra: [1, 0, 1, 0], xf, dens: damaged ? 0.5 : 1,
        lodGrid: [[Math.max(1, Math.round((6 * (b0 - a0)) / H)), K], [Math.max(1, Math.round((3 * (b0 - a0)) / H)), Kl]],
        fn: (u, v) => {
          const a = val(o.as, 1 - v), y0 = val(yA, 1 - v), y1 = val(yB, 1 - v), y = lerp(y0, y1, u), wl = dth * rOf(y), q = surf(thOf(a), y, true);
          return { ...q, f: [sOf(y) - sOf(a0), wmax / 2 - (a * wl) / 2], face: [sOf(y) - sOf(y0), ((1 - a) / 2) * wl, sOf(y1) - sOf(y0), wl], l: toLog(lf, sOf(y) - S / 2, (a * wl) / 2, -T / 2) };
        },
      });
    };
    if (damaged) inner(o.yLoI, o.yHiI, 'staveIn');
    else { inner(o.yLoI.map(() => H - chime), o.yHiI, 'chime'); inner(o.yLoI, o.yHiI.map(() => chime), 'chime'); }
    // the two joint faces, seen only when a neighbour has moved
    if (damaged) for (const sgn of [-1, 1]) {
      const k = sgn < 0 ? 0 : K, th = thOf(o.as[k]), e = er(th), tt = et(th);
      addSurface(m, {
        w: Sp, h: T, seed: sd, part, tag: 'staveSide', extra: [0, 0, 1, 0], xf, dens: 0.5, lodGrid: [[ny(6), 1], [ny(3), 1]],
        fn: (u, v) => {
          const w = sgn > 0 ? v : 1 - v;                 // 0 at the outer face
          const y = lerp(lerp(o.yLo[k], o.yHi[k], u), lerp(o.yLoI[k], o.yHiI[k], u), w), r = rOf(y) - w * T, dr = drOf(y), kk = 1 / Math.hypot(1, dr);
          return { p: [e[0] * r, y, e[2] * r], n: mul(tt, sgn), t: [e[0] * dr * kk, kk, e[2] * dr * kk], f: [Math.max(0, Math.min(Sp, sOf(y) - sMin)), v * T], l: toLog(lf, sOf(y) - S / 2, (o.as[k] * dth * rOf(y)) / 2, T / 2 - w * T) };
        },
      });
    }
    // ends
    for (const top of [true, false]) {
      const yo = top ? o.yHi : o.yLo, yi = top ? o.yHiI : o.yLoI, rag = top ? o.ragHi : o.ragLo, sg = top ? 1 : -1;
      const pt = (k, inn) => { const y = inn ? yi[k] : yo[k], th = thOf(o.as[k]), e = er(th), r = rOf(y) - (inn ? T : 0); return { p: [e[0] * r, y, e[2] * r], y, wl: dth * rOf(y), a: o.as[k] }; };
      if (!rag) {
        // a sawn end: one quad of end grain
        const wl = dth * rOf(yo[0]);
        addSurface(m, {
          w: wl, h: T, seed: sd, part, tag: 'staveEnd', extra: [0, 0, 1, 0], xf, lodGrid: [[1, 1], [1, 1]],
          fn: (u, v) => {
            const a = u * 2 - 1, th = thOf(a), e = er(th), y = yo[0], re = rOf(y), rr = top ? re - T + v * T : re - v * T;
            return { p: [e[0] * rr, y, e[2] * rr], n: [0, sg, 0], t: et(th), f: [u * wl, v * T], l: toLog(lf, sOf(y) - S / 2, (a * wl) / 2, rr - re + T / 2) };
          },
        });
        continue;
      }
      // a break: one wall per gap between stations, each flat, each fresh wood
      const segs = [], lens = []; let total = 0;
      for (let k = 0; k < K; k++) { const A = pt(k, false), B = pt(k + 1, false), l = Math.hypot(((B.a - A.a) * A.wl) / 2, B.y - A.y); segs.push(k); lens.push(l); total += l; }
      const isl = addIsland(m, { w: total, h: T, seed: sd, part, tag: 'break', extra: [0, 1, 1, 0] });
      let s0 = 0;
      segs.forEach((k, i) => {
        const A = pt(k, false), B = pt(k + 1, false), Ai = pt(k, true), Bi = pt(k + 1, true);
        const thm = thOf((A.a + B.a) / 2), tm = et(thm);
        // outward in the unrolled stave: a polygon walked counter-clockwise has its outside on the right
        const d = top ? [((A.a - B.a) * A.wl) / 2, A.y - B.y] : [((B.a - A.a) * A.wl) / 2, B.y - A.y];
        const ref = add(mul(tm, d[1]), mul(Y, -d[0]));
        let gn = cross(sub(B.p, A.p), sub(Ai.p, A.p)); if (dot(gn, ref) < 0) gn = mul(gn, -1);
        const n = V_(norm(gn)), t = V_(norm(sub(B.p, A.p)));
        const lg = (q, z) => toLog(lf, sOf(q.y) - S / 2, (q.a * q.wl) / 2, z);
        emitMesh(m, isl, [
          { p: P_(A.p), rest: A.p, n, t, f: [s0, T], face: [0.5, T, 1, T], l: lg(A, T / 2) }, { p: P_(B.p), rest: B.p, n, t, f: [s0 + lens[i], T], face: [0.5, T, 1, T], l: lg(B, T / 2) },
          { p: P_(Bi.p), rest: Bi.p, n, t, f: [s0 + lens[i], 0], face: [0.5, 0, 1, T], l: lg(Bi, -T / 2) }, { p: P_(Ai.p), rest: Ai.p, n, t, f: [s0, 0], face: [0.5, 0, 1, T], l: lg(Ai, -T / 2) },
        ], [[0, 1, 2], [0, 2, 3]]);
        s0 += lens[i];
      });
    }
    return outer;
  }

  for (let i = 0; i < N; i++) {
    const R = rng(seed, 'stave', i), dth = ws[i], thc = th0 + dth / 2; th0 += dth;
    const st = { i, thc, dth, lf: logFrame(R, 'quarter'), sd: R.seed(), wmax: dth * rb, part: m.parts++ };
    staveInfo.push(st);
    const flat = (y) => [y, y, y];
    const whole = { as: [-1, 0, 1], yLo: flat(0), yHi: flat(H), yLoI: flat(0), yHiI: flat(H) };
    if (!damaged) { st.outer = stavePiece(st, whole); st.sound = true; continue; }
    const Rh = rng(seed, 'stavehurt', i), e = er(thc);
    const nb = near(mul(e, rb)), yb = Math.max(0.18 * H, Math.min(0.82 * H, nb[1] + Rh.sym(0.06)));
    // a barrel that simply falls apart breaks fewer staves than one that is beaten in
    const s = hurt([e[0] * rOf(yb), yb, e[2] * rOf(yb)], Rh()) - (standing ? 0 : 0.32);
    const hingeAt = (y) => [e[0] * rOf(y), y, e[2] * rOf(y)];
    const axis = et(thc);
    // rotation about the tangent: positive tips whatever is above the hinge outward
    const lean = (y, outAbove) => rigid(axis, -outAbove, hingeAt(y));
    const anyHold = (y0, y1) => hoops.some((h) => h.holds && h.y > y0 && h.y < y1);
    // the pieces this stave is in: whole, or snapped near the blow into a lower, an upper, and what was knocked out between
    let parts;
    if (s < 0.3) parts = [{ ...whole, lo: 0, hi: H, kind: 'whole' }];
    else {
      const k = s - 0.3, brk = ragged(Rh, st.wmax, T, { kMin: 2, kMax: 4, reach: 1.9 }), as = brk.ys.map((y) => y / (st.wmax / 2));
      const open = Math.min(1, k * 2.2) * H * 0.42;
      const topLo = yb + brk.max / 2 - open * Rh.range(0.4, 1.2), botHi = yb - brk.max / 2 + open * Rh.range(0.4, 1.2);
      const zero = as.map(() => 0), full = as.map(() => H);
      const upA = brk.top.map((x) => topLo - x), upB = brk.bot.map((x) => topLo - x), dnA = brk.top.map((x) => botHi + brk.max - x), dnB = brk.bot.map((x) => botHi + brk.max - x);
      parts = [];
      if (topLo - brk.max > 0.03) parts.push({ as, yLo: zero, yLoI: zero, yHi: upA, yHiI: upB, ragHi: true, lo: 0, hi: topLo - brk.max, kind: 'lower', k });
      if (H - botHi - brk.max > 0.03) parts.push({ as, yHi: full, yHiI: full, yLo: dnA, yLoI: dnB, ragLo: true, lo: botHi + brk.max, hi: H, kind: 'upper', k });
      if (botHi + brk.max - topLo > 0.05 && s < 0.8) parts.push({ as, yLo: upA, yLoI: upB, yHi: dnA, yHiI: dnB, ragLo: true, ragHi: true, lo: topLo, hi: botHi + brk.max, kind: 'mid', k });
    }

    if (!standing) {
      // Every hoop is off. The staves fall outward round the bottom head like
      // the petals of a flower, each rocking on its bilge; whatever snapped
      // off them lands among the petals.
      const beta = Rh.range(1.25, 1.6), yaw = Rh.sym(0.42), slide = Rh.range(0, 0.16);
      const base = compose(rigid(axis, -beta, hingeAt(0)), rigid(Y, yaw, hingeAt(0), mul(e, slide)));
      parts.forEach((pt, pi) => {
        if (rng(seed, 'petal', i, pi)() > P.rubble) return;
        if (pt.kind === 'upper' || pt.kind === 'mid') { loose.push({ st, pt, at: mul(e, rh + (pt.lo + pt.hi) * 0.5 * Rh.range(0.5, 0.95)), yaw: Math.atan2(e[2], e[0]) + Rh.sym(0.8) }); return; }
        // lift it until its lowest point touches the ground
        let low = Infinity, xf = base;
        for (let q = 0; q <= 10; q++) for (const a of [-1, 1]) for (const inn of [0, 1]) {
          const y = lerp(pt.lo, pt.hi, q / 10), th = thc + (a * dth) / 2, r = rOf(y) - inn * T;
          low = Math.min(low, xf.p([Math.cos(th) * r, y, Math.sin(th) * r])[1]);
        }
        xf = compose(xf, rigid(Y, 0, [0, 0, 0], [0, -low + 0.001, 0]));
        const o = stavePiece(st, { ...pt, xf }); if (pt.kind === 'whole') st.outer = o;
        // tell the ground it is there
        const ym = (pt.lo + pt.hi) / 2, mid = xf.p(hingeAt(ym)), dv = xf.v([0, 1, 0]);
        petals.push({ x: mid[0], z: mid[2], yaw: Math.atan2(dv[2], dv[0]), L: sOf(pt.hi) - sOf(pt.lo), W: st.wmax, h: T + 0.5 * Math.max(0, rOf(ym) - (rOf(pt.lo) + rOf(pt.hi)) / 2) });
      });
      continue;
    }

    const debris = (pt) => fallenStaves.push({ st, pt });
    for (const pt of parts) {
      if (pt.kind === 'whole') {
        if (s > 0.8) { debris(pt); continue; }                    // cannot happen below 0.3, kept for clarity
        // whole. If nothing grips its upper end it springs outward from the highest hoop that still holds.
        let xf = null;
        const topHold = holdHigh.length ? Math.max(...holdHigh.map((h) => h.y)) : null, lowHold = holdLow.length ? Math.min(...holdLow.map((h) => h.y)) : null;
        if (topOpen) { const hy = Math.max(...holdLow.map((h) => h.y)); xf = lean(hy, Rh.range(0.03, 0.2) * (0.5 + dmg)); }
        else if (s > 0.05) { const hy = lowHold !== null ? lowHold : topHold; xf = lean(hy, (hy < H / 2 ? 1 : -1) * Rh.range(0.004, 0.02)); }
        st.outer = stavePiece(st, { ...pt, xf }); st.sound = !xf;
      } else if (s > 0.8 || !anyHold(pt.lo, pt.hi) || pt.kind === 'mid') debris(pt);
      else if (pt.kind === 'lower') {
        const hy = Math.max(...hoops.filter((h) => h.holds && h.y < pt.hi).map((h) => h.y));
        stavePiece(st, { ...pt, xf: lean(hy, (topOpen ? 1 : -1) * Rh.range(0.02, 0.14) * Math.min(1, 0.4 + pt.k * 3)) });     // stove in
      } else {
        const hy = Math.min(...hoops.filter((h) => h.holds && h.y > pt.lo).map((h) => h.y));
        stavePiece(st, { ...pt, xf: lean(hy, Rh.range(0.02, 0.12) * Math.min(1, 0.4 + pt.k * 3)) });                          // its lower end swings inward
      }
    }
  }

  // ---------- staves that came away, and where they lie ----------
  for (const d of loose) fallenStaves.push(d);
  if (fallenStaves.length && P.rubble > 0) {
    const ground = createGround(rb * 2 + H + 1.5), Rr = rng(seed, 'rubble');
    if (standing) ground.blockDisc(0, 0, rb + 0.03); else ground.floorDisc(0, 0, rh, 0.03);
    for (const q of petals) ground.cover(q.x, q.z, q.yaw, q.L, q.W, q.h);
    fallenStaves.forEach((d) => { d.key = d.pt.hi - d.pt.lo + Rr.sym(0.1); });
    fallenStaves.sort((a, b) => b.key - a.key);
    for (const d of fallenStaves) {
      const { st, pt } = d, R = rng(seed, 'fall', st.i, Math.round(pt.lo * 1000));
      if (standing && R() > P.rubble) continue;
      const ym = (pt.lo + pt.hi) / 2, L = sOf(pt.hi) - sOf(pt.lo), sag = Math.max(0, rOf(ym) - (rOf(pt.lo) + rOf(pt.hi)) / 2), Te = T + sag;
      const e = er(st.thc), dr = drOf(ym), k = 1 / Math.hypot(1, dr);
      const A = { o: [e[0] * rOf(ym), ym, e[2] * rOf(ym)], x: [e[0] * dr * k, k, e[2] * dr * k], y: et(st.thc) }; A.z = cross(A.x, A.y);
      let x, z, yaw;
      if (d.at) { x = d.at[0]; z = d.at[2]; yaw = d.yaw; }
      else {
        // toppled outward to lie along a radius, or knocked sideways to lie across it
        const radial = R.chance(0.65), dist = rb + 0.06 + (radial ? L * R.range(0.4, 0.75) : st.wmax / 2 + R.range(0.03, 0.3));
        x = e[0] * dist; z = e[2] * dist; yaw = Math.atan2(e[2], e[0]) + (radial ? 0 : Math.PI / 2) + R.sym(0.5);
      }
      const f = ground.find(L, st.wmax, Te, x, z, yaw, R);
      if (!f) continue;
      const up = R.chance(0.5);        // arched over on its two ends, or rocking on its back
      const B = up ? { o: madd(f.c, f.az, Te / 2), x: f.ax, y: f.ay, z: f.az } : { o: madd(f.c, f.az, -Te / 2), x: f.ax, y: mul(f.ay, -1), z: mul(f.az, -1) };
      const i0 = m.islands.length;
      stavePiece(st, { ...pt, xf: frameMap(A, B) });
      for (let i = i0; i < m.islands.length; i++) m.islands[i].loose = true;
    }
  }

  // ---------- heads ----------
  const headT = Math.min(0.022, T * 0.9);
  for (const top of [true, false]) {
    const down = damaged && !standing;                                            // the whole barrel is on the ground
    const yh = top ? H - chime : down ? 0 : chime, Rh = rOf(top ? H - chime : chime) - T * 0.6;
    const Rb = rng(seed, 'head', top ? 1 : 0);
    const nb = Math.max(2, Math.round((2 * Rh) / 0.13));
    let hw = []; for (let i = 0; i < nb; i++) hw.push(1 + Rb.sym(0.25)); const ht = hw.reduce((a, b) => a + b, 0); hw = hw.map((w) => (w / ht) * 2 * Rh);
    const rot = Rb.range(0, Math.PI), ca = Math.cos(rot), sa = Math.sin(rot);     // the two heads are not aligned
    const zdir = [-sa, 0, ca], xdir = [ca, 0, sa];
    const fallen = top && damaged && (topOpen || !standing);                      // nothing grips it: it drops to the bottom
    let x0 = -Rh;
    for (let i = 0; i < nb; i++) {
      const bw = hw[i], xa = Math.max(x0, -Rh * 0.992), xb = Math.min(x0 + bw, Rh * 0.992); x0 += bw;
      const R = rng(seed, 'headboard', top ? 1 : 0, i), lf = logFrame(R, R.chance(0.6) ? 'quarter' : 'flat'), sd = R.seed();
      const chord = (x) => Math.sqrt(Math.max(Rh * Rh - x * x, 0)), cmax = Math.max(chord(xa), chord(xb), xa < 0 && xb > 0 ? Rh : 0);
      const Kc = 4, xs = Array.from({ length: Kc + 1 }, (_, k) => xa + ((xb - xa) * k) / Kc), xc = (xa + xb) / 2;
      // outside face of the board is +z of the plank: up for the top head, down for the bottom
      const az0 = top ? Y : mul(Y, -1), ax0 = zdir, ay0 = cross(az0, ax0), sgy = dot(ay0, xdir);
      const order = sgy > 0 ? xs : xs.slice().reverse();
      const cut = { top: order.map((x) => cmax - chord(x)), bot: order.map((x) => cmax - chord(x)) };
      let c = add(mul(xdir, xc), [0, yh - (top ? headT / 2 : -headT / 2), 0]), ax = ax0, az = az0;
      const rest = { c: add(mul(xdir, xc), [0, (top ? H - chime - headT / 2 : chime + headT / 2), 0]), ax: ax0, ay: ay0, az: az0 };
      if (top && damaged) {
        const Rhh = rng(seed, 'headhurt', i), s = hurt(add(mul(xdir, xc), [0, yh, 0]), Rhh()) - 0.08;
        if (fallen) {
          // lying where it landed on the bottom head, each board a little askew
          const tip = Rhh.sym(0.16), yaw = Rhh.sym(0.25);
          ax = norm(add(add(mul(zdir, Math.cos(yaw)), mul(xdir, Math.sin(yaw))), mul(Y, tip)));
          az = norm(cross(cross(ax, Y), ax));
          if (down && Rhh() > P.rubble) continue;
          c = add(mul(xdir, xc * 0.9 + Rhh.sym(down ? 0.12 : 0.02)), [0, (down ? 0 : chime) + headT * (1.6 + i * 0.7) + Math.abs(tip) * cmax, 0]);
        } else if (s > 0.3) continue;                    // knocked through
        else if (s > 0) {
          // one end has dropped into the barrel
          const phi = Rhh.range(0.08, 0.5) * Math.min(1, s * 5), sgn = Rhh.chance(0.5) ? 1 : -1;
          ax = norm(add(mul(zdir, Math.cos(phi)), mul(Y, -sgn * Math.sin(phi)))); az = norm(cross(cross(ax, Y), ax));
          c = add(add(mul(xdir, xc), [0, yh - headT / 2, 0]), add(mul(zdir, -sgn * cmax), mul(ax, sgn * cmax)));
        }
      }
      addPlank(m, {
        c, ax, ay: cross(az, ax), az, L: 2 * cmax, W: xb - xa, T: headT, seed: sd, log: lf, rest, tag: 'head', extra: [1, 0, 1, 0],
        left: cut, right: cut, stations: order.map((x) => (x - xc) * sgy), cutEnds: true,
        mask: damaged ? FACE.ALL : FACE.PZ, lowMask: FACE.NZ | FACE.PY | FACE.NY | FACE.PX | FACE.NX,
      });
    }
  }

  // ---------- hoops ----------
  hoops.forEach((hp) => {
    if (hp.state === 2 && !damaged) return;
    const R = hp.R, rc = rOf(hp.y) + hoopT, Lc = 2 * Math.PI * rc;
    let xf = null;
    if (hp.state === 2) {
      // off the barrel. From below the bilge it drops round the foot; from above it can only have come off over the top.
      const phi = R.range(0, 6.283), dirv = [Math.cos(phi), 0, Math.sin(phi)], down = [0, -(hp.y - hp.w / 2) + 0.002, 0];
      const tip = R.sym(0.04);
      if (!hp.top && standing) xf = rigid(cross(dirv, Y), tip, [0, hp.y, 0], add(down, mul(dirv, Math.max(0, rc - rOf(0) - hoopT * 2 - 0.004))));
      else if (standing) xf = rigid(cross(dirv, Y), tip, [0, hp.y, 0], add(down, mul(dirv, rb + rc + R.range(0.03, 0.2))));
      else { if (R() > P.rubble) return; xf = rigid(cross(dirv, Y), tip * 1.5, [0, hp.y, 0], add(add(down, [0, T + (rb - rh) * 0.55 + hp.k * 0.012 + (hp.top ? 0.02 : 0), 0]), mul(dirv, R.range(0, 0.16)))); }
    }
    const band = (inner) => addSurface(m, {
      w: Lc, h: hp.w, mat: MAT.IRON, seed: hp.seed, tag: 'hoop', extra: [hp.lap * Lc, inner ? 0 : 1, 0, 0], xf, dens: inner ? 0.5 : 1,
      lodGrid: inner ? [[32, 1], [16, 1]] : [[48, 3], [24, 1]], bakeGrid: inner ? [32, 1] : [48, 3],
      fn: (u, v, lod) => {
        const th = (inner ? -u : u) * Math.PI * 2, vv = inner ? v : v < 0.2 ? 0 : v > 0.8 ? 1 : v < 0.5 ? 0.14 : 0.86;
        const edge = vv === 0 || vv === 1;
        const y = hp.yAt(th) + hp.w / 2 - vv * hp.w, dr = drOf(y), k = 1 / Math.hypot(1, dr), e = er(th);
        const off = inner ? hoopT * 0.45 : lod === 1 ? hoopT + 0.003 : edge ? hoopT * 0.5 : hoopT, r = rOf(y) + off;
        let n = [e[0] * k, -dr * k, e[2] * k];
        if (inner) n = mul(n, -1); else if (edge && lod !== 1) n = norm([n[0], n[1] + (vv === 0 ? 0.9 : -0.9), n[2]]);
        return { p: [e[0] * r, y, e[2] * r], n, t: mul(et(th), inner ? -1 : 1), f: [u * Lc, vv * hp.w] };
      },
    });
    const i0 = m.islands.length;
    band(false);
    if (damaged) band(true);
    if (hp.state === 2) for (let i = i0; i < m.islands.length; i++) m.islands[i].loose = true;
  });

  // rust creeps out of each hoop into the staves beneath it, and stays when the hoop has gone
  for (const pc of pieces) for (const hp of hoops) {
    const y = hp.y0; if (y < pc.yMin - 0.05 || y > pc.yMax + 0.05) continue;
    const R = rng(seed, 'stain', pc.st.i, hp.k, hp.top ? 1 : 0);
    m.stamps.push({ type: 'band', isl: pc.isl.id, f: [sOf(y) - pc.sMin, pc.st.wmax / 2], half: hp.w / 2, width: pc.st.wmax, seed: R(), g: [-1, 0] });
  }

  // ---------- bung ----------
  const Rg = rng(seed, 'bung'), bst = staveInfo[Rg.int(0, N - 1)];
  if (P.bung && bst.sound) {
    const R = Rg, th = bst.thc, yb = H / 2 + R.sym(0.01);
    const rad = Math.min(0.024, bst.wmax * 0.3), prot = 0.011 + R.range(0, 0.006), e = er(th), tt = et(th);
    const C = [e[0] * rOf(yb), yb, e[2] * rOf(yb)], lf = logFrame(R, 'flat'), sd = R.seed(), part = m.parts++;
    // its grain runs along its axis, so the face you see is end grain
    const lg = (p) => { const d = [p[0] - C[0], p[1] - yb, p[2] - C[2]]; return toLog(lf, d[0] * e[0] + d[2] * e[2], d[0] * tt[0] + d[2] * tt[2], d[1]); };
    addSurface(m, {
      w: 2 * Math.PI * rad, h: prot + 0.004, seed: sd, part, tag: 'bung', lodGrid: [[8, 1], [6, 1]],
      fn: (u, v) => {
        const ph = -u * Math.PI * 2, dirv = add(mul(tt, Math.cos(ph)), mul(Y, Math.sin(ph)));
        const p = add(add(C, mul(dirv, rad * (1 - 0.06 * v))), mul(e, -0.004 + v * (prot + 0.004)));
        return { p, n: dirv, t: add(mul(tt, Math.sin(ph)), mul(Y, -Math.cos(ph))), f: [u * 2 * Math.PI * rad, v * (prot + 0.004)], face: [0.5, v * (prot + 0.004) + 0.5, 1, 1], l: lg(p) };
      },
    });
    addSurface(m, {
      w: 2 * rad, h: 2 * rad, seed: sd, part, tag: 'bung', lodGrid: [[2, 2], [2, 2]],
      fn: (u, v) => {
        const a = u * 2 - 1, b = v * 2 - 1, dx = a * Math.sqrt(1 - (b * b) / 2), dy = b * Math.sqrt(1 - (a * a) / 2), rr = rad * 0.94;
        const p = add(add(add(C, mul(e, prot)), mul(tt, -dx * rr)), mul(Y, dy * rr));
        return { p, n: e, t: mul(tt, -1), f: [(dx + 1) * rad, (dy + 1) * rad], face: [0.5, 0.5, 1, 1], l: lg(p) };
      },
    });
  }
  // where markings can go: round the bilge, or on the top head
  m.targets = [
    { id: 'side', label: 'Side', kind: 'cyl', o: [0, H / 2, 0], u: [1, 0, 0], v: Y, n: [0, 0, 1], w: 2 * Math.PI * rb, h: H, skin: [-0.002, 0.0015], proud: [-0.002, 0.006], cyl: [rh, rb, H] },
    { id: 'head', label: 'Head', kind: 'plane', o: [0, H - chime, 0], u: [1, 0, 0], v: [0, 0, -1], n: Y, w: 2 * rOf(H - chime), h: 2 * rOf(H - chime), skin: [-0.003, 0.003], proud: [-0.003, 0.003] },
  ];
  // The far level of detail: a ten-sided prism following the bilge, a lid, and
  // (once it can be seen into) the bottom head from above. See lod2.js.
  {
    const NS2 = 10, pad = hoopT + 0.002, cards = [], cs = Math.cos(Math.PI / NS2);
    // the bilge bulges out past the flat facets, so the photograph must start in front of them
    const ring = (y) => (rOf(y) + pad) / cs, ys = [0, H / 2, H], out = damaged ? 0.22 : (rb - rh) * 0.3 + 0.01;
    if (!damaged || standing) {
      for (let k = 0; k < NS2; k++) for (let j = 0; j < 2; j++) {
        const a0 = (k / NS2) * 2 * Math.PI, a1 = ((k + 1) / NS2) * 2 * Math.PI, am = (a0 + a1) / 2;
        const pt = (a, y) => [Math.cos(a) * ring(y), y, Math.sin(a) * ring(y)];
        // seen from outside, angle increases to the left
        const pts = [pt(a1, ys[j]), pt(a0, ys[j]), pt(a0, ys[j + 1]), pt(a1, ys[j + 1])];
        const dr = ring(ys[j + 1]) - ring(ys[j]), dy = ys[j + 1] - ys[j], kk = 1 / Math.hypot(dr * cs, dy);
        cards.push({ name: 'side', n: [Math.cos(am) * dy * kk, -dr * cs * kk, Math.sin(am) * dy * kk], pts, in: rb * 0.3, out });
      }
      const disc = (y, r) => Array.from({ length: NS2 }, (_, k) => { const a = -(k / NS2) * 2 * Math.PI; return [Math.cos(a) * r, y, Math.sin(a) * r]; });
      cards.push({ name: 'top', n: [0, 1, 0], pts: disc(H, ring(H)), in: chime + 0.03, out });
      if (damaged) cards.push({ name: 'floor', n: [0, 1, 0], pts: disc(chime + headT, (rOf(chime) - T) / cs), in: headT + 0.01, out: Math.min(0.3, H * 0.35) });
    }
    m.proxy = { cards, allLoose: damaged && !standing };
  }
  m.wrap = rb;
  m.params = P; m.seed = seed; m.G = G;
  return m;
}
