// Shared damage vocabulary: where the blows landed, how much each piece has
// suffered, and what a break looks like.

import { rng } from './rng.js';
import { sub, len, add, mul, madd, dot, cross } from './model.js';

// A ragged break across a board of width W and thickness T: offsets (into the
// piece) at stations across the width, for the top and bottom faces. Wood
// tears in long splinters, so the offsets swing by a good part of the width.
export function ragged(R, W, T, { kMin = 4, kMax = 7, reach = 1 } = {}) {
  const K = R.int(kMin, kMax), amp = W * R.range(0.3, 0.8) * reach, top = [], bot = [];
  let walk = R.sym(0.3);
  for (let k = 0; k <= K; k++) {
    // mostly a wandering tear, now and then a long splinter
    walk = walk * 0.4 + R.sym(0.45);
    const t = (R.chance(0.35) ? (R.chance(0.5) ? 1 : -1) * R.range(0.7, 1.3) : walk) * amp * 0.5;
    top.push(t); bot.push(t + R.sym(T * 1.3));
  }
  const mn = Math.min(...top, ...bot);
  const ys = [-W / 2]; for (let k = 1; k < K; k++) ys.push(-W / 2 + (W * (k + R.sym(0.35))) / K); ys.push(W / 2);
  const o = { top: top.map((x) => x - mn), bot: bot.map((x) => x - mn), ys };
  o.max = Math.max(...o.top, ...o.bot);
  return o;
}
// the other side of the same break
export const mirrorBreak = (o) => ({ top: o.top.map((x) => o.max - x), bot: o.bot.map((x) => o.max - x), ys: o.ys, max: o.max });

// blows: points on the object. hurt(p, tough) > 0 means the piece at p with
// toughness tough (0..1) has suffered; larger is worse.
export function damageField(dmg, blows, diag) {
  const damaged = dmg > 0.001;
  const near = (p) => blows.reduce((a, b) => (len(sub(p, b)) < len(sub(p, a)) ? b : a));
  const dist = (p) => len(sub(p, near(p)));
  const hurt = (p, tough) => (damaged ? dmg * 1.35 - (dist(p) / diag) * 0.9 - tough * 0.35 : -1);
  return { damaged, hurt, near, dist, blows };
}

// Fire. One heat field over rest space, mirrored in the bake (bake.js heatAt): a
// plume over the seat of the fire whose radius grows with height (the V a fire
// leaves on a wall) and whose heat falls off upward. heat > 1 burns through.
// The seat comes from its own stream so blows never move it.
//   kind 'beside': a fire on the ground against one side; 'beneath': under it;
//   'inside': its contents burned. box: { hx, hz, floorY, round } (round: a barrel's radius).
export const FIRE_PARAMS = [
  { key: 'fire', label: 'Fire', min: 0, max: 1, step: 0.01, def: 0, group: 'Damage', hint: 'Scorched, then charred, then burnt through' },
  { key: 'seat', label: 'Fire was', options: ['beside', 'beneath', 'inside'], def: 'beside', group: 'Damage', hint: 'Where it burned: against one side, underneath, or inside it' },
];
export function fireField(amount, kind, seed, box) {
  const f = Math.max(0, Math.min(1, amount || 0));
  const R = rng(seed, 'fire');
  let seat, r0, spread, Lh;
  if (kind === 'inside') {
    const k = box.round ? box.round * 0.3 : 0;
    seat = box.round ? [R.sym(k), box.floorY, R.sym(k)] : [R.sym(box.hx * 0.35), box.floorY, R.sym(box.hz * 0.35)];
    r0 = 0.25 + 0.30 * f; spread = 0.30; Lh = 0.45 + 1.4 * f;
  } else if (kind === 'beneath') {
    seat = [R.sym((box.round || box.hx) * 0.3), 0, R.sym((box.round || box.hz) * 0.3)];
    r0 = 0.22 + 0.30 * f; spread = 0.35; Lh = 0.30 + 1.2 * f;
  } else {
    const out = R.range(0.10, 0.28);
    if (box.round) { const a = R.range(0, Math.PI * 2), r = box.round + out; seat = [Math.cos(a) * r, 0, Math.sin(a) * r]; }
    else {
      const wall = R.int(0, 3), along = R.sym(0.4);
      seat = wall === 0 ? [along * box.hx * 2, 0, box.hz + out] : wall === 1 ? [along * box.hx * 2, 0, -box.hz - out]
        : wall === 2 ? [box.hx + out, 0, along * box.hz * 2] : [-box.hx - out, 0, along * box.hz * 2];
    }
    r0 = 0.10 + 0.22 * f; spread = 0.45; Lh = 0.35 + 1.4 * f;
  }
  // grow: 1 for the burn, larger for the soot that rises past it
  const heat = (p, grow = 1) => {
    if (f <= 0) return 0;
    const dx = p[0] - seat[0], dy = p[1] - seat[1], dz = p[2] - seat[2], up = Math.max(dy, 0);
    const Rr = (r0 + up * spread) * grow;
    return 2.2 * f * Math.exp(-(dx * dx + dz * dz) / (Rr * Rr)) * Math.exp(-up / (Lh * grow)) * (dy < 0 ? Math.exp(dy / 0.04) : 1);
  };
  return { amount: f, kind, seat, r0, spread, Lh, heat, burns: f > 0 };
}

