import { buildCrate, CRATE_PARAMS, crateDefaults } from './crate.js';
import { buildBarrel, BARREL_PARAMS, barrelDefaults } from './barrel.js';
import { packAtlas } from './model.js';
import { createBaker } from './bake.js';
import { createView } from './view.js';
import { defaultLook, LOOK_PARAMS, HISTORIES, STYLES, STYLE_PARAMS } from './looks.js';
import { PAPERS } from './assets/papers.js';
import { GRUNGE } from './assets/grunge.js';
import { NOISE } from './shaders/noise.js';
import { STYLE_GLSL } from './shaders/style.js';
import { section, controls, button, el } from './ui.js';
import { createMarks, hexToRgb } from './marks.js';
import { buildGLB, encodePNG, download } from './gltf.js';
import { geoArrays } from './model.js';
import { createImpostor, planCards } from './lod2.js';

const canvas = document.getElementById('view');
const status = document.getElementById('status');
const panel = document.getElementById('panel');
const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });

const MAKES = {
  crate: { label: 'Crate', build: buildCrate, params: CRATE_PARAMS, defaults: crateDefaults, species: 'pine' },
  barrel: { label: 'Barrel', build: buildBarrel, params: BARREL_PARAMS, defaults: barrelDefaults, species: 'oak' },
};

const app = {
  make: 'crate', seed: 1, params: { crate: crateDefaults(), barrel: barrelDefaults() }, look: defaultLook(), size: 2048,
  model: null, error: null, draftScale: 0.5, fullMs: 1e9,
  view3d: { mode: '0', wire: false, lod: '0', atlas: '' },
  marks: { crate: [], barrel: [] }, slot: 0,
  style: 'real', styles: JSON.parse(JSON.stringify(STYLES)), papers: {},
};
const mark = (o = {}) => Object.assign({ src: 'none', id: '', text: 'FRAGILE', target: '', x: 0, y: 0, size: 0.4, rot: 0, mode: 'paint', color: '#17130f', opacity: 0.9, wear: 0.4, over: true }, o);
app.marks.crate = [mark({ src: 'lib', id: 'fragile', target: 'front', size: 0.5, y: 0.25 }), mark({ src: 'lib', id: 'arrows-up', target: 'right', size: 0.2, x: 0.7, y: 0.6 }), mark(), mark()];
app.marks.barrel = [mark({ src: 'lib', id: 'coopers-mark', target: 'head', size: 0.3, mode: 'brand', wear: 0.2 }), mark({ src: 'lib', id: 'rum', target: 'side', size: 0.3, y: 0.1, color: '#d9d2bf', wear: 0.5, over: false }), mark(), mark()];
window.app = app;

function fail(e) {
  app.error = String((e && e.stack) || e);
  status.textContent = app.error; status.style.color = '#f88';
  console.error(e);
}

