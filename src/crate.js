// The batten crate: six sheathed panels, each framed on the outside with
// battens. Frames lap over one another at the corners the way a joiner would
// do it: top and bottom over front and back, front and back over the sides.
// Nails go where a batten actually crosses a board.
//
// Damage is a single dial. Blows land at seeded points on the crate; every
// board and batten has its own toughness, so as the dial rises the same
// pieces fail in the same order: first they work loose, then boards snap and
// are stove in, battens hang by one nail, break, and come away, leaving the
// clean ghost of where they sat and the holes their nails left.

import { rng } from './rng.js';
import { createModel, addBox, addPlank, addSolidBox, FACE, add, sub, mul, madd, cross, norm, dot, len } from './model.js';
import { logFrame } from './wood.js';
import { ragged, mirrorBreak, damageField } from './damage.js';
import { createGround } from './settle.js';

export const CRATE_PARAMS = [
  { key: 'W', label: 'Width', min: 0.3, max: 2.0, step: 0.01, def: 0.9, unit: 'm', group: 'Size' },
  { key: 'H', label: 'Height', min: 0.2, max: 2.0, step: 0.01, def: 0.72, unit: 'm', group: 'Size' },
  { key: 'D', label: 'Depth', min: 0.3, max: 2.0, step: 0.01, def: 0.7, unit: 'm', group: 'Size' },
  { key: 'boardW', label: 'Board width', min: 0.05, max: 0.3, step: 0.005, def: 0.115, unit: 'm', group: 'Joinery' },
  { key: 'boardT', label: 'Board thickness', min: 0.008, max: 0.04, step: 0.001, def: 0.018, unit: 'm', group: 'Joinery' },
  { key: 'gap', label: 'Board gap', min: 0, max: 0.012, step: 0.0005, def: 0.002, unit: 'm', group: 'Joinery' },
  { key: 'battenW', label: 'Batten width', min: 0.03, max: 0.2, step: 0.005, def: 0.085, unit: 'm', group: 'Joinery' },
  { key: 'battenT', label: 'Batten thickness', min: 0.008, max: 0.05, step: 0.001, def: 0.022, unit: 'm', group: 'Joinery' },
  { key: 'brace', label: 'Bracing', options: ['none', 'diagonal', 'chevron', 'mid rail'], def: 'diagonal', group: 'Joinery' },
  { key: 'plain', label: 'Plain face', options: ['none', 'front', 'back', 'left', 'right'], def: 'none', group: 'Joinery', hint: 'Leave the brace off one wall, so a label has clear boards to go on' },
  { key: 'sideBoards', label: 'Side boards', options: ['vertical', 'horizontal'], def: 'vertical', group: 'Joinery' },
  { key: 'slop', label: 'Carpenter\'s slop', min: 0, max: 1, step: 0.01, def: 0.35, group: 'Joinery' },
  { key: 'bevel', label: 'Edge chamfer', min: 0, max: 0.006, step: 0.0005, def: 0.0025, unit: 'm', group: 'Joinery' },
  { key: 'damage', label: 'Damage', min: 0, max: 1, step: 0.01, def: 0, group: 'Damage', hint: 'Loose, then snapped and stove in, then torn away' },
  { key: 'blows', label: 'Blows', min: 1, max: 4, step: 1, def: 2, group: 'Damage', hint: 'How many places it was hit' },
  { key: 'rubble', label: 'Debris left', min: 0, max: 1, step: 0.01, def: 0.75, group: 'Damage', hint: 'How much of what fell is still lying there' },
];

export function crateDefaults() { const p = {}; for (const d of CRATE_PARAMS) p[d.key] = d.def; return p; }

