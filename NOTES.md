# Working notes

Conventions and invariants that the code relies on and that are easy to break. Read before changing the bake, the mesh builders or the damage model.

## Space and units

- Metres, Y up, the ground is y = 0, the object stands on it. Gravity is -Y.
- Every local frame passed to `addBox` / `addPlank` must be right-handed: `az = cross(ax, ay)`. `ax` is the length (the grain), `ay` the width, `az` the thickness.
- Three coordinate spaces reach the bake shader per texel: `vPos` (final pose), `vRest` (where the point was before any damage) and `vLog` (position inside the log the board was sawn from; log z is the grain).

## Islands and UVs

- An island's face-local coordinates `f` are in metres. U runs along the grain. For every island U x V = N, with V toward the top of the texture in GL terms.
- `island.dens` scales its texel density (insides and undersides use 0.5). Anything that turns `f` into pixels must multiply by it: `packAtlas`, `geoArrays`, `bakeArrays`, the stamp pass.
- glTF export flips v and writes tangent w = +1. The normal map is "green up". This was checked in Google model-viewer; lettering reads the right way round.
- `geoArrays` welds identical vertices. `bakeArrays` does not.
- The per-vertex `face` attribute is `(x, y, w, h)`: a rectangle the shader uses for edge distance `e = min(x, w-x, y, h-y)`. It may differ from the island rectangle (staves taper, broken ends are ragged, head boards only count their long edges).

## Bake vertex attributes (locations)

0 uv, 1 pos, 2 normal, 3 tangent, 4 log, 5 face, 6 ids, 7 extra, 8 rest.

- `ids` = (material, seed 0..1, part, density).
- `extra` for wood = (seam darkening at island edge, fresh break, clear timber: 1 means no knots, takes markings round a barrel: only stave outsides). For hoop iron = (lap position along the band, has rivets).
- Materials: 0 wood, 1 iron, 2 dark liner.

## Bake passes and targets

1. Stamps -> RGBA8, MAX blending. R rust stain, G nail head, B sink depth x 2000 (1.0 means an empty nail hole), A ghost (sheltered from weather: where a lost batten or hoop sat). Stamp types: 0 nail, 1 hoop band, 2 batten ghost, 3 nail hole.
2. Occlusion at half resolution: 96 depth renders (Fibonacci sphere), accumulated in RGBA16F. R = ambient occlusion, G = sky exposure (1 for an open upward face). Cached per geometry key. Baked in the final pose.
3. Material -> albedo (SRGB8_ALPHA8, alpha carries the island density and doubles as coverage), surface (RGBA16F: height in millimetres, roughness, metallic, occlusion x cavity), aux.
4. Resolve: height -> tangent-space normal by central differences, one-sided at island borders, scaled by density.
5. Dilate six times. The last pass fills what is left and sets alpha to 1.

Inside the material shader heights are in metres; they are written out in millimetres because half floats lose precision near 1e-4.

Timings are only real after a one-pixel `readPixels`. `gl.finish()` does not wait. The headless test browser reports an Intel UHD 620: about 6 to 8 s per 2048 bake, and a 4096 bake hangs it.

## Wood

- `woodAt(L, seed, texel)` is one function of log space. Rings are a field F counted in years from the pith.
- Branches live in cells of height 0.45 m along the trunk; each texel searches its cell and one either side. A branch's influence is cut off at 5 knot radii so it cannot reach beyond the searched cells. Raising knot size or reach without widening the search brings back a straight break in the grain across a board.
- Everything fine is faded against `texel` so it never aliases. `fwidth` is used for the ring profile.
- Ray fleck (oak) shows only where `fwidth` of the angular coordinate is small, that is on quarter-sawn faces.

## Damage

