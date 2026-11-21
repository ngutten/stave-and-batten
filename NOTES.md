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

1. Stamps -> RGBA16F (was RGBA8), MAX blending. R rust stain, G nail head, B sink depth x 2000 (1.0 means an empty nail hole), A ghost (sheltered from weather: where a lost batten or hoop sat). Stamp types: 0 nail, 1 hoop band, 2 batten ghost, 3 nail hole, 4 batten foot. **The foot** of every sound batten writes A below 0.02 (`FOOT_A` = 0.019 under the batten, falling to 0 at 3 cm out), so `nearB` in the material is the distance to the nearest batten edge. Everything that reads A as a ghost uses `step(0.02, a)` or `smoothstep(0.45, …)` and so never sees it. That is why the target is half float: 8 bits gave 6 mm steps, too coarse for creases.
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

## Markings over battens (2026-11-20)

- A mark's `over` reaches the shader as `uDkP[i].z`. Only marks sprayed or pasted over battens react to them.
- **Paint** in a batten's lee (within 3 cm of its edge, `nearB`): the stencil is sampled blurrier (`decalAt` now returns uv and lod), the paint thins, and an overspray mist drifts out. Faces turned away from the spray (a batten's sides) take it thinly.
- **A paper label pasted over battens is geometry** (`sheet.js`, `MAT.PAPER` = 5), not a decal (a decal on the wood could only ever follow the step; Nich wanted it stretched like an interpolating curve). After the model is built, LOD0's outward faces are rasterised into a height field over the label (5 mm grid); the sheet hangs from the highest support within 3.5 cm as `H(q) - 35 |p - q|^2`, so it bridges a board gap almost flat and comes off a batten in a curve. Where it is off the surface it rests on, it is stretched; its tear field (`wear`, blotches, stretch, the label's own rim) is clipped along its 0.5 contour, so torn edges are smooth lines. The bake draws it (`mat == 5`: `labelPaper`, pale fibres where `e`, carried in face.x, is near a tear) and leaves the wood under it bare (decal mode 4). Grunge and fire reach it like wood. A sheet is geometry, so changing a sheet label's placement or wear rebuilds the model (`app.sheetKey`). Supports come from every LOD (LOD1's square battens stand proud of LOD0's chamfered ones), and the far mesh's vertices take the highest fine-sheet point within 3 cells, so interpolation between them never dips into a batten.
- Labels on the boards only ("over" off) are still decals: they crack at board gaps as they age and never lie down a step.
- **Printed labels**: a stencil or typed text in label mode is printed in the mark's colour on a cream ground with a margin (`uDkP[i].w`, `printed` in main.js); before this they came out white on black. A loaded picture is still the label as it is.
- **A label ages with the crate**: `weather` (age, sun, damp, grime, spills, wet) yellows it (most at its own rim), foxes it, fades its ink in the sun, tears it in pieces rather than specks, and leaves a tide-lined water stain. Paper drinks a spill deeper than wood and holds more grime (`gLabel`). "Worn away" still adds tearing.
- **Plain face** (Joinery) leaves the brace or mid rail off one wall, so a label can go on clear boards.

## Fire (2026-11-20)