try {
  if (!gl) throw new Error('WebGL2 is not available in this browser.');
  app.baker = createBaker(gl); app.view = createView(gl, canvas);
  // images still decoding (stencils, paper, grunge). Nothing re-bakes on their account until the first bake is done.
  let loading = 0;
  const assetReady = () => { if (app.booted && app.schedule) app.schedule('look', false); };
  app.impostor = createImpostor(gl);
  // the paper swatches the drawn styles use
  for (const name in PAPERS) {
    const img = new Image(); loading++;
    img.onerror = () => { loading--; };
    img.onload = () => {
      loading--;
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      app.papers[name] = { tex };
      if (app.styles[app.style].paperTex === name) assetReady();
    };
    img.src = PAPERS[name];
  }
  { // the atlas of spill, splatter and drip shapes
    const img = new Image(); loading++;
    img.onerror = () => { loading--; };
    img.onload = () => {
      loading--;
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      app.grunge = { tex };
      assetReady();
    };
    img.src = GRUNGE;
  }
  const styleNow = () => { const st = app.styles[app.style]; return { ...st, id: app.style, ink: hexToRgb(st.ink || '#000000'), paper: hexToRgb(st.paper || '#ffffff'), tex: app.papers[st.paperTex] }; };
  app.markLib = createMarks(gl, assetReady);

  // what: 'all' rebuilds geometry; 'look' only re-bakes. draft: quick and coarse.
  app.rebuild = (what = 'all', draft = false) => {
    const mk = MAKES[app.make];
    const fast = app.fullMs < 140;            // a GPU this quick does not need drafts
    if (fast) draft = false;
    if (what === 'all' || !app.model) {
      app.model = mk.build(app.params[app.make], app.seed);
      packAtlas(app.model, app.size);
      app.view.setModel(app.model);
      app.geoKey = JSON.stringify([app.make, app.params[app.make], app.seed, app.size]);
      if (app.drawMarks && app.shownMake !== app.make) { app.shownMake = app.make; app.drawMarks(); }      // the places a marking can go belong to the model
    }
    const marks = app.marks[app.make].map((mk, i) => {
      const t = app.markLib.get(mk, app.make + i);
      // a label from a stencil or typed text is printed (the shader lays ink on paper); a loaded picture is the label itself
      const printed = mk.mode === 'label' && mk.src !== 'user';
      return t && { ...mk, tex: mk.mode === 'label' && !printed ? t.texLabel : t.tex, printed, aspect: t.aspect, color: hexToRgb(mk.color) };
    });
    const r = app.baker.bake(app.model, app.look, { geoKey: app.geoKey, profile: app.profile, scale: draft ? app.draftScale : 1, occDirs: draft ? 32 : 96, marks, style: styleNow(), grunge: app.grunge });
    app.last = r;
    if (draft) { if (r.ms > 320) app.draftScale = 0.25; else if (r.ms < 70) app.draftScale = 0.5; } else app.fullMs = r.ms;
    app.view.setTextures(r);
    { // how the viewer lights it: as a game would, with the style's own shader, unless the light is painted in
      const st = app.styles[app.style], lin = (h) => hexToRgb(h || '#000000').map((x) => Math.pow(x, 2.2));
      app.view.S.shade = app.style === 'real' ? 'pbr' : app.style === 'cel' ? 'toon' : st.lit === 'dynamic' ? app.style : 'unlit';
      app.view.S.style = { uInkCol: lin(st.ink), uPaperCol: lin(st.paper || '#ffffff'), uStyleP: [st.light || 0, (st.line || 1) * 0.001, 0.016 - 0.010 * (st.a || 0), 0], uWrap: app.model.wrap ? [1, app.model.wrap] : [0, 1] };
    }
    // the card level of detail is a photograph of this bake: it is stale now, and only remade when wanted
    app.cards = null; app.view.setCards(null);
    if (app.view.S.lod >= 2 && !draft) app.ensureCards();
    const l = app.view.S.lods, nCards = planCards(app.model, app.size / 2).geo.ntri;
    status.textContent = `${l.map((x, i) => `LOD${i} ${x.ntri} tris`).join('   ')}   LOD2 ${nCards} tris\n${app.model.islands.length} islands   ${r.size}px${draft ? ' draft' : ''}   ${(app.model.atlas.pxPerM * r.size / app.size).toFixed(0)} px/m   baked in ${r.ms.toFixed(0)} ms`;
  };

  app.ensureCards = () => {
    if (app.cards) return app.cards;
    if (!app.last || app.last.size !== app.size) { app.rebuild('look', false); if (app.cards) return app.cards; }
    app.cards = app.impostor.bake(app.model, app.last, app.size / 2);
    app.view.setCards(app.cards);
    return app.cards;
  };

  let pending = null;
  const schedule = (what, draft) => {
    if (pending) { if (what === 'all') pending.what = 'all'; pending.draft = pending.draft && draft; return; }
    pending = { what, draft };
    requestAnimationFrame(() => { const p = pending; pending = null; try { app.rebuild(p.what, p.draft); } catch (e) { fail(e); } });
  };
  app.schedule = schedule;

  // ---- saving ----
  const recipe = () => ({ app: 'Stave & Batten', version: 1, make: app.make, seed: app.seed, size: app.size, params: app.params[app.make], look: app.look, style: { id: app.style, ...app.styles[app.style] }, marks: app.marks[app.make].filter((m) => m.src !== 'none') });
  const fileBase = () => `${app.make}-${app.seed}${app.style === 'real' ? '' : '-' + app.style}${(app.params[app.make].damage || 0) > 0 ? '-d' + Math.round(app.params[app.make].damage * 100) : ''}`;
  // make sure what is baked is the full-quality version of what is on screen
  const settle = () => { if (!app.last || app.last.size !== app.size) app.rebuild('look', false); };
  app.exportMaps = async () => {
    settle();
    const out = {}; for (const [k, i] of [['albedo', 0], ['normal', 1], ['orm', 2]]) out[k] = await encodePNG(app.baker.read(i), app.size);
    return out;
  };
  app.exportCardMaps = async () => {
    settle(); app.ensureCards();
    const s = app.cards.size, out = {};
    for (const [k, i] of [['albedo', 0], ['normal', 1], ['orm', 2]]) out[k] = await encodePNG(app.impostor.read(i), s, i === 0);
    return out;
  };
  app.exportGLB = async (which = 'all') => {
    const name = app.make === 'crate' ? 'Crate' : 'Barrel', want = (i) => which === 'all' || +which === i;
    const lods = [], materials = [], unlit = app.view.S.shade === 'unlit';
    if (want(0) || want(1)) materials.push({ name, images: await app.exportMaps(), unlit });
    app.model.lod.forEach((_, i) => { if (want(i)) lods.push({ geo: geoArrays(app.model, i), material: 0, label: 'LOD' + i }); });
    if (want(2)) { materials.push({ name: name + '_cards', images: await app.exportCardMaps(), mask: true, unlit }); lods.push({ geo: app.cards.geo, material: materials.length - 1, label: 'LOD2' }); }
    return buildGLB({ name, lods, materials, extras: recipe() });
  };
  app.save = async (what) => {
    try {
      status.textContent = 'saving...';
      if (what === 'glb') download(await app.exportGLB(app.exportLods || 'all'), fileBase() + '.glb', 'model/gltf-binary');
      else if (what === 'maps') {
        const nm = (k) => (k === 'albedo' ? 'basecolor' : k === 'orm' ? 'occlusion-roughness-metallic' : k);
        const m = await app.exportMaps(); for (const k of ['albedo', 'normal', 'orm']) download(m[k], `${fileBase()}_${nm(k)}.png`, 'image/png');
        const c = await app.exportCardMaps(); for (const k of ['albedo', 'normal', 'orm']) download(c[k], `${fileBase()}_lod2_${nm(k)}.png`, 'image/png');
      }
      else if (what === 'shader') {
        const st = app.styles[app.style], S = app.view.S.style, f = (a) => a.map((x) => (+x).toFixed(4)).join(', ');
        const head = `// Stave & Batten: the light-dependent part of the drawn styles (GLSL ES 3.00).
// These are the functions this workshop's own viewer runs. Port them to your engine's shading language.
//
// In your fragment shader, with base = the base colour texture (linear), N the normal, L the direction to the light,
// shadow the light's shadow term (1 = lit), ao the occlusion texture's red channel, P and Ng position and geometric normal
// (object space if the thing moves), and aa = the size of one pixel at P, e.g. max(length(dFdx(P)), length(dFdy(P))):
//
//   cel:          rgb = styleCel(base, N, V, L, shadow, ao, rimDir);
//   ink:          rgb = styleInk(base, inkCol, styleSheet(P, Ng, wrap), styleLight(N, L, shadow, ao), strength, pen, spacing, aa);
//   watercolour:  rgb = styleWash(base, paperCol, styleSheet(P, Ng, wrap), styleLight(N, L, shadow, ao), strength);
//
// Values as set when this file was saved (${app.style}, ${app.make}):
//   inkCol = vec3(${f(S.uInkCol)})   paperCol = vec3(${f(S.uPaperCol)})   (linear)
//   strength = ${(+S.uStyleP[0]).toFixed(2)}   pen = ${(+S.uStyleP[1]).toFixed(4)} m   spacing = ${(+S.uStyleP[2]).toFixed(4)} m   wrap = vec2(${f(S.uWrap)})
// Bake the textures with Light set to "From the engine", or the light will be drawn twice.
// Outlines against the background are not part of this: use an inverted hull or an edge pass.
`;
        download(new TextEncoder().encode(head + NOISE + STYLE_GLSL), 'stave-and-batten-styles.glsl', 'text/plain');
      }
      else if (what === 'recipe') download(new TextEncoder().encode(JSON.stringify(recipe(), null, 2)), fileBase() + '.json', 'application/json');
      status.textContent = 'saved ' + fileBase();
    } catch (e) { fail(e); }
  };

  buildPanel(schedule);
  // The first bake compiles the big shader and can take seconds on a slow GPU.
  // Let the page appear first, say what is happening, and bake once: after the
  // embedded images it needs have decoded, not once before and again after.
  // (#idle in the address leaves it unbuilt, for testing.)
  status.textContent = 'cutting the first boards...';
  app.marks[app.make].forEach((mk, i) => app.markLib.get(mk, app.make + i));          // start them decoding
  const bootAt = performance.now();
  const boot = () => {
    if ((loading > 0 || app.markLib.pending() > 0) && performance.now() - bootAt < 4000) { requestAnimationFrame(boot); return; }
    app.booted = true;
    if (!location.hash.includes('idle')) setTimeout(() => { try { app.rebuild(); } catch (e) { fail(e); } }, 0);
  };
  requestAnimationFrame(boot);
  const frame = () => { app.view.resize(); app.view.tick(); if (app.view.S.dirty) app.view.render(); requestAnimationFrame(frame); };
  frame();
} catch (e) { fail(e); }