export function buildCrate(params, seed) {
  const P = Object.assign(crateDefaults(), params);
  const m = createModel('crate');
  const { W, H, D, boardT: t, battenW: bw, battenT: bt, gap, bevel, slop } = P;
  const yb = bt, yt = bt + H, ym = (yb + yt) / 2;
  const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1], ng = (v) => mul(v, -1);
  const side = P.sideBoards === 'vertical' ? 'v' : 'u';
  const dmg = Math.max(0, Math.min(1, P.damage)), damaged = dmg > 0.001;
  const diag = Math.hypot(W, H, D);

  // u x v = n for every panel
  const panels = [
    { name: 'front', c: [0, ym, D / 2], u: X, v: Y, n: Z, pw: W, ph: H - 2 * t, bu: W / 2 + bt, bv: H / 2, along: side, ends: true, flip: 0, wall: true },
    { name: 'back', c: [0, ym, -D / 2], u: ng(X), v: Y, n: ng(Z), pw: W, ph: H - 2 * t, bu: W / 2 + bt, bv: H / 2, along: side, ends: true, flip: 1, wall: true },
    { name: 'right', c: [W / 2, ym, 0], u: ng(Z), v: Y, n: X, pw: D - 2 * t, ph: H - 2 * t, bu: D / 2, bv: H / 2, along: side, ends: false, flip: 1, wall: true },
    { name: 'left', c: [-W / 2, ym, 0], u: Z, v: Y, n: ng(X), pw: D - 2 * t, ph: H - 2 * t, bu: D / 2, bv: H / 2, along: side, ends: false, flip: 0, wall: true },
    { name: 'top', c: [0, yt, 0], u: X, v: ng(Z), n: Y, pw: W, ph: D, bu: W / 2 + bt, bv: D / 2 + bt, along: 'u', ends: true, flip: 0, wall: false },
    { name: 'bottom', c: [0, yb, 0], u: X, v: Z, n: ng(Y), pw: W, ph: D, bu: W / 2 + bt, bv: D / 2 + bt, along: 'u', ends: true, flip: 1, wall: false },
  ];

  // where the blows landed: never the bottom
  const Rd = rng(seed, 'damage'), blows = [];
  for (let i = 0; i < Math.round(P.blows); i++) {
    const pn = panels[Rd.int(0, 4)];
    blows.push(add(madd(pn.c, pn.u, Rd.sym(pn.pw * 0.42)), mul(pn.v, Rd.sym(pn.ph * 0.42))));
  }
  const { hurt } = damageField(dmg, blows, diag);

  // dark liner just under the skin so gaps read as gaps (an intact crate has no inside)
  if (!damaged) addSolidBox(m, [0, ym, 0], [W - t * 1.2, H - t * 1.2, D - t * 1.2]);

  const G = [0, -1, 0];
  let wallsDown = 0;
  const debris = [];        // what has come away: { L, W, T, home, out, along, spec }
  const inIsl = (isl, v3) => [dot(v3, isl.U), dot(v3, isl.V)];
  const BOARD_IN = FACE.NZ | FACE.PY | FACE.NY | FACE.PX | FACE.NX;

  for (const pn of panels) {
    const R = rng(seed, 'panel', pn.name);
    const at = (pu, pv, pz) => add(add(madd(pn.c, pn.u, pu), mul(pn.v, pv)), mul(pn.n, pz));
    const isBottom = pn.name === 'bottom';
    const alongV = pn.along === 'v';
    const { bu, bv } = pn;

    // ---------- plan the battens ----------
    const sides = FACE.PZ | FACE.PY | FACE.NY, endsM = pn.ends ? FACE.PX | FACE.NX : 0;
    const battens = [
      { name: 'railTop', u0: -bu, u1: bu, v0: bv - bw, v1: bv, hor: true, mask: sides | endsM },
      { name: 'railBot', u0: -bu, u1: bu, v0: -bv, v1: -bv + bw, hor: true, mask: sides | endsM },
      { name: 'stileL', u0: -bu, u1: -bu + bw, v0: -bv + bw, v1: bv - bw, hor: false, mask: sides },
      { name: 'stileR', u0: bu - bw, u1: bu, v0: -bv + bw, v1: bv - bw, hor: false, mask: sides },
    ];
    const iu0 = -bu + bw, iu1 = bu - bw, iv0 = -bv + bw, iv1 = bv - bw;
    const braced = pn.name !== P.plain;                     // a plain face keeps its frame but no brace, for a label
    if (braced && P.brace === 'mid rail' && pn.wall) {
      battens.push(alongV ? { name: 'mid', u0: iu0, u1: iu1, v0: -bw / 2, v1: bw / 2, hor: true, mask: sides } : { name: 'mid', u0: -bw / 2, u1: bw / 2, v0: iv0, v1: iv1, hor: false, mask: sides });
    } else if (braced && (P.brace === 'diagonal' || P.brace === 'chevron') && !isBottom && iu1 - iu0 > bw * 1.5 && iv1 - iv0 > bw * 1.5) {
      // A brace cut to sit between the stiles: its lower edge meets one inner
      // corner and its upper edge the opposite one. Solve the angle by iteration.
      const dir = (P.brace === 'chevron' ? pn.flip : 0) ? -1 : 1, du = iu1 - iu0;
      let th = Math.atan2(iv1 - iv0, du);
      for (let k = 0; k < 8; k++) th = Math.atan2(iv1 - iv0 - bw / Math.cos(th), du);
      if (iv1 - iv0 - bw / Math.cos(th) > 0) battens.push({ name: 'brace', theta: dir > 0 ? th : -th, L: du / Math.cos(th), cu: (iu0 + iu1) / 2, cv: (iv0 + iv1) / 2, mask: sides });
    }
    for (const b of battens) {
      const Rb = rng(seed, 'batten', pn.name, b.name);
      if (b.theta !== undefined) { b.dirU = [Math.cos(b.theta), Math.sin(b.theta)]; b.len = b.L; b.wid = bw; }
      else { b.cu = (b.u0 + b.u1) / 2; b.cv = (b.v0 + b.v1) / 2; b.dirU = b.hor ? [1, 0] : [0, 1]; b.len = b.hor ? b.u1 - b.u0 : b.v1 - b.v0; b.wid = b.hor ? b.v1 - b.v0 : b.u1 - b.u0; }
      b.seed = Rb.seed(); b.lf = logFrame(Rb, 'flat'); b.R = Rb;
      // state: 0 sound, 1 loose, 2 hanging by one end, 3 broken to a stub, 4 gone
      const s = isBottom ? -1 : hurt(at(b.cu, b.cv, bt / 2), Rb()) - 0.25;
      b.hurt = s;
      b.state = s <= 0 ? 0 : s < 0.16 ? 1 : s < 0.42 ? (pn.wall && Rb.chance(0.55) ? 2 : 3) : 4;
      if (b.state === 3 && b.theta !== undefined) b.state = pn.wall ? 2 : 4;      // a mitred brace does not leave a tidy stub
      // which end still holds: the one further from the nearest blow
      const e0 = at(b.cu - b.dirU[0] * b.len / 2, b.cv - b.dirU[1] * b.len / 2, 0), e1 = at(b.cu + b.dirU[0] * b.len / 2, b.cv + b.dirU[1] * b.len / 2, 0);
      const near = (p) => Math.min(...blows.map((q) => len(sub(p, q))));
      b.keep = near(e0) > near(e1) ? -1 : 1;
      if (b.state === 2 && Math.abs(e0[1] - e1[1]) > 0.02) b.keep = e0[1] > e1[1] ? -1 : 1;      // it hangs from its upper end
      // a broken batten keeps a stub at the end that held
      if (b.state === 3) {
        b.brk = ragged(Rb, b.wid, bt);
        const keepLen = Math.max(b.brk.max + 0.03, b.len * Rb.range(0.18, 0.5));
        b.a0 = b.keep < 0 ? -b.len / 2 : b.len / 2 - keepLen; b.a1 = b.a0 + keepLen;
      }
      // does it still pin down whatever lies under the point (pu, pv)?
      b.holds = (pu, pv) => {
        if (b.state <= 1) return true;
        if (b.state !== 3) return false;
        const a = (pu - b.cu) * b.dirU[0] + (pv - b.cv) * b.dirU[1];
        return a > b.a0 && a < b.a1 - b.brk.max;
      };
    }
    // A panel is held together by its frame. With fewer than two of the four
    // members still fast, the whole panel comes down; and a lid with no walls
    // under it has nothing to sit on.
    const frame = battens.filter((b) => b.name !== 'brace' && b.name !== 'mid');
    let collapsed = damaged && !isBottom && frame.filter((b) => b.state <= 1).length < 2;
    if (pn.name === 'top' && wallsDown >= 3) collapsed = true;
    if (collapsed) { for (const b of battens) { b.state = 4; b.gone = true; b.holds = () => false; } if (pn.wall) wallsDown++; }
    pn.collapsed = collapsed;
    const byName = Object.fromEntries(battens.map((b) => [b.name, b]));

    // ---------- sheathing ----------
    const span = alongV ? pn.pw : pn.ph, run = alongV ? pn.ph : pn.pw;
    const nb = Math.max(1, Math.round(span / P.boardW));
    let ws = []; for (let i = 0; i < nb; i++) ws.push(1 + R.sym(0.22 * (0.3 + slop)));
    const tot = ws.reduce((a, b) => a + b, 0); ws = ws.map((w) => (w / tot) * span);
    const dir = alongV ? pn.v : pn.u, acr = alongV ? pn.u : pn.v;
    const holdLo = byName[alongV ? 'railBot' : 'stileL'], holdHi = byName[alongV ? 'railTop' : 'stileR'];
    const boards = [];       // { rect, faces: [island of each outer face that exists] }
    let pos = -span / 2;
    for (let i = 0; i < nb; i++) {
      const w = ws[i], cen = pos + w / 2; pos += w;
      const Rb = rng(seed, 'board', pn.name, i);
      let proud = Rb.sym(0.0012 * slop), skew = Rb.sym(0.004 * slop);
      const sd = Rb.seed(), lf = logFrame(Rb, 'flat'), L = run - Rb.range(0, 0.004) * slop, Wd = w - gap;
      const c0 = alongV ? at(cen, 0, 0) : at(0, cen, 0);
      const rect = alongV ? { u0: cen - w / 2, u1: cen + w / 2, v0: -run / 2, v1: run / 2 } : { u0: -run / 2, u1: run / 2, v0: cen - w / 2, v1: cen + w / 2 };
      const brd = { rect, faces: [] }; boards.push(brd);
      const Rh = rng(seed, 'boardhurt', pn.name, i), s = isBottom ? -1 : hurt(c0, Rh());
      if (s > 0) { proud += Rh.sym(0.004) * Math.min(1, s * 6); skew += Rh.sym(0.012) * Math.min(1, s * 6); }
      const ax0 = dir, rest = { c: madd(c0, pn.n, -t / 2), ax: dir, ay: cross(pn.n, dir), az: pn.n };
      const ax = norm(madd(dir, acr, skew)), az = pn.n, ay = cross(az, ax);
      const c = madd(c0, pn.n, -t / 2 + proud);
      const heldLo = alongV ? holdLo.holds(cen, -run / 2) : holdLo.holds(-run / 2, cen), heldHi = alongV ? holdHi.holds(cen, run / 2) : holdHi.holds(run / 2, cen);
      const holders = (heldLo ? 1 : 0) + (heldHi ? 1 : 0);
      const fall = (x0, x1, left, right) => debris.push({ L: x1 - x0, W: Wd, T: t, home: madd(c0, ax0, (x0 + x1) / 2), out: pn.wall ? pn.n : null, along: ax0,
        spec: { seed: sd, log: lf, rest, logShift: [(x0 + x1) / 2, 0, 0], tag: 'board', left, right, stations: left || right ? (left || right).ys : undefined } });
      if (damaged && holders === 0 && s < 0.22) { fall(-L / 2, L / 2, null, null); continue; }      // nothing left to hold it: it has fallen away
      if (s < 0.22 && !(damaged && holders < 2 && s > 0.05)) {
        const o = addBox(m, { c, ax, ay, az, L, W: Wd, T: t, mask: damaged ? FACE.ALL : FACE.PZ, lowMask: BOARD_IN, bevel, seed: sd, log: lf, rest, tag: 'board' });
        brd.faces.push(o[FACE.PZ]);
        continue;
      }
      // snapped: the break is nearest the blow, the halves are stove in, and the gap widens with the damage
      const k = Math.max(0, s - 0.22), brk = ragged(Rh, Wd, t);
      const near = blows.reduce((a, b) => (len(sub(c0, b)) < len(sub(c0, a)) ? b : a));
      const p = Math.max(-L * 0.36, Math.min(L * 0.36, dot(sub(near, c0), ax) + Rh.sym(0.05)));
      const open = Math.min(1, k * 1.6) * L * 0.5;
      const pieces = [
        { held: heldLo, x0: -L / 2, x1: p + brk.max / 2 - open * Rh.range(0.5, 1.3), right: brk, sgn: -1 },
        { held: heldHi, x0: p - brk.max / 2 + open * Rh.range(0.5, 1.3), x1: L / 2, left: mirrorBreak(brk), sgn: 1 },
      ];
      for (const pc of pieces) {
        const Lp = pc.x1 - pc.x0;
        if (Lp < brk.max + 0.012) continue;
        if (!pc.held) { fall(pc.x0, pc.x1, pc.left, pc.right); continue; }
        // hinge at the held end; the free end goes into the crate
        const phi = Rh.range(0.03, 0.22) * Math.min(1, 0.3 + k * 3) * (Lp > 0.12 ? 1 : 0.3), cs = Math.cos(phi), sn = Math.sin(phi);
        const ax2 = pc.sgn < 0 ? norm(madd(mul(ax, cs), az, -sn)) : norm(madd(mul(ax, cs), az, sn));
        const az2 = cross(ax2, ay);
        const hinge = madd(c, ax, pc.sgn < 0 ? -L / 2 : L / 2);
        const cp = madd(hinge, ax2, (pc.sgn < 0 ? 1 : -1) * Lp / 2);
        const o = addPlank(m, {
          c: cp, ax: ax2, ay, az: az2, L: Lp, W: Wd, T: t, seed: sd, log: lf, rest, logShift: [(pc.x0 + pc.x1) / 2, 0, 0], tag: 'board',
          left: pc.left, right: pc.right, stations: brk.ys, lowMask: FACE.NZ | FACE.PY | FACE.NY | (pc.left ? FACE.PX : FACE.NX),
        });
        brd.faces.push(o[FACE.PZ]);
      }
      // the piece knocked out from between them
      if (pieces[1].x0 - pieces[0].x1 > 0.04) fall(pieces[0].x1 - brk.max, pieces[1].x0 + brk.max, mirrorBreak(brk), brk);
    }

    // ---------- build the battens ----------
    const nail = (isl, p3, R2, type = 'nail') => {
      m.stamps.push({ type, isl: isl.id, f: isl.fOf(p3), r: 0.0042 * R2.range(0.9, 1.15), seed: R2(), g: inIsl(isl, G) });
    };
    for (const b of battens) {
      const Rb = b.R, Rn = rng(seed, 'nails', pn.name, b.name);
      const du = b.dirU, wu = [-du[1], du[0]];
      const d3 = add(mul(pn.u, du[0]), mul(pn.v, du[1])), w3 = add(mul(pn.u, wu[0]), mul(pn.v, wu[1]));
      const shear = b.theta !== undefined ? [Math.tan(b.theta), Math.tan(b.theta)] : undefined;
      const mask = damaged ? b.mask | FACE.NZ | FACE.PX | FACE.NX : b.mask;
      const rest = { c: at(b.cu, b.cv, bt / 2), ax: d3, ay: w3, az: pn.n };

      // where its nails go: wherever it crosses a board
      const nails = [];
      const j = () => Rn.sym(0.004 + 0.006 * slop);
      if (b.theta === undefined) {
        for (const brd of boards) {
          const q = brd.rect, u0 = Math.max(b.u0, q.u0), u1 = Math.min(b.u1, q.u1), v0 = Math.max(b.v0, q.v0), v1 = Math.min(b.v1, q.v1);
          if (u1 - u0 < 0.02 || v1 - v0 < 0.02) continue;
          const lu = u1 - u0, lv = v1 - v0, long = Math.max(lu, lv), short = Math.min(lu, lv);
          if (long > short * 1.8) {
            const n = Math.max(2, Math.round(long / 0.14));
            for (let i = 0; i < n; i++) {
              const a = (i + 0.5) / n, off = i % 2 ? 0.28 : 0.72;
              nails.push(lu > lv ? { u: u0 + lu * a + j(), v: v0 + lv * off + j(), brd } : { u: u0 + lu * off + j(), v: v0 + lv * a + j(), brd });
            }
          } else nails.push({ u: u0 + lu * 0.3 + j(), v: v0 + lv * 0.3 + j(), brd }, { u: u0 + lu * 0.7 + j(), v: v0 + lv * 0.7 + j(), brd });
        }
      } else {
        const n = Math.max(2, Math.round(b.L / 0.13));
        for (let i = 0; i < n; i++) {
          const a = ((i + 0.5) / n - 0.5) * b.L * 0.9, off = (i % 2 ? 1 : -1) * bw * 0.2;
          const u = b.cu + du[0] * a + wu[0] * off + Rn.sym(0.005), v = b.cv + du[1] * a + wu[1] * off + Rn.sym(0.005);
          nails.push({ u, v, brd: boards.find((q) => u >= q.rect.u0 && u < q.rect.u1 && v >= q.rect.v0 && v < q.rect.v1) });
        }
      }
      for (const nl of nails) nl.a = (nl.u - b.cu) * du[0] + (nl.v - b.cv) * du[1];     // position along the batten

      // what it leaves behind when it moves: a clean ghost and its nail holes
      const leave = (aFrom, aTo) => {
        const ac = (aFrom + aTo) / 2, cen = at(b.cu + du[0] * ac, b.cv + du[1] * ac, 0);
        for (const brd of boards) for (const isl of brd.faces) {
          const wi = inIsl(isl, w3);
          m.stamps.push({ type: 'ghost', isl: isl.id, f: isl.fOf(cen), g: [-wi[0], -wi[1]], half: [(aTo - aFrom) / 2, b.wid / 2], seed: Rb() });
        }
        for (const nl of nails) if (nl.a >= aFrom && nl.a <= aTo && nl.brd) for (const isl of nl.brd.faces) nail(isl, at(nl.u, nl.v, 0), Rn, 'hole');
      };

      if (b.state <= 1) {
        // its foot on the boards: lets a label pasted over it tear beside it (bake: stamp type 4)
        for (const brd of boards) for (const isl of brd.faces) {
          const wi = inIsl(isl, w3);
          m.stamps.push({ type: 'foot', isl: isl.id, f: isl.fOf(at(b.cu, b.cv, 0)), g: [-wi[0], -wi[1]], half: [b.len / 2, b.wid / 2], seed: 0 });   // no draw from Rb: it would move every later draw
        }
        // sound, or working loose: one end has lifted
        const lift = b.state === 1 ? Rb.range(0.004, 0.014) : 0, tw = b.state === 1 ? Rb.sym(0.012) : 0;
        const ax = norm(add(madd(d3, w3, tw), mul(pn.n, (b.keep * -lift) / b.len))), az = norm(cross(ax, cross(pn.n, ax))), ay = cross(az, ax);
        const c = at(b.cu, b.cv, bt / 2 + lift / 2);
        const o = addBox(m, { c, ax, ay, az, L: b.len, W: b.wid, T: bt, mask, lowMask: FACE.NZ, bevel, seed: b.seed, log: b.lf, rest, shear, tag: 'batten' });
        for (const nl of nails) nail(o[FACE.PZ], add(c, add(mul(ax, nl.a), mul(ay, (nl.u - b.cu) * wu[0] + (nl.v - b.cv) * wu[1]))), Rn);
      } else if (b.state === 2) {
        // hanging: one nail still holds and the batten has swung down on it
        const pivA = b.keep * (b.len / 2 - bw * 0.5), piv = at(b.cu + du[0] * pivA, b.cv + du[1] * pivA, 0);
        const free = mul(d3, -b.keep);                              // from the pivot toward the free end
        const downish = norm(madd(madd(G, pn.n, -dot(G, pn.n)), free, 0.0001));
        const swing = Rb.range(0.25, 0.85), fdir = norm(add(mul(free, Math.cos(swing)), mul(downish, Math.sin(swing))));
        // if it started near vertical it barely moves; let it lean out from the face instead
        const outA = Rb.range(0.02, 0.07);
        const axF = norm(madd(fdir, pn.n, outA)), az = norm(cross(cross(axF, pn.n), axF)), ax = mul(axF, -b.keep), ay = cross(az, ax);
        const c = add(madd(piv, axF, b.len / 2 - bw * 0.5), mul(az, bt * 1.6));
        const o = addBox(m, { c, ax, ay, az, L: b.len, W: b.wid, T: bt, mask: mask | FACE.NZ, lowMask: FACE.NZ, bevel, seed: b.seed, log: b.lf, rest, shear, tag: 'batten' });
        nail(o[FACE.PZ], madd(c, ax, pivA), Rn);
        for (const nl of nails) if (Math.abs(nl.a - pivA) > 0.03 && Rn.chance(0.5)) nail(o[FACE.PZ], add(c, mul(ax, nl.a)), Rn, 'hole');
        leave(-b.len / 2, b.len / 2);
      } else if (b.state === 3) {
        // broken: a stub stays nailed at the end that held
        const { brk, a0, a1 } = b, keepLen = a1 - a0, ac = (a0 + a1) / 2;
        const ax = d3, az = pn.n, ay = cross(az, ax);
        const o = addPlank(m, {
          c: at(b.cu + du[0] * ac, b.cv + du[1] * ac, bt / 2), ax, ay, az, L: keepLen, W: b.wid, T: bt, seed: b.seed, log: b.lf, rest, logShift: [ac, 0, 0], tag: 'batten',
          left: b.keep < 0 ? null : mirrorBreak(brk), right: b.keep < 0 ? brk : null, stations: brk.ys, mask: FACE.ALL, lowMask: FACE.NZ,
        });
        for (const nl of nails) if (nl.a > a0 + 0.01 && nl.a < a1 - brk.max - 0.01) nail(o[FACE.PZ], at(nl.u, nl.v, bt), Rn);
        if (b.keep < 0) leave(a1 - brk.max, b.len / 2); else leave(-b.len / 2, a0 + brk.max);
        // and the rest of it lies somewhere below
        const f0 = b.keep < 0 ? a1 - brk.max : -b.len / 2, f1 = b.keep < 0 ? b.len / 2 : a0 + brk.max;
        debris.push({ L: f1 - f0, W: b.wid, T: bt, home: at(b.cu + du[0] * (f0 + f1) / 2, b.cv + du[1] * (f0 + f1) / 2, bt), out: pn.wall ? pn.n : null, along: d3,
          spec: { seed: b.seed, log: b.lf, rest, logShift: [(f0 + f1) / 2, 0, 0], tag: 'batten', left: b.keep < 0 ? mirrorBreak(brk) : null, right: b.keep < 0 ? null : brk, stations: brk.ys } });
      } else {
        leave(-b.len / 2, b.len / 2);
        debris.push({ L: b.len, W: b.wid, T: bt, home: at(b.cu, b.cv, bt), out: pn.wall ? pn.n : null, along: d3, spec: { seed: b.seed, log: b.lf, rest, tag: 'batten' } });
      }
    }
  }
  // ---------- what fell, where it lies ----------
  if (debris.length && P.rubble > 0) {
    const ground = createGround(Math.max(W, D) * 1.5 + 2.2), Rr = rng(seed, 'rubble');
    const wallT = (t + bt) / 2 + 0.012, inW = W / 2 - t - 0.012, inD = D / 2 - t - 0.012;
    ground.floorRect(0, 0, 1, 0, inW, inD, yb + t);
    for (const sgn of [-1, 1]) {
      ground.blockRect(0, sgn * (D / 2 - t / 2 + bt / 2), 1, 0, W / 2 + bt + 0.01, wallT);
      ground.blockRect(sgn * (W / 2 - t / 2 + bt / 2), 0, 0, 1, D / 2 + bt + 0.01, wallT);
    }
    // long pieces first, so the small stuff ends up on top
    debris.forEach((d) => { d.key = d.L + Rr.sym(0.15); });
    debris.sort((a, b) => b.key - a.key);
    for (const d of debris) {
      const R = rng(seed, 'fall', Math.round(d.home[0] * 1000), Math.round(d.home[1] * 1000), Math.round(d.home[2] * 1000));
      if (R() > P.rubble) continue;                                 // cleared away
      const fitsIn = d.L < Math.min(inW, inD) * 1.7;
      let x = d.home[0], z = d.home[2], yaw;
      const inside = fitsIn && (d.out ? R.chance(0.3) : R.chance(0.75));
      if (inside) {
        x = Math.max(-inW * 0.6, Math.min(inW * 0.6, x * 0.6)); z = Math.max(-inD * 0.6, Math.min(inD * 0.6, z * 0.6)); yaw = R.range(0, Math.PI);
      } else {
        // a wall piece topples outward; one from the top slides off the nearest side
        let out = d.out;
        if (!out) out = Math.abs(x) / W > Math.abs(z) / D ? [Math.sign(x) || 1, 0, 0] : [0, 0, Math.sign(z) || 1];
        const upright = Math.abs(d.along[1]) > 0.7;
        const reach = upright ? d.L * R.range(0.35, 0.7) : d.W / 2 + R.range(0.02, 0.22);
        const edgeX = W / 2 + bt, edgeZ = D / 2 + bt;
        if (out[0]) x = out[0] * (edgeX + 0.03 + reach); else z = out[2] * (edgeZ + 0.03 + reach);
        yaw = upright ? Math.atan2(out[2], out[0]) + R.sym(0.55) : Math.atan2(d.along[2], d.along[0]) + R.sym(0.4);
        x += R.sym(0.06); z += R.sym(0.06);
      }
      const f = ground.find(d.L, d.W, d.T, x, z, yaw, R);
      if (!f) continue;
      const faceUp = R.chance(0.5);
      const i0 = m.islands.length;
      addPlank(m, { ...d.spec, c: f.c, ax: f.ax, ay: faceUp ? f.ay : mul(f.ay, -1), az: faceUp ? f.az : mul(f.az, -1), L: d.L, W: d.W, T: d.T, mask: FACE.ALL, lowMask: faceUp ? FACE.NZ : FACE.PZ });
      for (let i = i0; i < m.islands.length; i++) m.islands[i].loose = true;        // lying on the ground, no longer part of the crate
    }
  }
  // where markings can go: each panel's face, in the space of the crate before it was damaged
  m.targets = panels.filter((pn) => pn.name !== 'bottom').map((pn) => ({
    id: pn.name, label: pn.name[0].toUpperCase() + pn.name.slice(1), kind: 'plane', o: pn.c, u: pn.u, v: pn.v, n: pn.n,
    w: 2 * pn.bu, h: 2 * pn.bv, skin: [-0.004, 0.004], proud: [-0.004, bt + 0.004],
  }));
  // The far level of detail: the faces of the box the crate fills, each to be
  // photographed from outside (see lod2.js). in / out: how far behind and in
  // front of the face the photograph reaches.
  {
    const bx = W / 2 + bt, bz = D / 2 + bt, top = yt + bt, out = damaged ? 0.12 : 0.004, cards = [];
    const faces = {
      front: [[0, 0, 1], [[-bx, 0, bz], [bx, 0, bz], [bx, top, bz], [-bx, top, bz]], D * 0.35],
      back: [[0, 0, -1], [[bx, 0, -bz], [-bx, 0, -bz], [-bx, top, -bz], [bx, top, -bz]], D * 0.35],
      right: [[1, 0, 0], [[bx, 0, bz], [bx, 0, -bz], [bx, top, -bz], [bx, top, bz]], W * 0.35],
      left: [[-1, 0, 0], [[-bx, 0, -bz], [-bx, 0, bz], [-bx, top, bz], [-bx, top, -bz]], W * 0.35],
      top: [[0, 1, 0], [[-bx, top, bz], [bx, top, bz], [bx, top, -bz], [-bx, top, -bz]], H * 0.35],
    };
    for (const pn of panels) if (faces[pn.name] && !pn.collapsed) { const [n, pts, inn] = faces[pn.name]; cards.push({ name: pn.name, n, pts, in: inn, out }); }
    // once it can be seen into, the floor and whatever lies on it
    if (damaged) { const fx = W / 2 - t, fz = D / 2 - t, fy = yb + t; cards.push({ name: 'floor', n: [0, 1, 0], pts: [[-fx, fy, fz], [fx, fy, fz], [fx, fy, -fz], [-fx, fy, -fz]], in: t + 0.01, out: Math.min(0.3, H * 0.4) }); }
    m.proxy = { cards };
  }
  m.params = P; m.seed = seed;
  return m;
}
