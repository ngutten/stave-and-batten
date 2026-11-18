// Geometry invariants. Run with: node test/geometry.mjs
import { buildCrate, crateDefaults } from '../src/crate.js';
import { buildBarrel } from '../src/barrel.js';
import { planCards } from '../src/lod2.js';
import { packAtlas, geoArrays, bakeArrays, bounds } from '../src/model.js';

let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.log('FAIL', msg); } };

function check(model, label) {
  const atlas = packAtlas(model, 2048);
  const { size, pxPerM } = atlas;
  // islands inside the atlas and not overlapping
  const rects = model.islands.map((i) => [i.px, i.py, i.px + i.w * pxPerM * i.dens, i.py + i.h * pxPerM * i.dens]);
  for (const r of rects) ok(r[0] >= 0 && r[1] >= 0 && r[2] <= size && r[3] <= size, `${label}: island out of atlas`);
  let overlaps = 0;
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
    const A = rects[a], B = rects[b];
    if (A[0] < B[2] && B[0] < A[2] && A[1] < B[3] && B[1] < A[3]) overlaps++;
  }
  ok(overlaps === 0, `${label}: ${overlaps} island overlaps`);
  const area = rects.reduce((s, r) => s + (r[2] - r[0]) * (r[3] - r[1]), 0) / (size * size);
  const out = [];
  for (let l = 0; l < model.lod.length; l++) {
    const g = geoArrays(model, l);
    ok(g.idx.every((i) => i < g.nv), `${label}: LOD${l} index out of range`);
    // every vertex UV lies within its island (with half a texel of slack)
    const geo = model.lod[l]; let outside = 0;
    for (let i = 0; i < g.nv; i++) {
      const isl = model.islands[geo.isl[i]], e = 0.5 / pxPerM;
      if (geo.f[i * 2] < -e || geo.f[i * 2] > isl.w + e || geo.f[i * 2 + 1] < -e || geo.f[i * 2 + 1] > isl.h + e) outside++;
    }
    ok(outside === 0, `${label}: LOD${l} ${outside} vertices outside their island`);
    // no degenerate triangles, normals unit, faces agree with vertex normals
    let degen = 0, flipped = 0;
    for (let t = 0; t < g.idx.length; t += 3) {
      const [a, b, c] = [g.idx[t], g.idx[t + 1], g.idx[t + 2]].map((i) => [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const ar = Math.hypot(...n); if (ar < 1e-10) { degen++; continue; }
      let d = 0; for (const i of [g.idx[t], g.idx[t + 1], g.idx[t + 2]]) d += n[0] * g.nrm[i * 3] + n[1] * g.nrm[i * 3 + 1] + n[2] * g.nrm[i * 3 + 2];
      if (d <= 0) flipped++;
    }
    ok(degen === 0, `${label}: LOD${l} ${degen} degenerate triangles`);
    ok(flipped === 0, `${label}: LOD${l} ${flipped} triangles facing against their normals`);
    for (let i = 0; i < g.nv; i++) { const L = Math.hypot(g.nrm[i * 3], g.nrm[i * 3 + 1], g.nrm[i * 3 + 2]); if (Math.abs(L - 1) > 1e-4) { ok(false, `${label}: non-unit normal`); break; } }
    out.push(`LOD${l} ${g.ntri} tris / ${g.nv} verts`);
  }
  for (const st of model.stamps) ok(model.islands[st.isl] && st.f.every(Number.isFinite) && st.g.every(Number.isFinite), `${label}: bad stamp ${st.type}`);
  const B = bakeArrays(model);
  for (const k of ['uv', 'pos', 'nrm', 'tan', 'log', 'face']) ok(B[k].every(Number.isFinite), `${label}: non-finite bake ${k}`);
  ok(B.nv > 0 && !B.uv.some((x) => x < 0 || x > 1), `${label}: bake UVs out of range`);
  // the card level of detail: cards inside the atlas, not overlapping, facing outward
  const plan = planCards(model, 1024);
  ok(plan.geo.ntri > 0, `${label}: no cards`);
  ok(plan.geo.uv.every((x) => x >= 0 && x <= 1), `${label}: card UVs out of range`);
  const cr = plan.cards.map((c) => c.rect);
  ok(cr.every((r) => r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= 1024 && r[1] + r[3] <= 1024), `${label}: card out of atlas`);
  let cover = 0; for (let a = 0; a < cr.length; a++) for (let b = a + 1; b < cr.length; b++) if (cr[a][0] < cr[b][0] + cr[b][2] && cr[b][0] < cr[a][0] + cr[a][2] && cr[a][1] < cr[b][1] + cr[b][3] && cr[b][1] < cr[a][1] + cr[a][3]) cover++;
  ok(cover === 0, `${label}: ${cover} card overlaps`);
  for (const c of plan.cards) {
    // fan triangles must face along the card's normal
    const [p0, p1, p2] = c.pts, e1 = p1.map((x, i) => x - p0[i]), e2 = p2.map((x, i) => x - p0[i]);
    const gn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    ok(gn[0] * c.n[0] + gn[1] * c.n[1] + gn[2] * c.n[2] > 0, `${label}: card ${c.name} wound backwards`);
  }
  const bb = bounds(model);
  console.log(`${label}: ${model.islands.length} islands, ${out.join(', ')}, ${pxPerM.toFixed(0)} px/m at ${size}, fill ${(area * 100).toFixed(0)}%, ${model.stamps.length} stamps, ${plan.geo.ntri} card tris, size ${bb.max.map((x, i) => (x - bb.min[i]).toFixed(3)).join(' x ')}`);
}

for (const brace of ['none', 'diagonal', 'chevron', 'mid rail']) for (const sideBoards of ['vertical', 'horizontal'])
  check(buildCrate({ ...crateDefaults(), brace, sideBoards }, 12345), `crate ${brace}/${sideBoards}`);
check(buildCrate({ W: 0.4, H: 1.6, D: 0.4 }, 7), 'crate tall');
check(buildCrate({ W: 1.8, H: 0.3, D: 1.2, bevel: 0 }, 9), 'crate flat no bevel');

for (const damage of [0.15, 0.4, 0.7, 1]) for (const sd of [1, 2, 3]) check(buildCrate({ damage, blows: sd }, sd * 17), `crate damage ${damage} seed ${sd * 17}`);
check(buildCrate({ damage: 0.8, brace: 'chevron', sideBoards: 'horizontal' }, 5), 'crate damaged chevron/horizontal');
check(buildBarrel({}, 3), 'barrel');
for (const damage of [0.2, 0.45, 0.7, 1]) for (const sd of [1, 2, 3]) check(buildBarrel({ damage, blows: sd }, sd * 13), `barrel damage ${damage} seed ${sd * 13}`);
check(buildBarrel({ staves: 9, hoops: 1, bung: false, H: 0.4, bilge: 0.5 }, 4), 'barrel squat');
check(buildBarrel({ staves: 36, hoops: 4, H: 1.5, bilge: 0.5, head: 0.98 }, 5), 'barrel tall');

// determinism: the same seed builds the same thing
const a = JSON.stringify(buildCrate({}, 42).lod[0].p), b = JSON.stringify(buildCrate({}, 42).lod[0].p), c = JSON.stringify(buildCrate({}, 43).lod[0].p);
ok(a === b, 'same seed, different geometry'); ok(a !== c, 'different seed, same geometry');

console.log(failed ? `${failed} FAILED` : 'geometry ok');
process.exit(failed ? 1 : 0);
