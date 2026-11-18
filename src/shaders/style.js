// The part of each drawn style that depends on light. The bake uses these to
// paint light into a texture; the viewer uses the very same functions every
// frame with its own moving light; and they are what "Save > Shader" writes
// out, for a game to do the same. Needs the noise functions (shaders/noise.js).
//
// light: one number, 0 dark to 1 fully lit, from whatever the engine knows.
// pp:    a point on the sheet the picture is drawn on, in metres (styleSheet).
// Pass object-space position and normal for anything that moves, or the
// strokes will stay still while the object slides underneath them.
export const STYLE_GLSL = `
// A surface turned away from the light is in shadow whatever the shadow map
// says (shadow maps are noise there, which a hatching threshold would show).
float styleLight(vec3 N, vec3 L, float shadow, float ao){
  float nl = dot(N, L), s = shadow * smoothstep(0.0, 0.12, nl);
  return sat((0.5 + 0.5 * nl) * mix(0.60, 1.0, s) * (0.3 + 0.7 * ao));
}

// The sheet runs unbroken across each side of the object. wrap = (1, radius) for something round and upright, a barrel.
vec2 styleSheet(vec3 P, vec3 N, vec2 wrap){
  vec3 an = abs(N);
  return an.y > 0.7 ? P.xz : wrap.x > 0.5 ? vec2(atan(P.z, P.x) * wrap.y, P.y) : an.x > an.z ? P.zy : P.xy;
}

// coverage of a line of width w at distance d from its centre; aa is the size of a pixel (or texel) in the same units
float styleLine(float d, float w, float aa){ return sat((0.5 * w - d) / aa + 0.5); }

// ---- cel: two flat tones with a hard edge between them, and a thin rim of light ----
vec3 styleCel(vec3 col, vec3 N, vec3 V, vec3 L, float shadow, float ao, vec3 rimDir){
  float lit = smoothstep(0.02, 0.07, dot(N, L)) * smoothstep(0.35, 0.55, shadow);
  vec3 c = col * mix(vec3(0.50, 0.47, 0.62), vec3(1.06, 1.03, 0.98), lit) * (0.80 + 0.20 * ao);
  return c + col * 0.35 * smoothstep(0.62, 0.70, 1.0 - max(dot(N, V), 0.0)) * smoothstep(0.0, 0.3, dot(N, rimDir) + 0.4);
}

// ---- pen and ink: shadow is hatching ----
// How dark the pen should make it: 0 bare paper, 1 and beyond black. strength above 1 pushes shadows into solid black.
float styleInkTone(float light, float strength){ return strength * smoothstep(0.25, 1.0, 1.0 - light); }

// Short strokes laid side by side; a second set across them as it darkens; a
// third, closer and steeper; and past that the shadow fills in toward solid.
// pen: stroke width, spacing: distance between strokes (both metres).
// From far enough away that strokes cannot be told apart, each set fades to
// the grey it averages to, so the tone holds at any distance.
float styleHatch(vec2 pp, float tone, float pen, float spacing, float aa){
  float ink = 0.0;
  for(int k = 0; k < 3; k++){
    float ang = k == 0 ? 0.7854 : k == 1 ? -0.7854 : 1.31;
    vec2 dir = vec2(cos(ang), sin(ang));
    float sp = spacing * (k == 0 ? 1.0 : k == 1 ? 0.88 : 0.62);
    float across = dot(pp, vec2(-dir.y, dir.x)), along = dot(pp, dir);
    float c = across / sp + 0.22 * gnoise(vec3(pp * 7.0, float(k) * 4.0 + 1.0)), i = floor(c);
    float sl = 0.05 + 0.05 * hash2(i, 5.0 + float(k)), sa = along / sl + hash2(i, 11.0) * 7.0, si = floor(sa);
    float thr = k == 0 ? 0.33 : k == 1 ? 0.62 : 0.86;
    float on = smoothstep(-0.02, 0.02, tone + 0.22 * (hash2(i + 31.0 * si, 3.0 + float(k)) - 0.5) - thr);
    float lift = smoothstep(0.0, 0.10, fract(sa)) * smoothstep(1.0, 0.82, fract(sa));       // the pen lifts between strokes
    float near = styleLine(abs(fract(c) - 0.5) * sp, pen * 0.5, aa) * lift * on;
    float far = sat(pen * 0.5 / sp) * 0.85 * smoothstep(-0.11, 0.11, tone - thr);
    ink = max(ink, mix(near, far, smoothstep(0.25, 0.6, aa / sp)));
  }
  // past that the shadow is filled in, evenly: ink laid on with the flat of the nib
  return max(ink, smoothstep(1.05, 1.55, tone) * (0.90 + 0.10 * vnoise(vec3(pp * 300.0, 6.0))));
}
vec3 styleInk(vec3 col, vec3 inkCol, vec2 pp, float light, float strength, float pen, float spacing, float aa){
  float ink = styleHatch(pp, styleInkTone(light, strength), pen, spacing, aa);
  return mix(col, inkCol, ink * (0.72 + 0.28 * vnoise(vec3(pp * 70.0, 2.0))));
}

// ---- watercolour: shadow is a second glaze of the same paint ----
// Laid wet on dry, so it has a hard, wandering edge where pigment pools; and
// the brightest planes are lifted back toward bare paper. col / paper is how
// much pigment is there already; a glaze is that much again.
vec3 styleWash(vec3 col, vec3 paper, vec2 pp, float light, float strength){
  float wob = 0.07 * gnoise(vec3(pp * 6.0, 2.0)) + 0.03 * gnoise(vec3(pp * 23.0, 5.0));
  float d = 1.0 - light + wob;
  float shade = smoothstep(0.44, 0.50, d), pool = shade * (1.0 - smoothstep(0.50, 0.58, d));
  float bare = smoothstep(0.76, 0.92, light + wob);
  vec3 t = clamp(col / max(paper, vec3(1e-3)), 0.0, 1.0);
  return paper * pow(t, vec3(max(0.2, 1.0 + strength * (0.90 * shade + 0.40 * pool - 0.55 * bare))));
}
`;
