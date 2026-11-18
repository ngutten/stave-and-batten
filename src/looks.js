// Species and weathering presets. Colours are sRGB.
export const SPECIES = {
  pine: { label: 'Pine', early: [0.80, 0.68, 0.49], late: [0.55, 0.37, 0.21], heartTint: [0.97, 0.90, 0.82], knotCol: [0.27, 0.16, 0.085], ringW: 0.0040, lateStart: 0.66, knots: 1.0, pores: 0, rays: 0, figure: 1.0 },
  oak: { label: 'Oak', early: [0.70, 0.56, 0.37], late: [0.50, 0.36, 0.21], heartTint: [0.90, 0.84, 0.78], knotCol: [0.26, 0.16, 0.09], ringW: 0.0034, lateStart: 0.42, knots: 0.18, pores: 1, rays: 1, figure: 0.8 },
  larch: { label: 'Larch', early: [0.80, 0.56, 0.36], late: [0.52, 0.27, 0.13], heartTint: [0.92, 0.74, 0.62], knotCol: [0.30, 0.14, 0.07], ringW: 0.0040, lateStart: 0.38, knots: 0.7, pores: 0, rays: 0, figure: 0.9 },
  walnut: { label: 'Walnut', early: [0.42, 0.29, 0.19], late: [0.25, 0.16, 0.10], heartTint: [0.80, 0.74, 0.72], knotCol: [0.12, 0.07, 0.05], ringW: 0.0045, lateStart: 0.55, knots: 0.25, pores: 0.5, rays: 0, figure: 1.3 },
};

export const LOOK_PARAMS = [
  { key: 'species', label: 'Timber', options: Object.keys(SPECIES).map((k) => [k, SPECIES[k].label]), group: 'Wood' },
  { key: 'relief', label: 'Grain relief', min: 0, max: 2, step: 0.01, group: 'Wood' },
  { key: 'sawn', label: 'Saw marks', min: 0, max: 1, step: 0.01, group: 'Wood' },
  { key: 'checks', label: 'Checks & splits', min: 0, max: 1, step: 0.01, group: 'Wood' },
  { key: 'sapstain', label: 'Sapstain', min: 0, max: 1, step: 0.01, group: 'Wood' },
  { key: 'age', label: 'Age', min: 0, max: 1, step: 0.01, group: 'Weather', hint: 'Patina: sheltered wood ambers and darkens' },
  { key: 'sun', label: 'Sun & rain', min: 0, max: 1, step: 0.01, group: 'Weather', hint: 'Wood left under open sky turns silver; what a batten shelters stays brown' },
  { key: 'dirt', label: 'Grime', min: 0, max: 1, step: 0.01, group: 'Weather' },
  { key: 'damp', label: 'Rising damp', min: 0, max: 1, step: 0.01, group: 'Weather', hint: 'Ground water wicking up from the floor' },
  { key: 'rust', label: 'Rust', min: 0, max: 1, step: 0.01, group: 'Weather' },
  { key: 'wear', label: 'Edge wear', min: 0, max: 1, step: 0.01, group: 'Weather' },
  { key: 'stains', label: 'Spills', min: 0, max: 1, step: 0.01, group: 'Grunge', hint: 'Dried rings on the top, runs down the sides' },
  { key: 'stainCol', label: 'Spilt', type: 'color', group: 'Grunge' },
  { key: 'splash', label: 'Splashes', min: 0, max: 1, step: 0.01, group: 'Grunge', hint: 'Paint or mud flung across it' },
  { key: 'splashCol', label: 'Splashed', type: 'color', group: 'Grunge' },
  { key: 'wet', label: 'Wet patches', min: 0, max: 1, step: 0.01, group: 'Grunge' },
  { key: 'moss', label: 'Moss and lichen', min: 0, max: 1, step: 0.01, group: 'Grunge', hint: 'Moss where it stays damp, lichen where it sees the sky' },
  { key: 'rot', label: 'Rot', min: 0, max: 1, step: 0.01, group: 'Grunge', hint: 'From the ground up, and in at the end grain' },
];