function buildPanel(schedule) {
  panel.textContent = '';
  panel.append(el('h1', { text: 'Stave & Batten' }), el('p', { class: 'sub', text: 'a crate and barrel workshop' }));
  const mk = MAKES[app.make];
  const refreshers = [];
  const makes = el('div', { class: 'makes' });
  for (const k in MAKES) makes.append(button(MAKES[k].label, () => {
    if (app.make === k) return;
    app.make = k; app.look.species = MAKES[k].species; app.view.S.autoFrame = true;
    buildPanel(schedule); schedule('all', false);
  }, k === app.make ? 'make on' : 'make'));
  panel.append(makes);

  // seed
  const seedIn = el('input', { type: 'number', value: app.seed, min: 0, step: 1 });
  seedIn.addEventListener('change', () => { app.seed = Math.max(0, Math.floor(+seedIn.value || 0)); schedule('all', false); });
  const top = el('div', { class: 'row seed' }, el('span', { class: 'lab', text: 'Seed' }), seedIn,
    button('Roll', () => { app.seed = Math.floor(Math.random() * 1e6); seedIn.value = app.seed; schedule('all', false); }));
  panel.append(top);

  // style
  const sts = section('Style', true); panel.append(sts.sec);
  const chips = el('div', { class: 'styles' });
  for (const k in STYLES) chips.append(button(STYLES[k].label, () => { app.style = k; buildPanel(schedule); schedule('look', false); }, k === app.style ? 'make on' : 'make'));
  sts.body.append(chips);
  if (STYLE_PARAMS[app.style]) controls(sts.body, STYLE_PARAMS[app.style], app.styles[app.style], () => schedule('look', true), () => schedule('look', false));

  // geometry
  const groups = {};
  for (const d of mk.params) (groups[d.group] = groups[d.group] || []).push(d);
  for (const g in groups) {
    const s = section(g, g === 'Size' || g === 'Damage'); panel.append(s.sec);
    refreshers.push(controls(s.body, groups[g], app.params[app.make], () => schedule('all', true), () => schedule('all', false)));
  }
  // look
  const lg = {};
  for (const d of LOOK_PARAMS) (lg[d.group] = lg[d.group] || []).push(d);
  for (const g in lg) {
    const s = section(g, g !== 'Grunge' || true); panel.append(s.sec);
    if (g === 'Weather') {
      const hist = el('div', { class: 'chips' });
      for (const name in HISTORIES) hist.append(button(name, () => { Object.assign(app.look, HISTORIES[name]); refreshers.forEach((f) => f()); schedule('look', false); }, 'chip'));
      s.body.append(hist);
    }
    refreshers.push(controls(s.body, lg[g], app.look, () => schedule('look', true), () => schedule('look', false)));
  }
  // markings
  const ms = section('Markings', true); panel.append(ms.sec);
  const targets = () => (app.model && app.model.targets) || [];
  const drawMarks = () => {
    ms.body.textContent = '';
    const list = app.marks[app.make], mk = list[app.slot], key = app.make + app.slot;
    const tabs = el('div', { class: 'slots' });
    list.forEach((q, i) => tabs.append(button(q.src === 'none' ? `${i + 1}` : `${i + 1} \u25CF`, () => { app.slot = i; drawMarks(); }, i === app.slot ? 'slot on' : 'slot')));
    ms.body.append(tabs);
    const pick = (o) => { Object.assign(mk, o); if (!targets().some((t) => t.id === mk.target)) mk.target = (targets()[0] || {}).id || ''; drawMarks(); schedule('look', false); };
    // the library
    const grid = el('div', { class: 'stencils' });
    grid.append(button('none', () => pick({ src: 'none' }), mk.src === 'none' ? 'st on' : 'st'));
    for (const st of app.markLib.library) {
      const b = el('button', { class: mk.src === 'lib' && mk.id === st.id ? 'st on' : 'st', title: st.name, onclick: () => pick({ src: 'lib', id: st.id }) }, el('img', { src: st.src, alt: st.name }));
      grid.append(b);
    }
    ms.body.append(grid);
    // your own words, or your own picture
    const txt = el('input', { type: 'text', value: mk.text, placeholder: 'your own words', maxlength: 40 });
    txt.addEventListener('change', () => pick({ src: 'text', text: txt.value.toUpperCase() }));
    const file = el('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    file.addEventListener('change', () => { if (file.files[0]) { app.markLib.setUser(key, file.files[0]); pick({ src: 'user' }); } });
    ms.body.append(el('div', { class: 'row own' }, txt, button('Use text', () => pick({ src: 'text', text: txt.value.toUpperCase() }), mk.src === 'text' ? 'on' : ''), button(mk.src === 'user' ? 'Image \u2713' : 'Load image', () => file.click(), mk.src === 'user' ? 'on' : ''), file));
    if (mk.src === 'none') return;
    controls(ms.body, [
      { key: 'target', label: 'On the', options: targets().map((t) => [t.id, t.label]) },
      { key: 'mode', label: 'Made with', options: [['paint', 'Stencil and paint'], ['brand', 'Branding iron'], ['chalk', 'Chalk'], ['label', 'Paper label']] },
      { key: 'color', label: 'Colour', type: 'color' },
      { key: 'size', label: 'Size', min: 0.04, max: 1.5, step: 0.01, unit: 'm' },
      { key: 'x', label: 'Across', min: -1, max: 1, step: 0.01 },
      { key: 'y', label: 'Up', min: -1, max: 1, step: 0.01 },
      { key: 'rot', label: 'Turn', min: -180, max: 180, step: 1 },
      { key: 'opacity', label: 'Strength', min: 0, max: 1, step: 0.01 },
      { key: 'wear', label: 'Worn away', min: 0, max: 1, step: 0.01 },
      { key: 'over', label: 'Over battens', type: 'bool', hint: 'Sprayed across battens (or hoops) as well as the boards' },
    ], mk, () => schedule('look', true), () => schedule('look', false));
  };
  app.drawMarks = drawMarks;
  drawMarks();

  // view
  const vs = section('View', true); panel.append(vs.sec);
  const applyView = () => { const S = app.view.S; S.mode = +app.view3d.mode; S.wire = app.view3d.wire; S.lod = +app.view3d.lod; S.atlas = app.view3d.atlas; S.dirty = true; if (S.lod >= 2) { try { app.ensureCards(); } catch (e) { fail(e); } } };
  controls(vs.body, [
    { key: 'mode', label: 'Show', options: [['0', 'Lit'], ['1', 'Base colour'], ['2', 'Normal'], ['3', 'Roughness'], ['4', 'Occlusion'], ['5', 'Metallic'], ['7', 'Clay'], ['6', 'UV checker']] },
    { key: 'lod', label: 'Level of detail', options: [['0', 'LOD 0: every chamfer'], ['1', 'LOD 1: plain boards'], ['2', 'LOD 2: cards']] },
    { key: 'atlas', label: 'Atlas', options: [['', 'off'], ['albedo', 'Base colour'], ['normal', 'Normal'], ['orm', 'Occlusion / Roughness / Metal']] },
    { key: 'wire', label: 'Wireframe', type: 'bool' },
  ], app.view3d, applyView, applyView);
  const relight = () => { app.view.S.dirty = true; };
  controls(vs.body, [
    { key: 'lightAz', label: 'Light from', min: 0, max: 360, step: 1, hint: 'Walk the light round the object' },
    { key: 'lightEl', label: 'Light height', min: 8, max: 85, step: 1 },
  ], app.view.S, relight, relight);
  // save
  const ss = section('Save', true); panel.append(ss.sec);
  const ex = { lods: 'all' };
  controls(ss.body, [{ key: 'lods', label: 'Levels of detail', options: [['all', 'All, in one file'], ['0', 'LOD 0 only'], ['1', 'LOD 1 only'], ['2', 'LOD 2 only']] }], ex, () => {}, () => { app.exportLods = ex.lods; });
  ss.body.append(el('div', { class: 'saves' },
    button('Model (.glb)', () => app.save('glb'), 'primary'), button('Maps (.png)', () => app.save('maps')), button('Recipe (.json)', () => app.save('recipe'))));
  if (app.style !== 'real') ss.body.append(el('div', { class: 'saves one' }, button('Style shader (.glsl)', () => app.save('shader'))));
  const ts = section('Texture', false); panel.append(ts.sec);
  const tsObj = { size: String(app.size) };
  controls(ts.body, [{ key: 'size', label: 'Atlas size', options: ['1024', '2048', '4096'] }], tsObj, () => {}, () => { app.size = +tsObj.size; schedule('all', false); });
}