- `hurt(p, tough) = damage * 1.35 - dist_to_nearest_blow / diagonal * 0.9 - tough * 0.35`. Positive means suffered.
- Crate boards: below 0.22 whole (loose above 0), above it snapped. Battens use `hurt - 0.25`: loose below 0.16, hanging or stub below 0.42, gone above. A panel falls when fewer than two of its four frame members hold; the lid falls when three walls are down.
- Barrel: hoops use `hurt - 0.18` (slipped below 0.2, off above). Staves snap above 0.3 and are knocked out above 0.8. With no upper hoop the staves spring; with no hoop at all it splays on the ground.
- A board's own random stream (`rng(seed, 'board', panel, i)`) must not depend on damage, so the same seed gives the same boards at every level. Damage draws from separate streams (`'boardhurt'`, `'stavehurt'`, ...).
- Both halves of a break pass the same log frame plus a `logShift`, so grain matches across it. The same shift places the piece in the rest frame.
- Debris: `settle.js` is a height map, not physics. Pieces are boxes; curved staves are approximated by a box of thickness T plus their sag.

## Markings

- Projected in rest space. A target is a plane or the barrel's unrolled side; `skin` and `proud` are depth windows (boards only, or boards and whatever stands on them).
- Up to four at once, passed as uniform arrays `uDk*`. The image's alpha is coverage. Paper labels use a second texture that keeps the picture's own alpha.
- The stencil library is generated (`tools/gen_stencils.py`, needs the local image server) and packed (`tools/pack_stencils.py`) into `src/assets/stencils.js`. Raw images are not committed.

## Styles

- A style is a last stage of the material shader (`uStyle`: 0 real, 1 cel, 2 ink, 3 watercolour). The realistic material is computed first and leaves facts behind in `s*` variables (ring field and its width, knot distance, cracks, seams, grey, wear, damp, dirt, rust, marking coverage and colour); the style redraws from those. Nothing in a style reads the finished realistic colour.
- `lineCov(distance, width, texel)` draws an anti-aliased line. Line widths are in metres (`uStA.x`, set in millimetres in the panel).
- Paper is a grey detail tile (0.5 = flat) from `src/assets/papers.js`, sampled in world space by dominant axis (wrapped round a barrel), so the sheet runs unbroken across each side of the object and ignores island seams. The tile must be featureless: `pack_papers.py` takes the calmest quarter of the scan and high-passes it, and the shader adds two layers at different scales turned against each other. A scan with a bloom in it showed up as the same blotch repeated up the barrel.
- Light is the engine's business. `src/shaders/style.js` holds the light-dependent part of each style (`styleCel`, `styleInk` / `styleHatch`, `styleWash`, plus `styleLight` and `styleSheet`) as one GLSL string used three ways: the viewer runs it every frame with its own light (`S.shade` = toon / ink / wash), the bake runs it once with a fixed sun when a style's Light is set to "Painted in" (then the viewer shows it unlit and export adds `KHR_materials_unlit`), and Save > Style shader writes it out with the noise functions for a game to port. Change the look of a shadow in that file and all three change together.
- Hatching fades to its average grey when strokes get smaller than a pixel (`aa / spacing`), so tone holds at distance. `styleLight` treats a face turned from the light as shadowed whatever the shadow map says; without that, shadow-map noise on such faces shows through the hatch threshold as blotches.
- Each style is its own material program (`materialFor`): `uStyle` is replaced by a constant before compiling. With it as a uniform the realistic bake ran about 2 s slower on the integrated GPU, the driver evidently evaluating both sides of the branch.
- Markings round a barrel are chosen by which surface a texel is on (`extra.w` = 1 on stave outsides), not by depth: with few staves the flat faces sit centimetres inside the ideal curve and a depth window lost them.

## Grunge

- Spills, splashes and wet patches are shapes from a 4 x 3 atlas (`src/assets/grunge.js`: rows spill / splatter / drip, made by `tools/gen_grunge.py`, packed by `tools/pack_grunge.py`), scattered by `splat()` one per grid cell over the same wrapped sheet the styles draw on (`styleSheet`), so one spill crosses several boards. `runs()` hangs drip shapes from the top edge of the object.
- Moss, lichen and rot are procedural and driven by the bake's own masks: occlusion, height above ground, sky exposure, damp, end grain. Rot only touches wood.
- Grunge reports to the drawn styles through `sDirt`, `sDamp`, `sMark` and `gMoss`.