// Where has it been?
export const HISTORIES = {
  'Fresh from the mill': { age: 0.04, sun: 0.0, dirt: 0.04, damp: 0.0, rust: 0.05, wear: 0.08, stains: 0, splash: 0, wet: 0, moss: 0, rot: 0 },
  'Warehouse': { age: 0.45, sun: 0.08, dirt: 0.40, damp: 0.10, rust: 0.40, wear: 0.50, stains: 0.2, splash: 0, wet: 0, moss: 0, rot: 0 },
  'Dockside': { age: 0.55, sun: 0.62, dirt: 0.45, damp: 0.40, rust: 0.90, wear: 0.70, stains: 0.35, splash: 0, wet: 0.3, moss: 0.25, rot: 0.15 },
  'Cellar': { age: 0.75, sun: 0.0, dirt: 0.70, damp: 0.80, rust: 0.80, wear: 0.40, stains: 0.5, splash: 0, wet: 0.35, moss: 0.5, rot: 0.4 },
  'Shipwreck': { age: 0.90, sun: 0.95, dirt: 0.55, damp: 1.0, rust: 1.0, wear: 1.0, stains: 0.1, splash: 0, wet: 0.5, moss: 0.75, rot: 0.8 },
};

export function defaultLook() {
  return {
    species: 'pine',
    relief: 1.0, checks: 0.6, sawn: 0.55, sapstain: 0.6, normalStrength: 1.0,
    stainCol: '#5a3a22', splashCol: '#c9c2ae',
    ...HISTORIES.Warehouse,
  };
}

// Styles: the same object, redrawn in another medium. shade is how the
// viewer lights it (and what the exported material asks an engine to do).
export const STYLES = {
  real: { label: 'Realistic', shade: 'pbr' },
  cel: { label: 'Cel', shade: 'toon', line: 1.6, detail: 0.35, light: 0.0, a: 0, b: 0, c: 0, ink: '#2a1c16', paper: '#ffffff' },
  ink: { label: 'Ink', shade: 'unlit', lit: 'dynamic', paperTex: 'parchment', line: 1.3, detail: 0.5, light: 1.0, a: 0.6, b: 0.5, c: 0, ink: '#2b1a10', paper: '#ecd9b0' },
  wash: { label: 'Watercolour', shade: 'unlit', lit: 'dynamic', paperTex: 'wash', line: 1.2, detail: 0.4, light: 1.0, a: 0.6, b: 0.5, c: 0.5, ink: '#333333', paper: '#fbf8f0' },
};
export const STYLE_PARAMS = {
  cel: [
    { key: 'line', label: 'Outline', min: 0, max: 4, step: 0.05, hint: 'Width of the dark line round every piece, in millimetres' },
    { key: 'detail', label: 'Grain lines', min: 0, max: 1, step: 0.01 },
    { key: 'light', label: 'Painted shadow', min: 0, max: 1, step: 0.01, hint: 'Shadow painted into the texture, for engines that will not light it' },
    { key: 'ink', label: 'Line colour', type: 'color' },
  ],
  ink: [
    { key: 'line', label: 'Pen width', min: 0.3, max: 4, step: 0.05 },
    { key: 'detail', label: 'Grain lines', min: 0, max: 1, step: 0.01 },
    { key: 'lit', label: 'Light', options: [['dynamic', 'From the engine (needs the shader)'], ['baked', 'Painted in (no shader)']], hint: 'Whether shadow is drawn by a shader as the light moves, or painted into the texture once' },
    { key: 'light', label: 'Shadow', min: 0, max: 1.7, step: 0.01, hint: 'Past 1 the shadows fill in toward solid black' },
    { key: 'a', label: 'Hatching', min: 0, max: 1, step: 0.01, hint: 'How closely the shadow lines are laid' },
    { key: 'b', label: 'Foxing', min: 0, max: 1, step: 0.01, hint: 'Brown age stains in the parchment' },
    { key: 'ink', label: 'Ink', type: 'color' },
    { key: 'paper', label: 'Parchment', type: 'color' },
  ],
  wash: [
    { key: 'line', label: 'Dry edge', min: 0.3, max: 4, step: 0.05, hint: 'The bare gap each wash leaves at the edge of a piece' },
    { key: 'detail', label: 'Grain', min: 0, max: 1, step: 0.01 },
    { key: 'lit', label: 'Light', options: [['dynamic', 'From the engine (needs the shader)'], ['baked', 'Painted in (no shader)']], hint: 'Whether shadow is drawn by a shader as the light moves, or painted into the texture once' },
    { key: 'light', label: 'Shadow glaze', min: 0, max: 1.5, step: 0.01 },
    { key: 'a', label: 'Granulation', min: 0, max: 1, step: 0.01 },
    { key: 'b', label: 'Blooms', min: 0, max: 1, step: 0.01 },
    { key: 'c', label: 'Pencil', min: 0, max: 1, step: 0.01 },
    { key: 'paper', label: 'Paper', type: 'color' },
  ],
};