// Fire eats a board from its long edges, so the gaps between boards open where it burned
// hottest (Nich: fire does not break a crate; damage does). edgeAt(x, side) is a point on
// the -1 / +1 edge at x along the length. Returns { xs, l, r } for addPlank's o.edges, or
// null if nothing is eaten. Irregular: each edge wanders on its own.
export const EAT_FROM = 0.7;      // heat at which board edges start to be eaten (and a crate opens to view)
export function eatenEdges(fire, edgeAt, L, W, R, step = 0.01) {
  if (!fire.burns) return null;
  const n = Math.max(2, Math.ceil(L / step) + 1), xs = [], l = [], r = [];
  const ph = [R.range(0, 6.3), R.range(0, 6.3), R.range(0, 6.3), R.range(0, 6.3)];
  let any = 0, jl = 0, jr = 0, nl = 0, nr = 0;
  for (let i = 0; i < n; i++) {
    const x = -L / 2 + (L * i) / (n - 1);
    // ragged station to station (a random walk that keeps returning), with now and then a deeper bite
    jl = jl * 0.7 + R.sym(0.45); jr = jr * 0.7 + R.sym(0.45);
    nl = nl > 0 ? nl - 1 : R.chance(0.05) ? R.int(2, 5) : 0; nr = nr > 0 ? nr - 1 : R.chance(0.05) ? R.int(2, 5) : 0;
    const eat = (side, a, b, j, notch) => {
      const h = fire.heat(edgeAt(x, side));
      const k = Math.max(0, Math.min(1, (h - EAT_FROM) / 1.0));
      return W * 0.22 * k * k * (3 - 2 * k) * (0.6 + 0.08 * Math.sin(x * 13 + a) + 0.05 * Math.sin(x * 41 + b) + 0.25 * j + (notch ? 0.3 : 0));
    };
    const a = Math.max(0, eat(-1, ph[0], ph[1], jl, nl)), b = Math.max(0, eat(1, ph[2], ph[3], jr, nr));
    const sc = Math.min(1, (W - 0.012) / Math.max(a + b, 1e-9));                    // always leave a sliver
    xs.push(x); l.push(a * sc); r.push(b * sc); any = Math.max(any, a, b);
  }
  return any > 0.001 ? { xs, l, r } : null;
}

// A rigid motion: rotate by angle about the unit axis through pivot, then translate.
export function rigid(axis, angle, pivot, shift = [0, 0, 0]) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const rot = (v) => add(add(mul(v, c), mul(cross(axis, v), s)), mul(axis, dot(axis, v) * (1 - c)));
  return { p: (p) => add(add(pivot, rot(sub(p, pivot))), shift), v: rot };
}
export const compose = (a, b) => ({ p: (p) => b.p(a.p(p)), v: (v) => b.v(a.v(v)) });
export { rng };

// The rigid motion that carries frame A (origin o, orthonormal x, y, z) onto frame B.
export function frameMap(A, B) {
  const v = (w) => add(add(mul(B.x, dot(w, A.x)), mul(B.y, dot(w, A.y))), mul(B.z, dot(w, A.z)));
  return { p: (p) => add(B.o, v(sub(p, A.o))), v };
}