- **The fire is the last thing that happened.** Its block in the material shader runs after all grunge, so char covers patina, grime, moss, paint and labels; nothing has weathered since.
- **One heat field**, `fireField(...).heat(p)` in `damage.js`, mirrored by `heatAt()` in the bake. Keep the two in step. It is evaluated in **rest space** (`vRest`), so a piece that burned and fell keeps the char it had where it stood. Params: Fire (amount) and Fire was (beside / beneath / inside); the seat is drawn from stream `'fire'`. Model carries `m.fire`; the bake reads it for `uFire` / `uFireSeat`.
- **Fire does not break anything** (Nich: breaks are the damage dial's; fire and damage combine). What JS does with heat: a board's long edges are eaten back along its length where it burned hottest (`eatenEdges` -> `addPlank`'s `o.edges`: a strip mesh at 1 cm stations at LOD0, a straight average at LOD1), so gaps open and wander (at most ~22% of the width from each edge). Once heat anywhere on the skin passes `EAT_FROM` + 0.15, the crate is built **open**, exactly as damage builds it: no liner, every face, the floor card. The barrel only chars. (A first version burned boards and battens through and dropped the pieces; it left floating geometry and read as impact damage, so it went.)
- **What only the shader knows:** faces turned to the flames and arrises take more (`fireH`), a batten's ghost shields the board under it for a while, soot rises past the burn (a wider plume) and settles on undersides.
- **Wood by heat (shader `H`)**, tuned against Nich's reference photos: toasting follows the grain (latewood lines darken first, earlywood goes orange and shrinks back, arrises first); char takes the latewood ridges first, so its front runs ragged along the grain; char is nearly black (linear ~0.01) with sheen on the crowns; alligator blocks staggered row by row, each block keeps fine grain striations and sits at its own height; thin char near the front flakes in slivers to show the scorched wood; deep char has wider checks and ash on block crowns (mostly on upward faces). Iron: temper colours then black scale.
- **Styles:** facts `sChar`, `sCharCrack`, `sSoot`, `sScorch`, `sAsh`. Ink fills char solid with the brush (its pen `press` noise shows as blocks on a big fill), cel flat black with pale checks, wash a charcoal glaze.
- Not done: eaten edges on battens and barrel staves; ash and charcoal on the ground; the dark liner seen through burnt gaps is plain, not charred.

## Styles

- A style is a last stage of the material shader (`uStyle`: 0 real, 1 cel, 2 ink, 3 watercolour). The realistic material is computed first and leaves facts behind in `s*` variables (ring field and its width, knot distance, cracks, seams, grey, wear, damp, dirt, rust, marking coverage and colour); the style redraws from those. Nothing in a style reads the finished realistic colour.
- `lineCov(distance, width, texel)` draws an anti-aliased line. Line widths are in metres (`uStA.x`, set in millimetres in the panel).
- Paper is a grey detail tile (0.5 = flat) from `src/assets/papers.js`, sampled in world space by dominant axis (wrapped round a barrel), so the sheet runs unbroken across each side of the object and ignores island seams. The tile must be featureless: `pack_papers.py` takes the calmest quarter of the scan and high-passes it, and the shader adds two layers at different scales turned against each other. A scan with a bloom in it showed up as the same blotch repeated up the barrel.
- Light is the engine's business. `src/shaders/style.js` holds the light-dependent part of each style (`styleCel`, `styleInk` / `styleHatch`, `styleWash`, plus `styleLight` and `styleSheet`) as one GLSL string used three ways: the viewer runs it every frame with its own light (`S.shade` = toon / ink / wash), the bake runs it once with a fixed sun when a style's Light is set to "Painted in" (then the viewer shows it unlit and export adds `KHR_materials_unlit`), and Save > Style shader writes it out with the noise functions for a game to port. Change the look of a shadow in that file and all three change together.
- **Pen pressure** (`stylePress`, shared by bake and viewer) is gradient noise and gentle (±6%). It was value noise at ±28%, whose square lattice showed as pixel blotches over any large fill: a big stencil, a label, shadow pushed to solid at Shadow 1.7. Markings ink only as dark as they are (`markDark` from `sMarkCol`), so a cream label is paper with its printing inked, not a solid block.
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

## Viewer

- When the model's bounds change (debris spreads), the camera glides to the new framing (`S.goal`, eased in `tick()` each frame, about a third of a second). Panning cancels the glide; zooming moves its goal.

## Workflow

- `npm run build` (or `node build.js --dev` for an unminified page), `npm test` for geometry invariants.
- There is no automated browser test yet. Visual checks so far were by screenshot through a static server on port 8765.
- `window.app` in the page exposes everything: `app.rebuild('all' | 'look')`, `app.params`, `app.look`, `app.marks`, `app.view.cam`, `app.view.S` (mode, atlas, wire, lod), `app.exportGLB()`.

## Publishing

- `npm run build` writes the release page to `docs/index.html` as well as `dist/`. GitHub Pages serves `docs/` from the main branch. `dist/`, `shots/` and `assets_raw/` are not committed.
- `tools/gen_*.py` need an OpenAI-style image server; set `IMAGE_HOST`.
- Public at https://github.com/ngutten/stave-and-batten (CC0), served at https://ngutten.github.io/stave-and-batten/. To publish a change: `npm run build`, commit on `main`, push `main`. Only `main` is public; any other local branch stays local.

## Plan, 2026-11-20 (labels, then fire)

Written before any code, as the session asked. Struck through or amended as it turns out.

### Labels (from a friend's look at it) — done, see "Markings over battens"; Nich asked for creases rather than plain tearing, and a spray lee for paint
Seen: a label pasted across a brace runs on over the batten and the boards beside it as if printed there, and on a Warehouse crate the top is stained while the label looks new.
- **Plain face** (Joinery): leave the brace or mid rail off one wall so a label has clear boards.
- **A label tears where the surface steps**: within a few millimetres of an island edge (`e`) the paper is cracked or gone, so across a batten it breaks at both edges, and it cracks along board gaps.
- **A label ages with the crate**: yellows unevenly and most at its edges, foxes with age and damp, its ink fades with sun, it drinks spills and water (darker and with a tide line than the wood beside it), and the weather adds to its tearing. "Worn away" still adds on top.

### Fire
Story: **the fire is the last thing that happened.** Char covers patina, grime, paint, labels; nothing has weathered since.
- **One heat field**, `heat(p)` in rest space (so a piece that fell keeps the char it had where it stood), written once in `damage.js` and mirrored in GLSL, the way `hurt` is. Params: Fire (amount) and Seat (beside / beneath / inside), the seat point drawn from its own stream `'fire'` so blows never move it. Shape: a plume over the seat whose radius grows with height (the V a fire leaves on a wall), plus a pool of heat near the seat. The shader adds what JS cannot cheaply know: faces turned to the seat burn more, sheltered ones less (occlusion), arrises first.
- **Wood by heat H:** ~.15–.35 scorched (toasted, earlywood first; labels brown then go; paint blisters dark) · ~.35–.65 charred: black, alligatored (cracks across the grain every 1–2 cm, along it more closely; block tops with a faint silver sheen, cracks matte) · above ~.65 deep char: larger blocks, deeper cracks, pale ash lying on upward faces, edges eaten · above 1 burnt through (geometry).
- **Soot:** a wider, taller plume outside the char, heaviest on downward faces and under overhangs, on iron too.
- **Iron:** temper colours (straw, brown, purple, blue, grey), then black scale.
- **Geometry (crate):** sample heat along each board and batten in its rest frame; the stretch over the threshold is consumed, the rest kept with a charred ragged end; pieces left with nothing holding them fall as charred debris; consumed battens count as gone for the collapse rule. **Barrel:** staves burnt short on the seat side; hoops drop when the staves under them go.
- **Styles:** new facts `sChar`, `sSoot`, `sAsh`; each style draws char as its darkest mark (cel flat black with crack lines, ink solid black with white cracks, wash a charcoal glaze).
- **Order:** labels; heat field and surface, then look at it from several seats and amounts; crate geometry; barrel; styles; maybe history presets ("Scorched", "Burnt out").
- *Outcome:* the plan's surface work held; its geometry did not. Burning boards and battens through (as planned) left floating pieces and read as impact damage, so fire now only chars and eats board edges, and breaks stay the damage dial's; see "Fire". No presets. Nich's corrections along the way: char was too uniform and too light, and scorch must follow the grain (his reference photos); labels over battens must be stretched paper, not a decal that follows the step (now geometry, `sheet.js`); paint should blur in a batten's lee; stencil labels printed white on black (a bug).

## Next

Agreed with Nich on 2026-11-18 as later extensions, not started:

- **Sci-fi makes.** A separate build, not a re-skin: polymer shells, curved surfaces, metal beams, hexagonal punched gratings. Needs a painted-metal / polymer material family (paint chipping to primer and bare metal at edges), its own damage vocabulary (dents, scorches, blown panels), and probably an emissive map.
- **Fire damage.** Another kind of damage and grunge: charring that follows the grain, alligatored char on the surface, scorch halos, soot rising above where it burned, boards burned through.
- Smaller: lichen is weak (pale blobs) and shares the moss slider; watercolour is the weakest style; damaged-barrel LOD1 is still heavy; debris never leans against what still stands; per-fragment export nodes; "Over battens" no longer carries a barrel marking across the hoops; loading a recipe; automated browser tests; engine ports of the style shader; a 4096 bake has never been seen to complete on the development machine.