## Startup

- The first bake waits (up to 4 s) for the embedded images it needs to decode: default stencils, paper swatches, grunge atlas. Before this the page baked once without them and again when they arrived. `#idle` in the address skips the first bake.
- The first bake is deferred a frame so the page paints before the shader compiles.

## Levels of detail

- LOD0: chamfers, ragged breaks. LOD1: plain boxes; a ragged plank end is one straight cut (`addPlank`'s `emit` modes 'near' / 'far'). Both share the main atlas.
- LOD2 (`lod2.js`): flat cards with LOD0 photographed onto them, in a second atlas half the size, cut out by alpha. Makers list cards in `model.proxy.cards` as `{ name, n, pts, in, out }`: a planar polygon wound counter-clockwise seen from outside, and how far behind / in front of it the orthographic capture reaches. If the real surface bulges in front of a card (the barrel's bilge), `out` must cover the bulge or the capture clips holes in it.
- A card's frame: `u = cross(Y, n)` (or X when n is vertical), `v = cross(n, u)`. Tangent is `u`, w = +1, the same convention as the main mesh. Captured normals are re-expressed in that frame.
- Islands flagged `loose` (debris on the ground, hoops that came off) are left out of wall cards and photographed from above onto one 'debris' card. A card named 'floor' sees everything. `proxy.allLoose` means nothing stands and the debris card is the whole model.
- While colour is being spread into the cut-away texels, the normal map's alpha is the "has colour" flag. On export only base colour keeps alpha.
- PNGs with real alpha are encoded by hand in `gltf.js`: a canvas multiplies colour by alpha and would lose the colour under the cut-outs.
- The card bake is lazy: `app.ensureCards()` runs when LOD2 is viewed or exported, and every re-bake of the model marks it stale.

## Workflow

- `npm run build` (or `node build.js --dev` for an unminified page), `npm test` for geometry invariants.
- There is no automated browser test yet. Visual checks so far were by screenshot through a static server on port 8765.
- `window.app` in the page exposes everything: `app.rebuild('all' | 'look')`, `app.params`, `app.look`, `app.marks`, `app.view.cam`, `app.view.S` (mode, atlas, wire, lod), `app.exportGLB()`.

## Publishing

- `npm run build` writes the release page to `docs/index.html` as well as `dist/`. GitHub Pages serves `docs/` from the main branch. `dist/`, `shots/` and `assets_raw/` are not committed.
- `tools/gen_*.py` need an OpenAI-style image server; set `IMAGE_HOST`.
- Public at https://github.com/ngutten/stave-and-batten (CC0), served at https://ngutten.github.io/stave-and-batten/. To publish a change: `npm run build`, commit on `main`, push `main`. Only `main` is public; any other local branch stays local.

## Next

Agreed with Nich on 2026-11-18 as later extensions, not started:

- **Sci-fi makes.** A separate build, not a re-skin: polymer shells, curved surfaces, metal beams, hexagonal punched gratings. Needs a painted-metal / polymer material family (paint chipping to primer and bare metal at edges), its own damage vocabulary (dents, scorches, blown panels), and probably an emissive map.
- **Fire damage.** Another kind of damage and grunge: charring that follows the grain, alligatored char on the surface, scorch halos, soot rising above where it burned, boards burned through.
- Smaller: lichen is weak (pale blobs) and shares the moss slider; watercolour is the weakest style; damaged-barrel LOD1 is still heavy; debris never leans against what still stands; per-fragment export nodes; "Over battens" no longer carries a barrel marking across the hoops; loading a recipe; automated browser tests; engine ports of the style shader; a 4096 bake has never been seen to complete on the development machine.
