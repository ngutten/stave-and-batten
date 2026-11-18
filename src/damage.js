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
