// Seeded randomness. Everything random in a model derives from the model seed
// through named substreams, so changing one parameter does not re-roll the rest.

export function hash32(a, b = 0) {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (b + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}

export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// rng(seed, 'name', index...) -> generator with helpers
export function rng(seed, ...keys) {
  let s = seed >>> 0;
  for (const k of keys) s = hash32(s, typeof k === 'string' ? hashStr(k) : (k | 0));
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = () => next();
  r.range = (a, b) => a + (b - a) * next();
  r.sym = (a = 1) => (next() * 2 - 1) * a;
  r.int = (a, b) => a + Math.floor(next() * (b - a + 1));
  r.pick = (arr) => arr[Math.floor(next() * arr.length)];
  r.chance = (p) => next() < p;
  // approximately normal, clamped to +-3 sigma
  r.gauss = (sigma = 1) => { const g = next() + next() + next() + next() - 2; return Math.max(-3, Math.min(3, g * 1.732)) * sigma; };
  r.seed = () => Math.floor(next() * 4294967296) >>> 0;
  return r;
}
