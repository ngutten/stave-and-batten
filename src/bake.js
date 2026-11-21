// The bake: everything is drawn in UV space.
//
//   1. stamps    nails (and later stencils, stains) are instanced quads that
//                write masks, not colours
//   2. occlusion real ambient occlusion and sky exposure, by rendering depth
//                from many directions and testing every texel against it
//   3. material  one shader composes wood, metal and weathering per texel,
//                knowing position, normal, log coordinates, edge distance,
//                occlusion, exposure and the stamp masks
//   4. resolve   height -> tangent-space normal; pack ORM; encode albedo
//   5. dilate    bleed islands outward so mips and filtering never see a seam

import { program, use, target, bindTarget, freeTarget, vao, drawQuad, QUAD_VS, M4, texture } from './gl.js';
import { bakeArrays, geoArrays, bounds } from './model.js';
import { NOISE } from './shaders/noise.js';
import { WOOD } from './shaders/wood.js';
import { SPECIES } from './looks.js';
import { STYLE_GLSL } from './shaders/style.js';

const BAKE_VS = `#version 300 es
layout(location=0) in vec2 aUV; layout(location=1) in vec3 aPos; layout(location=2) in vec3 aNrm; layout(location=3) in vec3 aTan;
layout(location=4) in vec3 aLog; layout(location=5) in vec4 aFace; layout(location=6) in vec4 aIds; layout(location=7) in vec4 aExtra; layout(location=8) in vec3 aRest;
out vec3 vPos, vNrm, vTan, vLog, vRest; out vec4 vFace; flat out vec4 vIds; flat out vec4 vExtra;
void main(){ vRest=aRest; vPos=aPos; vNrm=aNrm; vTan=aTan; vLog=aLog; vFace=aFace; vIds=aIds; vExtra=aExtra; gl_Position = vec4(aUV*2.0-1.0, 0.0, 1.0); }`;
const BAKE_LOCS = { uv: 0, pos: 1, nrm: 2, tan: 3, log: 4, face: 5, ids: 6, extra: 7, rest: 8 };

const MATERIAL_FS = `#version 300 es
precision highp float; precision highp int;
${NOISE}
const float FOOT_A = 0.019;   // stamp A at a batten's foot; falls to 0 at 3 cm out (stamp type 4)
${WOOD}
uniform sampler2D uStamps, uOcc;
uniform float uTexel, uSawn, uAge, uSun, uDirt, uDamp, uRust, uWear, uSeed, uModelH;
in vec3 vPos, vNrm, vTan, vLog, vRest; in vec4 vFace; flat in vec4 vIds; flat in vec4 vExtra;
layout(location=0) out vec4 oAlbedo;

// Markings: images projected onto the object as it stood before any damage.
// kind 0 projects along a plane's normal, kind 1 wraps round a barrel.
#define NDECAL 4
uniform sampler2D uDecal0, uDecal1, uDecal2, uDecal3;
uniform vec4 uDkA[NDECAL];   // kind, mode, opacity, wear   (mode: 0 paint, 1 brand, 2 chalk, 3 label; kind < 0 = off)
uniform vec4 uDkU[NDECAL];   // u axis, 1 / width
uniform vec4 uDkV[NDECAL];   // v axis, 1 / height
uniform vec4 uDkN[NDECAL];   // normal, depth centre
uniform vec4 uDkO[NDECAL];   // origin, depth half window
uniform vec4 uDkC[NDECAL];   // colour, rotation
uniform vec4 uDkP[NDECAL];   // centre offset (m) in u and v, 1 if over battens, 1 if a printed label; barrel profile is in uCyl
uniform vec4 uCyl;           // head radius, bilge radius, height
vec4 decalTex(int i, vec2 uv, float lod){
  if(i == 0) return textureLod(uDecal0, uv, lod); if(i == 1) return textureLod(uDecal1, uv, lod);
  if(i == 2) return textureLod(uDecal2, uv, lod); return textureLod(uDecal3, uv, lod);
}
// returns the image sample (rgb, coverage) and a blurred coverage for halos
bool decalAt(int i, vec3 p, float texel, out vec4 tex, out float soft, out vec3 uvl){
  vec4 A = uDkA[i]; if(A.x < 0.0) return false;
  vec3 d = p - uDkO[i].xyz; vec2 q; float depth;
  if(A.x < 0.5){ q = vec2(dot(d, uDkU[i].xyz), dot(d, uDkV[i].xyz)); depth = dot(d, uDkN[i].xyz); }
  else {
    // unrolled round the bilge: angle from the decal's facing direction, and height
    float ang = atan(dot(d, uDkU[i].xyz), dot(d, uDkN[i].xyz));
    float k = 2.0 * p.y / uCyl.z - 1.0, rex = uCyl.x + (uCyl.y - uCyl.x) * (1.0 - k * k);
    q = vec2(ang * uCyl.y, d.y); depth = uDkN[i].w;
    if(vExtra.w < 0.5) return false;          // only the outside of a stave takes paint
  }
  if(abs(depth - uDkN[i].w) > uDkO[i].w) return false;
  q -= uDkP[i].xy;
  float cr = cos(uDkC[i].w), sr = sin(uDkC[i].w); q = vec2(cr * q.x + sr * q.y, -sr * q.x + cr * q.y);
  vec2 uv = vec2(q.x * uDkU[i].w, q.y * uDkV[i].w) + 0.5;
  if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return false;
  // the image is at most a few hundred pixels across; do not sample it finer than the bake can show
  float lod = max(0.0, log2(texel * max(uDkU[i].w, uDkV[i].w) * 256.0));
  tex = decalTex(i, uv, lod); soft = decalTex(i, uv, lod + 3.2).a; uvl = vec3(uv, lod);
  return true;
} layout(location=1) out vec4 oSurf; layout(location=2) out vec4 oAux;

// Drawn styles. The realistic material is worked out first; a style then
// redraws it from the same facts (where the edges, rings, knots, cracks, nails,
// stains and shadows are) in its own medium.
uniform int uStyle;          // 0 as it is, 1 cel, 2 ink on parchment, 3 watercolour (made a constant per program, see materialFor)
uniform vec4 uStA;           // line weight (m), detail, baked light, -
uniform vec4 uStB;           // per style
uniform vec3 uInkCol, uPaperCol;
uniform sampler2D uPaper;    // grey swatch of the paper, 0.5 = flat
uniform vec4 uWrap;          // 1 if the object is round (a barrel), its radius
float lineCov(float d, float w, float texel){ return sat((0.5 * w - d) / texel + 0.5); }
${STYLE_GLSL}

// Grunge: spills, splashes and runs, scattered over the sheet that wraps each
// side of the object (so one spill crosses several boards). The shapes come
// from an atlas, four to a row: row 0 spills, 1 splatters, 2 drips.
uniform sampler2D uGrunge;
uniform vec4 uGr, uGr2;      // stains, wet, splashes, moss; rot
uniform vec4 uFire;          // amount (0 = none), plume radius at the seat, its spread with height, height scale (damage.js fireField)
uniform vec3 uFireSeat;      // where it burned
// the same field as damage.js fireField().heat: keep the two in step
float heatAt(vec3 p, float grow){
  vec3 d = p - uFireSeat.xyz; float up = max(d.y, 0.0);
  float R = (uFire.y + up * uFire.z) * grow;
  return 2.2 * uFire.x * exp(-dot(d.xz, d.xz) / (R * R)) * exp(-up / (uFire.w * grow)) * (d.y < 0.0 ? exp(d.y / 0.04) : 1.0);
}
uniform vec3 uStainCol, uSplashCol;
// Runs down a side: drip shapes hung from the top edge of the object, one per
// cell along it, each its own length.
vec2 runs(vec2 p, float cell, float density, float top, float key, float texel){
  float gi = floor(p.x / cell); vec2 best = vec2(0.0);
  for(int x = -1; x <= 1; x++){
    int c = int(gi) + x;
    vec3 h = hash3v(ivec3(c, 3, int(key)));
    if(h.z > density) continue;
    vec3 h2 = hash3v(ivec3(c + 57, 9, int(key) + 7));
    float r = cell * (0.35 + 0.65 * h2.x);
    vec2 d = (p - vec2((float(c) + 0.25 + 0.5 * h.x) * cell, top - r * 0.80)) / r;
    if(abs(d.x) >= 1.0 || abs(d.y) >= 1.0) continue;
    vec2 uv = (vec2(floor(h2.z * 3.999), 2.0) + vec2(d.x, -d.y) * 0.5 + 0.5) / vec2(4.0, 3.0);
    float lod = clamp(log2(texel / r * 64.0), 0.0, 3.0);
    best = max(best, vec2(textureLod(uGrunge, uv, lod).r, textureLod(uGrunge, uv, lod + 2.5).r));
  }
  return best;
}
// One shape per cell of a grid, at a random place, size and turn. Returns its
// coverage and a blurred coverage (for the ring a drying stain leaves).
vec2 splat(vec2 p, float cell, float density, float row, float upright, float key, float texel){
  vec2 gi = floor(p / cell), best = vec2(0.0);
  for(int y = -1; y <= 1; y++) for(int x = -1; x <= 1; x++){
    ivec2 c = ivec2(int(gi.x) + x, int(gi.y) + y);
    vec3 h = hash3v(ivec3(c, int(key)));
    if(h.z > density) continue;
    vec3 h2 = hash3v(ivec3(c.x + 57, c.y - 13, int(key) + 7));
    float r = cell * (0.30 + 0.60 * h2.x);
    vec2 d = (p - (vec2(c) + 0.25 + 0.5 * h.xy) * cell) / r;
    float a = upright > 0.5 ? 0.0 : h2.y * 6.2832;
    d = mat2(cos(a), sin(a), -sin(a), cos(a)) * d;
    if(abs(d.x) >= 1.0 || abs(d.y) >= 1.0) continue;
    vec2 uv = (vec2(floor(h2.z * 3.999), row) + vec2(d.x, -d.y) * 0.5 + 0.5) / vec2(4.0, 3.0);       // image tops are up
    float lod = clamp(log2(texel / r * 64.0), 0.0, 3.0);
    best = max(best, vec2(textureLod(uGrunge, uv, lod).r, textureLod(uGrunge, uv, lod + 2.5).r));
  }
  return best;
}

void main(){
  ivec2 px = ivec2(gl_FragCoord.xy);
  vec4 st = texelFetch(uStamps, px, 0);
  vec4 oc = texture(uOcc, gl_FragCoord.xy / vec2(textureSize(uStamps, 0)));
  float ao = oc.r, sky = oc.g;
  int mat = int(vIds.x + 0.5);
  float dens = max(vIds.w, 0.05), texel = uTexel / dens;
  // a fresh break has seen none of the weather; the ghost of a lost batten has seen little
  float fresh = vExtra.y, ghostIn = smoothstep(0.45, 0.9, st.a), ghostEdge = (1.0 - abs(st.a * 2.0 - 1.0)) * step(0.02, st.a);
  float age = uAge * (1.0 - 0.9 * fresh) * (1.0 - 0.45 * ghostIn), sun = uSun * (1.0 - 0.95 * fresh) * (1.0 - 0.93 * ghostIn);
  float dirtK = uDirt * (1.0 - 0.85 * fresh), dampK = uDamp * (1.0 - 0.6 * fresh);
  float e = min(min(vFace.x, vFace.z - vFace.x), min(vFace.y, vFace.w - vFace.y));
  vec3 col = vec3(0.5); float h = 0.0, rough = 0.8, metal = 0.0, cav = 1.0, line = 0.0, knot = 0.0;
  float n1 = fbm(vPos*7.0 + uSeed), n2 = fbm(vPos*23.0 + 3.0 + uSeed), n3 = vnoise(vPos*90.0);
  float shelter = 1.0 - sky, sideness = 1.0 - abs(vNrm.y);
  // runoff: rain takes the same paths down a face every time
  vec3 sp = vec3(vPos.x * 60.0, vPos.y * 1.7, vPos.z * 60.0) + uSeed;
  float streak = (smoothstep(0.55, 0.9, vnoise(sp)) * 0.6 + smoothstep(0.6, 0.95, vnoise(sp * vec3(2.3, 1.4, 2.3) + 9.0)) * 0.4) * sideness;
  float soak = 0.0;      // how readily this surface wicks water (end grain most)
  // fire, the last thing that happened to it: the heat this face took (faces turned to the flames and
  // arrises most), and the soot that rose past it
  float fireH = 0.0, sootK = 0.0;
  if(uFire.x > 0.0){
    vec3 Nf = normalize(vNrm);
    float toward = dot(Nf, normalize(uFireSeat.xyz + vec3(0.0, 0.25, 0.0) - vRest));
    float H0 = heatAt(vRest, 1.0);
    fireH = H0 * (0.72 + 0.38 * toward) * (0.75 + 0.5 * n1) + H0 * 0.35 * (1.0 - smoothstep(0.0, 0.008, e));
    fireH *= 1.0 - 0.5 * ghostIn;                     // a batten that burned away shielded the board under it for a while
    sootK = smoothstep(0.06, 0.40, heatAt(vRest, 1.9)) * (0.55 + 0.55 * max(-Nf.y, 0.0) + 0.35 * (1.0 - ao)) * smoothstep(-0.02, 0.12, vRest.y - uFireSeat.y);
  }
  float nailHead = 0.0, nailH = 0.0;
  float lateK = 0.5;
  // facts for the drawn styles
  float sF = 0.0, sFw = 1.0, sKrho = 9.0, sKr = 1.0, sCrack = 0.0, sEnd = 0.0, sGrey = 0.0, sWear = 0.0, sDamp = 0.0, sDirt = 0.0, sRust = 0.0, sMark = 0.0, sSeam = 0.0, sHole = 0.0;
  vec3 sFlat = vec3(0.5), sMarkCol = vec3(0.0), sKnotCol = vec3(0.1);
  float gStain = 0.0, gWet = 0.0, gSplash = 0.0, gMoss = 0.0, gRot = 0.0, gLabel = 0.0;
  float sChar = 0.0, sSoot = 0.0, sAsh = 0.0, sScorch = 0.0, sCharCrack = 0.0;

  if(mat == 0){
    Wood w = woodAt(vLog, vIds.y, texel, uKnots * (1.0 - vExtra.z));
    vec3 dx = dFdx(vLog), dy = dFdy(vLog);
    float endGrain = 1.0 - max(abs(dx.z)/max(length(dx),1e-9), abs(dy.z)/max(length(dy),1e-9));
    endGrain = smoothstep(0.5, 0.9, endGrain);
    col = w.col; h = w.h; rough = w.rough; knot = w.knot; line = w.late; soak = endGrain; lateK = w.late;
    sF = w.F; sFw = fwidth(w.F); sKrho = w.krho; sKr = w.kr; sCrack = w.crack; sEnd = endGrain; sFlat = w.flatc; sKnotCol = uKnotCol;

    // end grain drinks light
    col *= mix(1.0, 0.72, endGrain); rough = mix(rough, 0.88, endGrain);

    // rough-sawn faces: the arc of the blade, never evenly fed, clearer in some places than others
    float sh = hash1(vIds.y + 0.11), pitch = 0.0050 * (0.8 + 0.7 * sh);
    float Rs = 0.14 + 0.22 * hash1(vIds.y + 0.5), yy = vFace.y - vFace.w * (hash1(vIds.y + 0.7) * 1.6 - 0.3);
    float sc = vFace.x * (sh > 0.5 ? 1.0 : -1.0) + sqrt(max(Rs*Rs - yy*yy, 0.0));
    sc += 0.004 * gnoise(vec3(sc * 14.0, vIds.y * 91.0, 0.0)) + 0.0012 * gnoise(vec3(sc * 90.0, yy * 30.0, vIds.y * 7.0));
    // each tooth mark is its own: some deep, some skipped, none evenly spaced
    float sx = sc / pitch + 0.9 * gnoise(vec3(sc * 60.0, vIds.y * 33.0, 2.0)), si = floor(sx), sa = hash2(si, vIds.y * 977.0);
    float saw = (pow(1.0 - abs(fract(sx) - 0.5) * 2.0, 1.5) * 2.0 - 0.7) * smoothstep(0.25, 0.6, sa) * (0.5 + sa);
    float sawPatch = smoothstep(0.35, 0.75, vnoise(vec3(vFace.xy * vec2(5.0, 16.0), vIds.y * 13.0)));
    saw *= (1.0 - endGrain) * uSawn * (1.0 - smoothstep(0.35, 0.6, texel / pitch)) * (0.25 + 0.75 * sawPatch);
    h += saw * 0.00013; col *= 1.0 - 0.022 * saw;

    // checks
    h -= w.crack * 0.0012; col *= 1.0 - 0.75 * w.crack; cav *= 1.0 - 0.7 * w.crack;

    // patina: sheltered wood ambers and darkens
    col = mix(col, col * vec3(0.76, 0.61, 0.45), age * (0.45 + 0.5 * shelter));
    col = mix(col, vec3(luma(col)) * vec3(0.62, 0.55, 0.48), age * 0.30);
    // wood under open sky goes silver, soft spring wood first
    float grey = sat(sun * (0.30 + 1.8 * sky * sat(ao * 1.25) + 0.55 * n1 + 0.25 * endGrain + 0.35 * streak) - 0.10 * (1.0 - sun));
    grey = smoothstep(0.0, 1.0, grey) * (1.0 - 0.55 * w.knot);            // resin keeps a knot from silvering
    vec3 silver = mix(vec3(0.50, 0.48, 0.45), vec3(0.40, 0.41, 0.42), sat(0.5 + n1)) * (0.80 + 0.30 * n2) * mix(1.08, 0.66, w.late);
    col = mix(col, silver, grey * 0.94); sGrey = grey;
    col *= 1.0 - 0.5 * grey * smoothstep(0.90, 0.97, vnoise(vPos * 520.0)) * sun;     // mildew specks
    h += grey * uRelief * (w.late - 0.4) * 0.00040;                                    // weather eats the soft wood first
    rough = mix(rough, 0.93, grey * 0.8);

    // worn edges: soft, pale, a little chewed
    float wearN = 0.5 + 0.5 * n2 + 0.35 * (n3 - 0.5);
    float wear = uWear * (1.0 - smoothstep(0.0, 0.002 + 0.014 * uWear * wearN, e));
    col = mix(col, mix(w.base, silver * 1.15, grey * 0.6) * 1.12 + 0.02, wear * 0.6); sWear = wear;
    h -= 0.0010 * pow(1.0 - sat(e / 0.0035), 2.0);                  // every arris is slightly eased
    h -= wear * 0.0008 * (0.6 + 0.8 * n3);
    rough = mix(rough, 0.80, wear * 0.5);

    // a joint between two pieces that has no geometry of its own
    float seam = vExtra.x * (1.0 - smoothstep(0.0, 0.0011, e));
    col *= 1.0 - 0.82 * seam; cav *= 1.0 - 0.7 * seam; h -= seam * 0.0007; sSeam = seam;

    // markings: sprayed through a stencil, burnt in with an iron, chalked on, or pasted as a label
    for(int i = 0; i < NDECAL; i++){
      vec4 tx; float soft; vec3 uvl;
      if(!decalAt(i, vRest, texel, tx, soft, uvl)) continue;
      vec4 A = uDkA[i]; vec3 dc = uDkC[i].rgb; int mode = int(A.y + 0.5);
      float nearB = (st.a > 1e-4 && st.a < 0.02) ? (1.0 - st.a / FOOT_A) * 0.03 : 1.0;   // metres to the nearest batten's edge
      float fine = vnoise(vRest * 700.0), blot = 0.5 + 0.5 * fbm2(vRest * 30.0 + 5.0 * float(i));
      float cov = tx.a * (1.0 - 0.9 * ghostIn) * (1.0 - fresh) * (1.0 - endGrain * 0.5);
      if(mode == 0){
        // paint: soft at the edge, thin on the high grain, worn off edges and wherever the weather got at it.
        // Sprayed across a batten: beside it the boards were in the batten's lee, so the stencil's edge blurs there,
        // the paint thins and a mist of overspray drifts out; the batten's own sides catch it thinly.
        float lee = uDkP[i].z * (1.0 - smoothstep(0.0, 0.03, nearB));
        if(lee > 0.001){
          float blurA = decalTex(i, uvl.xy, uvl.z + 1.0 + 2.5 * lee).a * (1.0 - 0.9 * ghostIn) * (1.0 - fresh) * (1.0 - endGrain * 0.5);
          cov = mix(cov, blurA * (0.80 + 0.30 * fine), lee);
        }
        float faceP = A.x < 0.5 ? smoothstep(0.15, 0.9, abs(dot(normalize(vNrm), uDkN[i].xyz))) : 1.0;
        float mk = smoothstep(0.30, 0.62, cov + 0.10 * (fine - 0.5)) + 0.22 * soft * (1.0 - tx.a) * fine;
        mk = mk * (1.0 - 0.35 * lee) + lee * 0.5 * soft * smoothstep(0.80, 0.92, vnoise(vRest * 1100.0 + float(i)));
        mk *= 0.35 + 0.65 * faceP;
        mk *= 1.0 - smoothstep(0.45, 0.70, fireH + 0.1 * (fine - 0.5));             // burnt off
        dc *= 1.0 - 0.6 * smoothstep(0.15, 0.45, fireH);                         // blistered dark
        float gone = A.w * (0.15 + 1.5 * blot * blot + 1.2 * wear + 0.9 * grey + 0.5 * (w.late - 0.3));
        mk *= 1.0 - smoothstep(0.55, 0.95, gone + 0.45 * (fine - 0.5));
        mk *= 1.0 - 0.6 * w.crack;
        col = mix(col, dc * (0.80 + 0.25 * fine) * (1.0 - 0.25 * grey), sat(mk * A.z * (1.0 - 0.35 * sun)));
        if(mk * A.z > sMark){ sMark = mk * A.z; sMarkCol = dc; }
        rough = mix(rough, 0.62, mk * 0.5 * A.z);
      } else if(mode == 1){
        // a brand: charred and pressed in, scorched round about
        float ch = smoothstep(0.35, 0.60, cov + 0.12 * (fine - 0.5));
        col = mix(col, col * vec3(0.50, 0.33, 0.22), sat(soft * 1.4) * 0.65 * A.z);
        col = mix(col, vec3(0.022, 0.016, 0.012) * (1.0 + 0.8 * w.late + 0.6 * fine), ch * A.z * (1.0 - 0.3 * A.w * blot));
        h -= ch * 0.0007 * A.z; rough = mix(rough, 0.95, ch * 0.8); cav *= 1.0 - 0.35 * ch;
        if(ch * A.z > sMark){ sMark = ch * A.z; sMarkCol = vec3(0.03, 0.02, 0.015); }
      } else if(mode == 2){
        // chalk: catches on the ridges, rubs off easily
        float mk = sat(cov * 1.3) * (0.35 + 0.65 * fine) * (0.6 + 0.6 * sat(h * 4000.0 + 0.5));
        mk *= 1.0 - smoothstep(0.35, 0.9, A.w * (0.3 + 1.6 * blot * blot + wear));
        mk *= 1.0 - smoothstep(0.25, 0.45, fireH);
        col = mix(col, dc, sat(mk * A.z)); rough = mix(rough, 0.95, mk);
        if(mk * A.z > sMark){ sMark = mk * A.z; sMarkCol = dc; }
      } else {
        // a paper label: the image itself, and it has had the same years, sun, damp, grime and spills as the wood under it
        float weather = sat(0.40 * age + 0.35 * sun + 0.30 * dampK + 0.25 * dirtK + 0.30 * uGr.x + 0.25 * uGr.y);
        float worn = A.w + 0.6 * weather;
        // A stencil or typed text is printed in the mark's colour on a paper ground, with a margin round it;
        // a picture the user loaded is the label as it is.
        bool printed = uDkP[i].w > 0.5;
        float edgeUV = min(min(uvl.x, 1.0 - uvl.x), min(uvl.y, 1.0 - uvl.y));
        float rim = printed ? 1.0 - smoothstep(0.0, 0.07, edgeUV) : sat((1.0 - soft) * 2.5);   // near the label's own edge: it lifts and browns first
        float labCov = cov;
        vec3 inkLin = srgb2lin(tx.rgb);
        if(printed){
          vec2 gu = (uvl.xy - 0.5) * 1.22 + 0.5;
          float glyph = (gu.x > 0.0 && gu.x < 1.0 && gu.y > 0.0 && gu.y < 1.0) ? decalTex(i, gu, uvl.z).a : 0.0;
          inkLin = mix(vec3(0.83, 0.79, 0.68), dc, smoothstep(0.35, 0.65, glyph));
          labCov = (1.0 - 0.9 * ghostIn) * (1.0 - fresh) * (1.0 - endGrain * 0.5) * smoothstep(0.0, 0.004, edgeUV);
        }
        // Pasted over a batten, it was stretched across the step: over the batten's sides and the corner
        // beside it the paper is not stuck down but taut, a little paler; worn or weathered, that is where it
        // goes first. Over a board gap or an arris it holds while new and cracks as it ages.
        float overK = uDkP[i].z;
        float facing = A.x < 0.5 ? abs(dot(normalize(vNrm), uDkN[i].xyz)) : 1.0;
        float onSide = overK * (1.0 - smoothstep(0.75, 0.95, facing));                       // the step itself
        float bridged = max(onSide, overK * (1.0 - smoothstep(0.003, 0.018, nearB + 0.006 * (vnoise(vRest * 30.0 + 2.0) - 0.5))));
        float stepK = (1.0 - smoothstep(0.0012, 0.0025 + 0.006 * weather * (0.5 + blot), e + 0.0015 * (fine - 0.5))) * smoothstep(0.15, 0.45, worn);
        // a few soft creases where it was smoothed down into the corner
        float cx = nearB / (0.005 + 0.003 * vnoise(vRest * 14.0)) + 3.5 * fbm2(vRest * 26.0 + 9.0) + 1.5 * gnoise(vRest * 70.0);
        float crease = pow(1.0 - abs(fract(cx) - 0.5) * 2.0, 4.0) * overK * (1.0 - smoothstep(0.004, 0.03, nearB)) * smoothstep(0.35, 0.8, vnoise(vRest * 16.0 + 4.0)) * (1.0 - onSide);
        // paper comes away in pieces, not specks; the stretched parts first
        float tear = smoothstep(0.46, 0.54, A.w * (0.2 + 1.7 * blot * blot + 0.8 * wear) + weather * (0.05 + 0.6 * blot * blot + 0.45 * rim)
                                 + bridged * (0.25 + 0.9 * worn) + 0.12 * (fine - 0.5));
        tear = max(tear, stepK);
        float sideOK = A.x < 0.5 ? max(smoothstep(0.75, 0.95, facing), overK) : 1.0;       // not down the side of a step unless it was stretched over it
        float pa = smoothstep(0.4, 0.6, labCov) * (1.0 - tear) * sideOK * A.z;
        // ink fades in the sun; the paper yellows, most at its edges; brown spots come with age and damp
        vec3 ink = inkLin;
        ink = mix(ink, mix(vec3(luma(ink)), ink, 0.6) * 0.5 + 0.5 * max(ink, vec3(luma(ink))), sat(0.7 * sun + 0.2 * age));
        vec3 paper = ink * mix(vec3(1.0), vec3(0.80, 0.68, 0.48), sat(0.15 + 0.75 * weather * (0.6 + 0.5 * blot) + 0.5 * rim * weather)) * (0.92 + 0.16 * blot);
        float fox = smoothstep(0.80, 0.86, vnoise(vRest * 160.0 + 17.0 * float(i))) * sat(age * 1.4 + dampK) * (0.5 + 0.5 * fine);
        paper = mix(paper, paper * vec3(0.62, 0.45, 0.28), fox * 0.8);
        // water it has drunk dries to a tea-coloured patch with a darker tide line
        float ws = sat((0.8 * uGr.x + 0.7 * uGr.y + 0.6 * dampK) * 1.3);
        if(ws > 0.02){
          float wt = 0.5 + 0.5 * fbm2(vRest * 6.5 + 11.0 * float(i)), wl = 1.0 - 0.6 * ws;
          paper = mix(paper, paper * vec3(0.86, 0.74, 0.56), step(wl, wt) * 0.8);
          paper *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.012, abs(wt - wl)));
        }
        // paper goes first in a fire: it browns, then burns back to a black curled edge
        float burnP = smoothstep(0.15, 0.24, fireH + 0.08 * (blot - 0.5) + 0.03 * (fine - 0.5));
        paper = mix(paper, paper * vec3(0.60, 0.40, 0.20), smoothstep(0.05, 0.17, fireH));
        paper = mix(paper, vec3(0.02, 0.016, 0.012), sat(burnP * 4.0) * (1.0 - burnP));
        pa *= 1.0 - burnP;
        // the torn edge shows pale fibres
        float fringe = tear * (1.0 - tear) * 4.0 * smoothstep(0.4, 0.6, labCov) * sideOK;
        paper = mix(paper, paper * 1.06 + 0.01, bridged * 0.6);                              // taut, not soaked onto the wood
        if(pa > sMark){ sMark = pa; sMarkCol = paper; }
        col = mix(col, paper, pa); col = mix(col, vec3(0.62, 0.58, 0.50), fringe * 0.35 * A.z);
        rough = mix(rough, 0.82, pa); h += pa * 0.00012 - pa * 0.00008 * fine; cav = mix(cav, 1.0, pa);
        h += pa * crease * 0.0010; col = mix(col, col * (1.0 + 0.10 * crease) + 0.015 * crease, pa);     // a crease is a ridge, and the fibres whiten along it
        gLabel = max(gLabel, pa);
      }
    }

    // rust bleeding from iron
    float rust = sat(st.r * uRust * (0.75 + 0.5 * n2)); sRust = rust;
    col = mix(col, mix(vec3(0.20, 0.085, 0.03), vec3(0.045, 0.028, 0.02), sat(rust*1.5 - 0.35)) * (0.7 + 0.6 * w.late), sat(rust * 1.1));

    // nail heads: iron, not wood. The head has its own flat hammered face.
    nailHead = smoothstep(0.25, 0.75, st.g);
    if(nailHead > 0.0){
      float rusty = sat(uRust * 1.3 * (0.4 + 0.9 * vnoise(vPos * 400.0)) + 0.15);
      // dark iron; rust darkens it further before it reddens, and gathers at the rim
      float rim = smoothstep(0.55, 1.0, 1.0 - st.g + 0.25);
      vec3 iron = mix(vec3(0.20, 0.195, 0.19), mix(vec3(0.075, 0.05, 0.04), vec3(0.19, 0.08, 0.035), sat(rim + 0.5 * vnoise(vPos * 900.0) - 0.2)), rusty);
      col = mix(col, iron, nailHead); metal = nailHead * (1.0 - rusty * 0.7); rough = mix(rough, mix(0.40, 0.78, rusty), nailHead);
      cav *= 1.0 - 0.6 * nailHead * rim;
      line *= 1.0 - nailHead; knot *= 1.0 - nailHead;
    }
    nailH = -st.b / 2000.0 + 0.00004 * (vnoise(vPos * 1500.0) - 0.5);
    h -= st.b / 2000.0 * (1.0 - nailHead);
    cav *= 1.0 - 0.5 * sat(st.b * 1.25);
    // an empty nail hole
    float hole = smoothstep(0.75, 0.95, st.b);
    col *= 1.0 - 0.93 * hole; cav *= 1.0 - 0.8 * hole; sHole = hole;
    // torn fibres where it broke
    h += fresh * 0.0009 * (vnoise(vec3(vLog.xy * 260.0, vLog.z * 5.0)) - 0.5); rough = mix(rough, 0.9, fresh);
  } else if(mat == 1){
    // hoop iron: mill scale, hammer marks, a riveted lap, and rust that starts at the edges
    float along = vFace.x, across = vFace.y / vFace.w;
    float ms = smoothstep(-0.15, 0.35, n2 + 0.4 * n1);
    col = mix(vec3(0.31, 0.30, 0.29), vec3(0.085, 0.09, 0.105), ms * 0.75) * (0.9 + 0.25 * n3);
    metal = 1.0; rough = mix(0.38, 0.62, ms) + 0.1 * (n3 - 0.5);
    float scr = smoothstep(0.78, 0.92, vnoise(vec3(along * 25.0, vFace.y * 700.0, vIds.y * 50.0)));
    col += 0.10 * scr; rough -= 0.12 * scr;
    h = 0.00016 * fbm2(vec3(vFace.xy * 55.0, vIds.y * 9.0)) - 0.00005 * scr;
    if(vExtra.y > 0.5){
      float lx = along - vExtra.x;
      float lap = step(-0.085, lx) * (1.0 - smoothstep(-0.0012, 0.0012, lx));
      h += lap * 0.0016;
      cav *= 1.0 - 0.6 * (1.0 - smoothstep(0.0, 0.004, abs(lx)));
      for(int i=0;i<2;i++){
        vec2 rc = vec2(-0.022 - 0.040 * float(i), vFace.w * 0.5);
        float rd = length(vec2(lx, vFace.y) - rc) / (vFace.w * 0.17);
        float dome = sqrt(max(1.0 - rd * rd, 0.0));
        h += dome * 0.0022; col = mix(col, col * 1.15, step(rd, 1.0) * 0.5);
        cav *= 1.0 - 0.5 * smoothstep(1.5, 1.0, rd) * step(1.0, rd);
      }
    }
    float edgeK = 1.0 - smoothstep(0.0, 0.008, e);
    float rustM = sat(uRust * 1.7 * (0.30 + 0.95 * n1 + 0.5 * n2 + 0.6 * edgeK + 0.7 * (1.0 - ao) + 0.3 * streak) - 0.30);
    float pit = smoothstep(0.66, 0.80, vnoise(vPos * 330.0 + uSeed)) * smoothstep(-0.2, 0.3, n2 + n1);
    rustM = max(smoothstep(0.15, 0.6, rustM), uRust * 0.8 * pit);      // pitting comes first
    vec3 rc = mix(vec3(0.30, 0.115, 0.04), vec3(0.10, 0.048, 0.03), sat(0.5 + 1.5 * n2));
    rc = mix(rc, vec3(0.50, 0.24, 0.08), smoothstep(0.7, 0.9, n3) * 0.5);
    col = mix(col, rc, rustM); metal *= 1.0 - 0.92 * rustM; rough = mix(rough, 0.92, rustM); sRust = rustM;
    h += rustM * 0.00022 * (n3 - 0.3);
    col = mix(col, col * vec3(0.8, 0.7, 0.6), age * 0.3);
    soak = 0.0; lateK = 0.5;
  } else if(mat == 2){
    col = vec3(0.012, 0.010, 0.008); rough = 1.0; ao = 0.2;
  } else {
    col = vec3(0.3); rough = 0.6; metal = 1.0;
  }

  if(mat < 2){
    // rising damp: ground water wicks up, darkest at the bottom, with a tide line
    float wick = mat == 0 ? 1.0 : 0.45;
    float front = dampK * uModelH * (0.42 + 0.30 * n1 + 0.10 * n2 + 0.25 * soak) * wick;
    float damp = 1.0 - smoothstep(front * 0.25, front, vPos.y);
    float tide = smoothstep(front * 0.72, front, vPos.y) * (1.0 - smoothstep(front, front * 1.08 + 0.004, vPos.y)) * step(0.001, front);
    col *= mix(1.0, 0.42, damp * sat(dampK * 1.5));
    col = mix(col, col * vec3(0.70, 0.88, 0.56) + vec3(0.0, 0.014, 0.0), damp * sat(dampK * 1.2) * sat(0.3 + n2) * 0.75 * wick);   // algae
    col = mix(col, col * 0.55 + vec3(0.07, 0.065, 0.055), tide * 0.55);                                                           // salts at the tide line
    rough = mix(rough, 0.95, damp * 0.5); sDamp = damp * sat(dampK * 1.5);
    if(mat == 0) h += damp * uRelief * (lateK - 0.45) * 0.00030;

    // ---- what has been spilt on it, splashed over it, and what is eating it ----
    vec3 Ngr = normalize(vNrm);
    vec2 gp = styleSheet(vPos, Ngr, uWrap.xy) + 0.006 * vec2(gnoise(vPos * 31.0), gnoise(vPos * 31.0 + 7.0));
    float topness = smoothstep(0.5, 0.9, Ngr.y), faceK = max(topness, sideness);
    if(uGr.x > 0.0){
      // spills soak into a flat top and dry to a ring; down the sides they are runs
      // (a run starts where something went over the top edge)
      vec2 sp1 = topness > 0.5 ? splat(gp, 0.34, uGr.x * 0.75, 0.0, 0.0, 11.0, texel) : runs(gp, 0.30, uGr.x * 0.55, uModelH, 12.0, texel);
      float k = sp1.x * (0.45 + 0.55 * (1.0 - smoothstep(0.55, 0.95, sp1.y))) * (1.0 - 0.3 * lateK) * (1.0 - fresh) * faceK * (mat == 0 ? 1.0 : 0.5);
      k = sat(k * (1.0 + 0.8 * gLabel));                                  // paper drinks a spill deeper than wood does
      // a stain darkens wood and leans it toward its own colour; it does not paint it
      vec3 tint = (0.42 + 0.58 * uStainCol / max(max(uStainCol.r, uStainCol.g), max(uStainCol.b, 1e-3))) * (0.50 + 0.9 * luma(sqrt(uStainCol)));
      col *= mix(vec3(1.0), min(tint, vec3(1.0)), k); rough -= 0.10 * k; gStain = k;
    }
    if(uGr2.x > 0.0 && mat == 0){
      // rot: from the ground up, and in at the end grain. Brown rot breaks wood into little cubes.
      float lowR = 1.0 - smoothstep(0.0, (0.15 + 0.45 * uGr2.x) * uModelH, vPos.y);
      float rot = smoothstep(0.0, 0.25, uGr2.x * (0.15 + 1.1 * lowR + 0.7 * soak + 0.5 * (1.0 - ao)) + 0.35 * n1 + 0.2 * n2 - 0.55) * (1.0 - fresh);
      float cw = 0.05 + texel * 40.0;
      float cracks = max(1.0 - smoothstep(0.0, cw, abs(gnoise(vec3(vFace.x * 42.0, vFace.y * 9.0, vIds.y * 61.0)))),
                         1.0 - smoothstep(0.0, cw, abs(gnoise(vec3(vFace.x * 6.0, vFace.y * 110.0, vIds.y * 61.0 + 5.0)))));
      float pits = smoothstep(0.62, 0.75, vnoise(vec3(vLog.xy * 380.0, vLog.z * 22.0)));
      col = mix(col, vec3(0.055, 0.036, 0.024) * (0.7 + 0.8 * lateK), rot * 0.88);
      col *= 1.0 - 0.7 * rot * max(cracks, pits * 0.7);
      h -= rot * (0.0007 * (1.0 - lateK) + 0.0012 * cracks + 0.0008 * pits);
      cav *= 1.0 - 0.5 * rot * cracks; rough = mix(rough, 1.0, rot); gRot = rot;
    }
    if(uGr.z > 0.0){
      // paint or mud: flung across it, and running down from the top where it was slopped over
      vec2 sp3 = splat(gp + 7.7, 0.26, uGr.z * 0.7, 1.0, 0.0, 31.0, texel);
      if(sideness > 0.5) sp3 = max(sp3, runs(gp + 1.3, 0.42, uGr.z * 0.3, uModelH, 32.0, texel));
      float k = smoothstep(0.42, 0.54, sp3.x + 0.10 * (vnoise(vPos * 260.0) - 0.5)) * (1.0 - fresh);
      col = mix(col, uSplashCol * (0.85 + 0.2 * n3), k * 0.95); rough = mix(rough, 0.55, k); metal *= 1.0 - k; h += k * 0.00006; gSplash = k;
    }

    // grime: a film everywhere, thick in corners, in the grain, and down the runoff paths
    float hrel = sat(h * 2500.0 + 0.5);
    float dirt = dirtK * sat(0.22 + 0.9 * n1 + 2.4 * (1.0 - ao) + 0.7 * streak - 0.45 * hrel + 0.3 * dirtK);
    dirt = sat(dirt * (1.0 + 0.4 * gLabel));                                                               // and holds grime
    dirt = sat(dirt + dirtK * 0.6 * (1.0 - smoothstep(0.0, 0.10 * uModelH + 0.02, vPos.y)) * (0.6 + n1));   // splash from the ground
    dirt = sat(dirt * (1.0 - 0.75 * ghostIn) + dirtK * 0.7 * ghostEdge);                                   // the line of dirt round where a batten sat
    col = mix(col, vec3(0.075, 0.060, 0.045) * (0.8 + 0.4 * n3), dirt * 0.82);
    rough = mix(rough, 0.95, dirt * 0.6); metal *= 1.0 - 0.8 * dirt; sDirt = dirt;

    if(uGr.w > 0.0){
      // moss: wherever it stays damp. Low down, in the corners, on a shaded top.
      float lowM = 1.0 - smoothstep(0.0, 0.45 * uModelH + 0.05, vPos.y);
      float aff = 1.1 * (1.0 - ao) + 0.35 * lowM + 0.30 * sDamp + 0.25 * topness * (1.0 - 0.5 * sky);
      // it grows in cushions, not as a lawn: the noise decides, the damp only tilts it
      float clump = 0.5 * fbm(vPos * 11.0 + 40.0 + uSeed) + 0.5 * vnoise(vPos * 42.0);
      float moss = smoothstep(0.0, 0.14, uGr.w * (0.20 + 0.90 * aff) + 0.70 * clump - 0.70) * (1.0 - fresh) * (mat == 0 ? 1.0 : 0.6);
      float tuft = vnoise(vPos * 330.0);
      vec3 mc = mix(vec3(0.016, 0.034, 0.010), vec3(0.075, 0.105, 0.022), 0.55 * vnoise(vPos * 240.0) + 0.45 * sat(clump + 0.2));
      col = mix(col, mc * (0.75 + 0.5 * tuft), moss * 0.96);
      rough = mix(rough, 0.97, moss); metal *= 1.0 - moss; h += moss * (0.0004 + 0.0007 * tuft); cav *= 1.0 - 0.3 * moss * (1.0 - tuft);
      // lichen: grey-green rosettes, in colonies, on wood that sees the sky and the sun
      vec2 lw = worley(gp * 15.0 + uSeed);
      float lr = 0.20 + 0.28 * lw.y, colony = smoothstep(0.50, 0.62, vnoise(vec3(gp * 3.5, uSeed + 5.0)));
      float lich = (1.0 - smoothstep(lr - 0.03, lr, lw.x + 0.13 * gnoise(vec3(gp * 70.0, 1.0)) + 0.05 * gnoise(vec3(gp * 260.0, 3.0)))) * step(fract(lw.y * 3.7), uGr.w * 0.9 * (0.15 + sky) * (0.35 + 0.65 * uSun)) * colony
                 * (1.0 - moss) * (1.0 - fresh) * (mat == 0 ? 1.0 : 0.0);
      vec3 lc = mix(vec3(0.27, 0.29, 0.22), vec3(0.30, 0.23, 0.06), step(0.9, fract(lw.y * 7.3))) * (0.70 + 0.45 * smoothstep(lr * 0.3, lr, lw.x)) * (0.85 + 0.3 * vnoise(vec3(gp * 500.0, 2.0)));
      col = mix(col, lc, lich * 0.88); h += lich * 0.00015; rough = mix(rough, 0.9, lich);
      gMoss = max(moss, lich * 0.6);
    }
    if(uGr.y > 0.0){
      // wet: water standing on the top, and lying in patches down the sides
      float wet = smoothstep(0.3, 0.7, splat(gp + 3.1, 0.5, uGr.y * 0.9, 0.0, 0.0, 21.0, texel).x) * mix(0.55, 1.0, topness) * faceK;
      col *= mix(1.0, 0.50, wet); rough = mix(rough, 0.12, wet * 0.9); h = mix(h, h * 0.4, wet * topness); gWet = wet;
    }
    if(uFire.x > 0.0){
      // ---- fire: see NOTES (Fire). It came last, so it covers everything above ----
      float H = fireH;
      if(mat == 0){
        // Toasting follows the grain, it is not a cloud laid over it: the latewood lines darken first and
        // furthest, the soft earlywood between goes orange-brown and shrinks back, so the rings stand up;
        // arrises toast before flat faces. (Nich's references, 2026-11-20: a flamed crate, torched boards.)
        float scorch = smoothstep(0.04, 0.26, H);
        float tl = sat(lateK * 1.3 + smoothstep(0.10, 0.28, H) * 0.7 - 0.25);
        col = mix(col, col * mix(vec3(0.78, 0.50, 0.26), vec3(0.16, 0.075, 0.03), tl), scorch);
        col *= 1.0 - scorch * 0.55 * (1.0 - smoothstep(0.0, 0.006, e));
        h -= scorch * (1.0 - lateK) * 0.00045 * uRelief;
        // char takes the latewood ridges first and runs along the grain, so its front is ragged lengthwise
        float grainN = gnoise(vec3(vFace.x * 6.0, vFace.y * 90.0, vIds.y * 11.0));
        float charK = smoothstep(0.22, 0.34, H + 0.14 * (lateK - 0.5) + 0.06 * grainN + 0.05 * n2) * (1.0 - nailHead);
        float deep = smoothstep(0.42, 0.95, H + 0.2 * n2);
        // alligatored: checked across the grain and split along it, in staggered blocks that grow as it burns deeper
        vec2 fa = vFace.xy + 0.005 * vec2(gnoise(vec3(vFace.xy * 30.0, vIds.y * 17.0)), gnoise(vec3(vFace.xy * 30.0, vIds.y * 17.0 + 5.0)));
        float sb = mix(0.006, 0.013, deep), sa = mix(0.010, 0.028, deep);
        // the splits along the grain wander; the checks across it are staggered row by row and lean a little
        float ry = fa.y / sb + 0.35 * gnoise(vec3(fa.x * 45.0, vIds.y * 3.0, 1.0));
        float row = floor(ry), rf = fract(ry);
        float sRow = sa * (0.7 + 0.6 * hash2(row + 7.0, vIds.y * 53.0));
        float ax = fa.x / sRow + hash2(row, vIds.y * 131.0) + 0.25 * gnoise(vec3(fa.y * 120.0, row, vIds.y * 5.0));
        float cellA = floor(ax), af = fract(ax);
        // not every split runs the whole length: some blocks are two rows deep
        float splitHere = step(0.22, hash2(row * 5.0 + cellA, vIds.y * 41.0 + 2.0));
        float dRow = mix(1.0, min(rf, 1.0 - rf), splitHere) * sb;
        float dCrack = min(dRow, min(af, 1.0 - af) * sRow);
        float cw = mix(0.0004, 0.0013, deep);
        float crack = (1.0 - smoothstep(cw * 0.4, cw * 1.2 + texel * 0.6, dCrack)) * (1.0 - smoothstep(0.6, 1.4, texel / cw));
        float pillow = smoothstep(0.0, min(sb, sRow) * 0.28, dCrack);                       // crowns nearly flat, rounded only at the check
        float fiss = gnoise(vec3(fa * 380.0, vIds.y * 3.0));
        // each block keeps the grain as fine striations, and sits a little higher or lower, a little tilted
        float stri = gnoise(vec3(fa.x * 30.0, fa.y * 1100.0, vIds.y * 9.0)) * (1.0 - smoothstep(0.5, 1.2, texel * 1100.0));
        float blockH = hash2(row * 3.1 + cellA, vIds.y * 19.0 + 4.0);
        // char is nearly black; what light it has is sheen on the crowns
        vec3 charCol = vec3(0.0105, 0.0098, 0.0102) * (0.75 + 0.5 * vnoise(vec3(fa * 700.0, vIds.y))) * (0.8 + 0.45 * blockH) * (1.0 + 0.3 * stri);
        // where the char is still thin it has flaked here and there, showing the scorched wood under it
        // (only near the char's front, in long slivers between the latewood lines)
        float flake = (1.0 - smoothstep(0.30, 0.50, H)) * smoothstep(0.68, 0.80, vnoise(vec3(fa.x * 9.0, fa.y * 110.0, vIds.y * 3.0)) + 0.25 * (0.5 - lateK));
        charCol = mix(charCol, vec3(0.095, 0.034, 0.010) * (0.6 + 0.6 * (1.0 - lateK)), flake);
        col = mix(col, charCol, charK);
        col = mix(col, vec3(0.08, 0.030, 0.010), charK * crack * (1.0 - deep) * 0.5);     // pyrolysed brown in a fresh check
        col *= 1.0 - 0.85 * charK * crack * deep;
        rough = mix(rough, mix(0.78, 0.50, pillow) + 0.08 * fiss, charK); rough = mix(rough, 0.97, charK * crack);   // a faint silver sheen on the crowns
        h += charK * (-0.0003 - 0.0015 * deep + pillow * (0.0004 + 0.0007 * deep) + 0.00012 * fiss + 0.00016 * stri
                      + (blockH - 0.5) * (0.0003 + 0.0006 * deep) - 0.0003 * flake - crack * (0.0010 + 0.0020 * deep));
        cav *= 1.0 - 0.6 * charK * crack;
        // edges and ends burn away first
        float eat = deep * (1.0 - smoothstep(0.0, 0.004 + 0.010 * deep, e));
        h -= eat * 0.004; col *= 1.0 - 0.3 * eat;
        // ash lies on what faces up, and in pale patches where it burned hottest
        float topF = smoothstep(0.4, 0.9, normalize(vNrm).y);
        // (a block at a time, on its crown: grey-white where the char itself has burned)
        float ashK = smoothstep(0.85, 1.5, H + 0.25 * n2) * (0.25 + 0.75 * topF);
        float ash = ashK * step(1.0 - ashK, hash2(row * 3.1 + cellA, vIds.y * 7.0 + 1.0)) * smoothstep(0.2, 0.8, pillow) * (1.0 - nailHead);
        col = mix(col, vec3(0.30, 0.29, 0.28) * (0.8 + 0.35 * n3), ash * 0.7); rough = mix(rough, 1.0, ash); h += ash * 0.0002;
        metal *= 1.0 - charK; sChar = charK; sAsh = ash; sScorch = scorch * (1.0 - charK); sCharCrack = charK * crack;
      } else {
        // iron: temper colours as it heats (straw, bronze, purple, blue, grey), then black scale
        float t = sat((H - 0.10) / 0.75);
        vec3 tc = t < 0.2 ? mix(vec3(1.0), vec3(1.25, 1.05, 0.55), t / 0.2)
                : t < 0.4 ? mix(vec3(1.25, 1.05, 0.55), vec3(0.95, 0.55, 0.30), (t - 0.2) / 0.2)
                : t < 0.55 ? mix(vec3(0.95, 0.55, 0.30), vec3(0.75, 0.35, 0.75), (t - 0.4) / 0.15)
                : t < 0.7 ? mix(vec3(0.75, 0.35, 0.75), vec3(0.35, 0.50, 1.10), (t - 0.55) / 0.15)
                : mix(vec3(0.35, 0.50, 1.10), vec3(0.9), (t - 0.7) / 0.3);
        tc = mix(vec3(luma(tc)), tc, 0.6);                                         // seen through scale and grime, not polished steel
        col *= mix(vec3(1.0), tc, 1.0 - sRust * 0.8);
        float scale = smoothstep(0.85, 1.10, H + 0.1 * n2);
        col = mix(col, vec3(0.045, 0.040, 0.038) * (0.8 + 0.4 * n3), scale); rough = mix(rough, 0.85, scale); metal *= 1.0 - 0.7 * scale;
        h += scale * 0.0003 * (n3 - 0.3); sChar = scale;
      }
      // soot: risen past the burn, thickest on undersides and in corners, on iron too
      float soot = sootK * (1.0 - smoothstep(0.20, 0.36, H));
      col = mix(col, vec3(0.030, 0.027, 0.025), soot * 0.88); rough = mix(rough, 0.92, soot); metal *= 1.0 - 0.8 * soot; sSoot = soot;
    }
    // what the drawn styles need to know of all that
    sDirt = max(sDirt, max(gStain * 0.7, gRot)); sDamp = max(sDamp, gWet * 0.8);
    if(gSplash > sMark){ sMark = gSplash; sMarkCol = uSplashCol; }
  }
  h = mix(h, nailH, nailHead);          // whatever happened to the wood did not happen to the nail

  if(uStyle > 0 && mat < 2){
    float lw = uStA.x, detail = uStA.y, baked = uStA.z;
    vec3 Ng = normalize(vNrm);
    // what an unlit picture has to say about light: a fixed sun over the left shoulder, softened by occlusion
    float lam = dot(Ng, normalize(vec3(-0.42, 0.78, 0.46)));
    float light = sat((0.5 + 0.5 * lam) * (0.3 + 0.7 * sat(ao)) * cav);
    // the sheet it is drawn on runs unbroken across each side of the object
    // (round a barrel it wraps round, so nothing changes direction part way across a stave)
    vec2 pp = styleSheet(vPos, Ng, uWrap.xy);
    // two layers of the same swatch at different sizes and turned against each other, so no feature repeats in step
    vec2 pq = mat2(0.8, 0.6, -0.6, 0.8) * pp;
    float tooth = 0.5 + 0.75 * ((texture(uPaper, pp / 0.31 + uSeed).r - 0.5) + (texture(uPaper, pq / 0.47 + 0.37 + uSeed).r - 0.5));
    tooth = sat(tooth + 0.22 * (vnoise(vec3(pp * 900.0, 3.0)) - 0.5) * (1.0 - smoothstep(0.5, 1.4, texel * 900.0)));
    float wob = gnoise(vec3(vFace.xy * 55.0, vIds.y * 31.0)), wobLow = gnoise(vec3(pp * 6.0, uSeed));
    // lines every hand would draw: the edge of each piece, some of the rings, knots, splits
    float eW = e + lw * 0.3 * wob;
    float outline = lineCov(eW, 2.0 * lw, texel);
    float ringN = mix(8.0, 1.6, detail), gf = sF / ringN;
    float gd = abs(fract(gf) - 0.5) / max(sFw / ringN, 1e-6) * texel;
    float gbreak = smoothstep(0.30, 0.50, vnoise(vec3(vLog.xy * 40.0, vLog.z * 2.5 + floor(gf) * 7.3)));
    float grain = mat == 0 ? lineCov(gd, lw * 0.55, texel) * gbreak * (1.0 - smoothstep(0.35, 0.8, sFw / ringN)) * (1.0 - 0.6 * sEnd) * step(1.05, sKrho) : 0.0;
    float kline = lineCov(abs(sKrho - 1.0) * sKr, lw * 0.8, texel) * step(sKrho, 3.0);
    float kin = lineCov(abs(fract(sKrho * 2.5) - 0.5) * sKr / 2.5, lw * 0.45, texel) * step(sKrho, 1.0);
    float nailRing = st.g * (1.0 - st.g) * 4.0;
    float cuts = max(max(sCrack, sSeam), sHole);

    if(uStyle == 1){
      // cel: flat colour, a few bold grain lines, a dark outline, shadows in a second flat tone
      vec3 base;
      if(mat == 0){
        base = mix(sFlat, sFlat * vec3(0.80, 0.66, 0.52), age * 0.6);
        base = mix(vec3(luma(base)), base, 1.2) * 1.08;                                  // cel colour is cleaner than life
        base = mix(base, vec3(0.50, 0.49, 0.47), smoothstep(0.42, 0.50, sGrey + 0.05 * wob) * 0.9);
        base *= 1.0 + 0.07 * (step(0.5, fract(sF / (ringN * 3.0))) - 0.5);              // broad bands of slightly different tone
        base = mix(base, base * 0.72, grain);
        base = mix(base, sKnotCol * 1.5, step(sKrho, 1.0) * 0.85);
        base = mix(base, base * 0.6, max(kline, kin * 0.8));
        base = mix(base, sMarkCol, smoothstep(0.40, 0.55, sMark));
        base = mix(base, vec3(0.33, 0.13, 0.05), smoothstep(0.30, 0.40, sRust) * 0.8);
        base = mix(base, base * 1.25 + 0.03, smoothstep(0.30, 0.40, sWear) * 0.8);      // a painted highlight where the edge has worn
        base = mix(base, vec3(0.07, 0.065, 0.07), st.g);
      } else {
        // iron: one blue-grey, a lighter band along it, rust in patches
        float band = 1.0 - smoothstep(0.10, 0.14, abs(vFace.y / vFace.w - 0.36));
        base = mix(vec3(0.20, 0.22, 0.26), vec3(0.34, 0.37, 0.42), band);
        base = mix(base, vec3(0.36, 0.15, 0.06), smoothstep(0.40, 0.50, sRust));
      }
      base = mix(base, vec3(0.15, 0.29, 0.08), smoothstep(0.40, 0.50, gMoss) * 0.9);
      base = mix(base, base * vec3(0.55, 0.64, 0.50), smoothstep(0.45, 0.55, sDamp) * 0.6);
      base = mix(base, base * 0.62, smoothstep(0.50, 0.60, sDirt) * 0.7);
      // fire: a toasted brown, a flat black char, soot as a second darker tone
      base = mix(base, base * vec3(0.62, 0.42, 0.26), smoothstep(0.35, 0.45, sScorch));
      base = mix(base, base * 0.45, smoothstep(0.40, 0.55, sSoot));
      base = mix(base, vec3(0.055, 0.050, 0.055), smoothstep(0.45, 0.55, sChar));
      base = mix(base, vec3(0.30, 0.29, 0.28), smoothstep(0.45, 0.55, sAsh) * 0.8);
      vec3 shadowTint = vec3(0.60, 0.56, 0.72);
      base = mix(base, base * shadowTint, smoothstep(0.52, 0.46, ao * cav + 0.04 * wob) * 0.8);
      base = mix(base, base * shadowTint, baked * smoothstep(0.50, 0.46, light + 0.03 * wobLow) * 0.75);
      col = mix(base, uInkCol, max(outline, cuts));
      col = mix(col, base * 2.2 + 0.05, smoothstep(0.3, 0.6, sCharCrack) * 0.5);       // char checks drawn as pale lines in the black
      h *= 0.2; rough = mat == 0 ? 0.85 : 0.55; metal = 0.0;
    } else if(uStyle == 2){
      // pen and ink on parchment: line for form, hatching for shadow, stipple for dirt
      float hatchK = uStB.x, old = uStB.y;
      vec3 paper = uPaperCol * (0.80 + 0.40 * tooth);
      paper = mix(paper, paper * vec3(0.78, 0.63, 0.42), old * sat(0.25 + 0.9 * fbm2(vec3(pp * 3.0, uSeed)) + 0.6 * (0.5 - tooth)));
      // light, if it is to be painted in, is hatching; so are damp and iron, whatever the light
      float tone = styleInkTone(light, baked) + 0.45 * sDamp + (mat == 1 ? 0.45 : 0.0);
      float hatch = styleHatch(pp, tone, lw, mix(0.016, 0.006, hatchK), texel) * step(0.01, hatchK);
      // stipple where it is dirty or stained
      vec2 wv = worley(pp / 0.0045 + uSeed);
      float dots = (1.0 - smoothstep(0.16, 0.30, wv.x)) * step(wv.y, 0.9 * max(max(max(sDirt * 0.8, sRust), gMoss * 0.9), max(sSoot, sScorch * 0.7)) - 0.12);
      float ink = max(max(outline, grain * 0.85), max(max(kline, kin * 0.8), cuts));
      ink = max(max(ink, hatch), max(max(dots, nailRing), smoothstep(0.15, 0.35, sMark)));
      float press = 0.72 + 0.28 * vnoise(vec3(pp * 70.0, 2.0));                          // the pen floods and runs dry
      col = mix(paper, uInkCol, sat(ink * press * 1.08));
      // char is filled in solid with the brush (the pen's flooding would show as blocks), its checks left as paper
      float charFill = smoothstep(0.45, 0.55, sChar) * (1.0 - smoothstep(0.3, 0.6, sCharCrack));
      col = mix(col, uInkCol, charFill * (0.94 + 0.06 * tooth)); ink = max(ink, charFill);
      h = (tooth - 0.5) * 0.00008 - ink * 0.00002; rough = 0.90; metal = 0.0;
    } else {
      // watercolour: transparent washes over white paper. Light is bare paper,
      // shadow is a second glaze, and pigment pools where a wash stops.
      float gran = uStB.x, wet = uStB.y, pencil = uStB.z;
      vec3 pig;
      if(mat == 0){
        pig = mix(sFlat, sFlat * vec3(0.82, 0.68, 0.54), age * 0.6);
        pig = mix(pig, vec3(0.40, 0.42, 0.46), sGrey * 0.85);
        float softGrain = lineCov(gd, lw * 2.2, texel * 2.5) * gbreak * (1.0 - smoothstep(0.35, 0.8, sFw / ringN)) * step(1.05, sKrho);
        pig = mix(pig, pig * 0.70, softGrain * 0.7);
        pig = mix(pig, sKnotCol * 1.2, (1.0 - smoothstep(0.7, 1.25, sKrho)) * 0.8);
        pig = mix(pig, vec3(0.34, 0.14, 0.05), sat(sRust * 1.3) * 0.8);
        pig = mix(pig, sMarkCol, smoothstep(0.30, 0.60, sMark) * 0.92);
        pig = mix(pig, vec3(0.05, 0.05, 0.06), st.g);
      } else {
        pig = mix(vec3(0.17, 0.21, 0.28), vec3(0.36, 0.16, 0.06), smoothstep(0.25, 0.6, sRust));
      }
      pig = mix(pig, vec3(0.16, 0.30, 0.08), gMoss * 0.85);
      pig = mix(pig, pig * vec3(0.50, 0.64, 0.46), sDamp * 0.6);
      pig = mix(pig, pig * 0.55, sDirt * 0.6);
      pig = mix(pig, pig * vec3(0.60, 0.42, 0.28), sScorch * 0.8);
      pig = mix(pig, vec3(0.10, 0.10, 0.11), max(sSoot * 0.6, sChar * 0.95));                  // a charcoal glaze
      pig = max(mix(vec3(luma(pig)), pig, 1.15), 0.0);                                   // a little cleaner than the thing it paints
      float amt = 0.58;
      amt += 0.35 * (1.0 - sat(ao * cav));                                               // pigment settles into corners
      amt *= 1.0 + wet * 0.30 * fbm2(vec3(pp * 5.0, uSeed + 2.0));                       // no wash goes on evenly
      vec2 bl = worley(pp * 11.0 + uSeed);
      amt *= 1.0 + wet * 0.35 * (1.0 - smoothstep(0.0, 0.04, abs(bl.x - 0.52))) * step(0.7, bl.y);   // the hard edge of a backrun
      // each wash stops short of the edge of its piece, and pools where it stops
      float gapW = lw * 0.8, eS = e + lw * 0.35 * wob + lw * 0.4 * wobLow;
      float inside = smoothstep(gapW * 0.5, gapW, eS);
      amt *= (1.0 + 0.6 * (1.0 - smoothstep(gapW, gapW * 2.8, eS))) * inside;
      amt *= 1.0 + gran * 1.5 * (0.5 - tooth);                                           // granulation: pigment lies in the valleys of the paper
      amt = sat(amt + 0.6 * cuts);
      vec3 paper = uPaperCol * (0.94 + 0.12 * tooth);
      col = paper * pow(max(pig, vec3(0.02)), vec3(amt * 1.45));                         // transparent pigment: more of it, deeper the colour
      if(baked > 0.0) col = styleWash(col, paper, pp, light, baked);                     // light, if it is to be painted in
      col = mix(col, vec3(0.10, 0.10, 0.11), pencil * 0.55 * max(lineCov(e + lw * 0.5 * wob - lw * 0.4, lw * 0.5, texel), 0.5 * grain) * (0.6 + 0.4 * tooth));
      h = (tooth - 0.5) * 0.00010; rough = 0.92; metal = 0.0;
    }
  }
  oAlbedo = vec4(max(col, 0.0), dens);
  oSurf = vec4(h * 1000.0, clamp(rough, 0.04, 1.0), metal, sat(ao) * cav);
  oAux = vec4(line, float(mat) / 8.0, sat(e * 20.0), knot);
}`;

const STAMP_VS = `#version 300 es
layout(location=0) in vec2 aCorner; layout(location=1) in vec4 aCG; layout(location=2) in vec4 aRS; layout(location=3) in vec4 aRect; layout(location=4) in vec4 aExt;
uniform float uSize;
out vec2 vP; flat out vec4 vRS; flat out vec4 vRect; flat out float vG; flat out vec2 vHalf;
void main(){
  vec2 g = aCG.zw; float gl = length(g);
  vec2 up = gl > 0.05 ? -g / gl : vec2(0.0, 1.0), rt = vec2(up.y, -up.x);
  // aExt: how far the quad reaches left, right, down, up, in units of aRS.x pixels
  vec2 lp = vec2(mix(-aExt.x, aExt.y, aCorner.x * 0.5 + 0.5), mix(-aExt.z, aExt.w, aCorner.y * 0.5 + 0.5));
  vec2 p = aCG.xy + aRS.x * (rt * lp.x + up * lp.y);
  vP = lp; vRS = aRS; vRect = aRect; vG = gl; vHalf = vec2(aExt.x, aExt.w) - 0.6;
  gl_Position = vec4(p / uSize * 2.0 - 1.0, 0.0, 1.0);
}`;
const STAMP_FS = `#version 300 es
precision highp float; precision highp int;
${NOISE}
const float FOOT_A = 0.019;   // stamp A at a batten's foot; falls to 0 at 3 cm out (stamp type 4)
in vec2 vP; flat in vec4 vRS; flat in vec4 vRect; flat in float vG; flat in vec2 vHalf;
out vec4 o;
void main(){
  vec2 fc = gl_FragCoord.xy;
  if(fc.x < vRect.x || fc.y < vRect.y || fc.x > vRect.z || fc.y > vRect.w) discard;
  float seed = vRS.y; int type = int(vRS.z + 0.5);
  float amount = 0.35 + 0.65 * hash1(seed + 0.3);
  if(type == 0){
    // a nail: vP in head radii
    float d = length(vP);
    float head = 1.0 - smoothstep(0.80, 1.05, d);
    // the head sits a little below the surface, in the bruise the hammer left
    float sink = head * (0.00030 - 0.00018 * (1.0 - sat(d))) + (1.0 - head) * 0.00022 * (1.0 - smoothstep(1.0, 2.6, d)) * (0.5 + hash1(seed + 0.9));
    float n = vnoise(vec3(vP * 1.3, seed * 97.0));
    float halo = exp(-max(d - 1.0, 0.0) * 0.8) * (0.45 + 0.55 * n);
    float streak = 0.0;
    if(vP.y < 0.5){
      float y = -vP.y, wob = 0.5 * gnoise(vec3(y * 0.25, seed * 53.0, 1.0));
      float wdt = 0.7 + 0.035 * y;
      float len = 3.0 + 20.0 * amount * vG;
      streak = exp(-abs(vP.x + wob) / wdt) * exp(-y / len) * (0.55 + 0.45 * vnoise(vec3(vP.x * 2.5, y * 0.2, seed * 31.0)));
    }
    o = vec4(max(halo * 0.75, streak) * amount, head, sink * 2000.0, 0.0);
  } else if(type == 2){
    // the ghost of a batten: vP in centimetres from its centre, vRS.zw... half extents ride in vHalf
    vec2 d = vHalf - abs(vP);
    float edge = min(d.x, d.y) + 0.12 * (vnoise(vec3(vP * 1.7, seed * 9.0)) - 0.5);
    o = vec4(0.0, 0.0, 0.0, smoothstep(-0.12, 0.12, edge));
  } else if(type == 4){
    // the foot of a sound batten: how near the boards around it are to its edge, kept below 0.02 so
    // nothing that reads the ghost channel sees it (see NOTES: stamps)
    vec2 hf = vHalf + 0.6 - vRS.w, d = abs(vP) - hf;
    float outside = max(max(d.x, d.y), 0.0);
    o = vec4(0.0, 0.0, 0.0, FOOT_A * (1.0 - min(outside / vRS.w, 1.0)));
  } else if(type == 3){
    // a hole where a nail was drawn: the same stain, no head
    float d = length(vP);
    float n = vnoise(vec3(vP * 1.3, seed * 97.0));
    float halo = exp(-max(d - 0.7, 0.0) * 0.9) * (0.45 + 0.55 * n);
    float streak = 0.0;
    if(vP.y < 0.5){ float y = -vP.y; streak = exp(-abs(vP.x) / (0.7 + 0.035 * y)) * exp(-y / (3.0 + 14.0 * amount * vG)) * (0.55 + 0.45 * vnoise(vec3(vP.x * 2.5, y * 0.2, seed * 31.0))); }
    o = vec4(max(halo * 0.7, streak) * amount * 0.8, 0.0, 1.0 - smoothstep(0.55, 0.8, d), 0.0);
  } else {
    // the stain an iron band leaves: vP in centimetres from the band's centre line, vRS.w its half width
    float hw = vRS.w, y = vP.y;
    float run = vnoise(vec3(vP.x * 2.2, seed * 71.0, 0.0)) * 0.6 + vnoise(vec3(vP.x * 6.5, y * 0.12, seed * 13.0)) * 0.4;
    float above = exp(-max(y - hw, 0.0) / 0.45), below = exp(-max(-y - hw, 0.0) / (0.8 + 7.0 * amount * run * run));
    float r = y > 0.0 ? above * 0.8 : below * (0.45 + 0.55 * run);
    // under the band itself the wood kept clean, but for a line of rust at each edge
    float under = smoothstep(hw + 0.08, hw - 0.08, abs(y));
    r *= mix(1.0, 0.12 + 0.5 * smoothstep(hw - 0.35, hw, abs(y)), under);
    o = vec4(r * (0.55 + 0.45 * amount), 0.0, 0.0, under);
  }
}`;

const DEPTH_VS = `#version 300 es
layout(location=0) in vec3 aPos; uniform mat4 uVP; void main(){ gl_Position = uVP * vec4(aPos, 1.0); }`;
const DEPTH_FS = `#version 300 es
precision highp float; void main(){}`;

const OCC_FS = `#version 300 es
precision highp float;
uniform sampler2D uDepth; uniform mat4 uVP; uniform vec3 uDir; uniform float uBias;
in vec3 vPos, vNrm;
out vec4 o;
void main(){
  vec3 n = normalize(vNrm);
  float ndl = dot(n, uDir);
  if(ndl <= 0.0){ o = vec4(0.0); return; }
  vec4 c = uVP * vec4(vPos + n * uBias, 1.0);
  vec3 s = c.xyz * 0.5 + 0.5;
  vec2 ts = vec2(textureSize(uDepth, 0));
  float vis = 0.0;
  for(int y=0;y<2;y++) for(int x=0;x<2;x++){
    float dz = texture(uDepth, s.xy + (vec2(float(x), float(y)) - 0.5) / ts).r;
    vis += step(s.z - 0.0015, dz);
  }
  vis *= 0.25;
  float up = max(uDir.y, 0.0);
  o = vec4(vis * ndl, ndl, vis * ndl * up, 1.0);
}`;
const OCC_VS = `#version 300 es
layout(location=0) in vec2 aUV; layout(location=1) in vec3 aPos; layout(location=2) in vec3 aNrm;
out vec3 vPos, vNrm; void main(){ vPos=aPos; vNrm=aNrm; gl_Position = vec4(aUV*2.0-1.0, 0.0, 1.0); }`;
const OCC_RESOLVE_FS = `#version 300 es
precision highp float; uniform sampler2D uAcc; uniform float uSkyNorm; in vec2 vUV; out vec4 o;
void main(){ vec4 a = texelFetch(uAcc, ivec2(gl_FragCoord.xy), 0); float ao = a.g > 0.0 ? a.r / a.g : 1.0; o = vec4(ao, clamp(a.b / uSkyNorm, 0.0, 1.0), 0.0, a.a > 0.0 ? 1.0 : 0.0); }`;

const OCC_DILATE_FS = `#version 300 es
precision highp float; uniform sampler2D uT; out vec4 o;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy); vec4 a = texelFetch(uT, p, 0);
  if(a.a < 0.5){ vec4 s = vec4(0.0); float n = 0.0;
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){ vec4 t = texelFetch(uT, p + ivec2(x,y), 0); if(t.a > 0.5){ s += t; n += 1.0; } }
    if(n > 0.0) a = s / n; else a = vec4(1.0, 0.5, 0.0, 0.0); }
  o = a;
}`;

const RESOLVE_FS = `#version 300 es
precision highp float;
uniform sampler2D uAlbedo, uSurf; uniform float uTexel, uNormalStrength;
in vec2 vUV;
layout(location=0) out vec4 oAlbedo; layout(location=1) out vec4 oNormal; layout(location=2) out vec4 oOrm;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uAlbedo, p, 0);
  if(a.a < 0.01){ oAlbedo = vec4(0.0); oNormal = vec4(0.5, 0.5, 1.0, 0.0); oOrm = vec4(1.0, 1.0, 0.0, 0.0); return; }
  vec4 s = texelFetch(uSurf, p, 0);
  // central differences, one-sided at island borders
  float h = s.r;
  float cl = texelFetch(uAlbedo, p + ivec2(-1,0), 0).a, cr = texelFetch(uAlbedo, p + ivec2(1,0), 0).a;
  float cd = texelFetch(uAlbedo, p + ivec2(0,-1), 0).a, cu = texelFetch(uAlbedo, p + ivec2(0,1), 0).a;
  float hl = cl > 0.01 ? texelFetch(uSurf, p + ivec2(-1,0), 0).r : h, hr = cr > 0.01 ? texelFetch(uSurf, p + ivec2(1,0), 0).r : h;
  float hd = cd > 0.01 ? texelFetch(uSurf, p + ivec2(0,-1), 0).r : h, hu = cu > 0.01 ? texelFetch(uSurf, p + ivec2(0,1), 0).r : h;
  float du = 0.001 * a.a * (hr - hl) / (uTexel * (cl > 0.01 && cr > 0.01 ? 2.0 : 1.0)), dv = 0.001 * a.a * (hu - hd) / (uTexel * (cd > 0.01 && cu > 0.01 ? 2.0 : 1.0));
  vec3 n = normalize(vec3(-du * uNormalStrength, -dv * uNormalStrength, 1.0));
  oAlbedo = vec4(a.rgb, 1.0);
  oNormal = vec4(n * 0.5 + 0.5, 1.0);
  oOrm = vec4(s.a, s.g, s.b, 1.0);
}`;

const DILATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uA, uB, uC; uniform int uLast;
layout(location=0) out vec4 oA; layout(location=1) out vec4 oB; layout(location=2) out vec4 oC;
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uA, p, 0), b = texelFetch(uB, p, 0), c = texelFetch(uC, p, 0);
  if(a.a < 0.5){
    vec4 sa = vec4(0.0), sb = vec4(0.0), sc = vec4(0.0); float n = 0.0;
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
      ivec2 q = p + ivec2(x,y); vec4 t = texelFetch(uA, q, 0);
      if(t.a > 0.5){ float w = (x==0||y==0) ? 2.0 : 1.0; sa += t*w; sb += texelFetch(uB, q, 0)*w; sc += texelFetch(uC, q, 0)*w; n += w; }
    }
    if(n > 0.0){ a = sa/n; b = sb/n; c = sc/n; a.a = 1.0; }
  }
  if(uLast == 1){ if(a.a < 0.5){ a.rgb = vec3(0.05,0.04,0.03); b = vec4(0.5,0.5,1.0,1.0); c = vec4(1.0,1.0,0.0,1.0); } a.a = 1.0; b.a = 1.0; c.a = 1.0; }
  oA = a; oB = b; oC = c;
}`;

export function createBaker(gl) {
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This browser cannot render to float textures (EXT_color_buffer_float).');
  gl.getExtension('OES_texture_float_linear');
  const P = {
    stamp: program(gl, STAMP_VS, STAMP_FS, 'stamp'),
    depth: program(gl, DEPTH_VS, DEPTH_FS, 'depth'),
    occ: program(gl, OCC_VS, OCC_FS, 'occlusion'),
    occResolve: program(gl, QUAD_VS, OCC_RESOLVE_FS, 'occResolve'),
    occDilate: program(gl, QUAD_VS, OCC_DILATE_FS, 'occDilate'),
    resolve: program(gl, QUAD_VS, RESOLVE_FS, 'resolve'),
    dilate: program(gl, QUAD_VS, DILATE_FS, 'dilate'),
  };
  // One material program per style, compiled when first wanted, with the style
  // a constant: some drivers run both sides of a branch on a uniform, and the
  // realistic bake should not pay for hatching it never draws.
  const materials = {};
  const materialFor = (id) => materials[id] || (materials[id] = program(gl, BAKE_VS, MATERIAL_FS.replace('uniform int uStyle;', `const int uStyle = ${id};`), 'material' + id));
  const F16 = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, filter: gl.NEAREST };
  const U8 = { filter: gl.NEAREST }, U8L = { filter: gl.LINEAR };
  const state = { sets: new Map(), occKey: '', depth: target(gl, 1024, 1024, [], true) };

  // Render targets for one atlas size. Two sizes are kept (draft and full).
  function alloc(size) {
    let T = state.sets.get(size);
    if (T) return T;
    if (state.sets.size >= 2) { const [k, old] = state.sets.entries().next().value; for (const n in old) freeTarget(gl, old[n]); state.sets.delete(k); }
    const out = () => target(gl, size, size, [{ internal: gl.SRGB8_ALPHA8, filter: gl.NEAREST }, U8, U8]);
    const os = Math.max(256, size >> 1);
    T = {
      stamps: target(gl, size, size, [F16]),     // half float: the foot of a batten carries a fine distance in A
      occAcc: target(gl, os, os, [F16]), occ: target(gl, os, os, [U8L]), occB: target(gl, os, os, [U8L]),
      mat: target(gl, size, size, [{ internal: gl.SRGB8_ALPHA8, filter: gl.NEAREST }, F16, U8]),
      a: out(), b: out(), occKey: '',
    };
    state.sets.set(size, T);
    return T;
  }

  // Markings -> uniforms. marks: [{ tex, aspect, target, x, y, size, rot, mode, color, opacity, wear, over }]
  const blank = texture(gl, 1, 1, { data: new Uint8Array([0, 0, 0, 0]) });
  const MODES = { paint: 0, brand: 1, chalk: 2, label: 3 };
  function decalUniforms(model, marks) {
    const N = 4, f4 = () => new Float32Array(N * 4), A = f4(), U = f4(), V = f4(), Nn = f4(), O = f4(), C = f4(), Pp = f4();
    const u = { uDkA: A, uDkU: U, uDkV: V, uDkN: Nn, uDkO: O, uDkC: C, uDkP: Pp, uCyl: [0.3, 0.33, 1, 0] };
    for (let i = 0; i < N; i++) {
      const mk = marks[i], tg = mk && mk.tex && (model.targets || []).find((t) => t.id === mk.target);
      u['uDecal' + i] = tg ? mk.tex : blank;
      if (!tg) { A[i * 4] = -1; continue; }
      const w = mk.size, h = mk.size / (mk.aspect || 1), win = mk.over ? tg.proud : tg.skin;
      A.set([tg.kind === 'cyl' ? 1 : 0, MODES[mk.mode] || 0, mk.opacity, mk.wear], i * 4);
      U.set([...tg.u, 1 / w], i * 4); V.set([...tg.v, 1 / h], i * 4);
      Nn.set([...tg.n, (win[0] + win[1]) / 2], i * 4); O.set([...tg.o, (win[1] - win[0]) / 2], i * 4);
      const c = mk.color || [0.02, 0.02, 0.02];
      C.set([Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2), (mk.rot || 0) * Math.PI / 180], i * 4);
      // x, y in -1..1 place the centre within the target, leaving the image inside it
      Pp.set([mk.x * Math.max(0, tg.w - w) / 2, mk.y * Math.max(0, tg.h - h) / 2, mk.over ? 1 : 0, mk.printed ? 1 : 0], i * 4);
      if (tg.cyl) u.uCyl = [...tg.cyl, 0];
    }
    return u;
  }

  // Style -> uniforms. style: { id, line, detail, light, a, b, c, ink, paper, tex }
  const flatGrey = texture(gl, 1, 1, { data: new Uint8Array([128, 128, 128, 255]), wrap: gl.REPEAT });
  const STYLE_ID = { real: 0, cel: 1, ink: 2, wash: 3 };
  function styleUniforms(st) {
    if (!st || !STYLE_ID[st.id]) return { uStyle: 0, uPaper: flatGrey, uStA: [0.001, 0.5, 0.5, 0], uStB: [0, 0, 0, 0], uInkCol: [0, 0, 0], uPaperCol: [1, 1, 1] };
    const lin = (c) => c.map((x) => Math.pow(x, 2.2));
    return { uStyle: STYLE_ID[st.id], uPaper: st.tex || flatGrey, uStA: [st.line * 0.001, st.detail, st.id === 'cel' || st.lit === 'baked' ? st.light : 0, 0], uStB: [st.a, st.b, st.c, 0], uInkCol: lin(st.ink), uPaperCol: lin(st.paper) };
  }

  // model must already be packed
  function bake(model, look, opts = {}) {
    // scale < 1 bakes a draft: same layout, fewer texels
    const scale = opts.scale || 1, size = Math.round(model.atlas.size * scale), pxPerM = model.atlas.pxPerM * scale, texel = 1 / pxPerM;
    const T = alloc(size);
    const t0 = performance.now();
    const times = {}; let tLast = t0;
    const mark = (name, tgt) => {
      if (!opts.profile) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo); gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      const t = performance.now(); times[name] = Math.round(t - tLast); tLast = t;
    };
    const B = bakeArrays(model);
    const bakeVao = vao(gl, BAKE_LOCS, {
      uv: { data: B.uv, size: 2 }, pos: { data: B.pos, size: 3 }, nrm: { data: B.nrm, size: 3 }, tan: { data: B.tan, size: 3 },
      log: { data: B.log, size: 3 }, face: { data: B.face, size: 4 }, ids: { data: B.ids, size: 4 }, extra: { data: B.extra, size: 4 }, rest: { data: B.rest, size: 3 },
    }, B.idx);
    gl.disable(gl.CULL_FACE); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    const bb = bounds(model, 0);

    // 1. stamps
    bindTarget(gl, T.stamps); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const ns = model.stamps.length;
    if (ns) {
      const cg = new Float32Array(ns * 4), rs = new Float32Array(ns * 4), rect = new Float32Array(ns * 4), ext = new Float32Array(ns * 4), s = pxPerM;
      model.stamps.forEach((st, i) => {
        const isl = model.islands[st.isl], sd = s * isl.dens, x0 = isl.px * scale, y0 = isl.py * scale;
        cg.set([x0 + st.f[0] * sd, y0 + st.f[1] * sd, st.g[0], st.g[1]], i * 4);
        rect.set([x0, y0, x0 + isl.w * sd, y0 + isl.h * sd], i * 4);
        const cm = 0.01 * sd;
        if (st.type === 'band') {
          const half = st.half * 100, wd = (st.width * 100) / 2 + 0.2;
          rs.set([cm, st.seed, 1, half], i * 4); ext.set([wd, wd, half + 16, half + 3], i * 4);
        } else if (st.type === 'foot') {
          const mg = 3, hl = st.half[0] * 100 + mg, hw = st.half[1] * 100 + mg;   // centimetres, with a 3 cm reach round it
          rs.set([cm, st.seed, 4, mg], i * 4); ext.set([hl, hl, hw, hw], i * 4);
        } else if (st.type === 'ghost') {
          const hl = st.half[0] * 100 + 0.6, hw = st.half[1] * 100 + 0.6;       // a margin for the soft edge
          rs.set([cm, st.seed, 2, 0], i * 4); ext.set([hl, hl, hw, hw], i * 4);
        } else { rs.set([st.r * sd, st.seed, st.type === 'hole' ? 3 : 0, 0], i * 4); ext.set([7, 7, 26, 7], i * 4); }
      });
      const sv = vao(gl, { corner: 0, cg: 1, rs: 2, rect: 3, ext: 4 }, {
        corner: { data: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), size: 2 },
        cg: { data: cg, size: 4, divisor: 1 }, rs: { data: rs, size: 4, divisor: 1 }, rect: { data: rect, size: 4, divisor: 1 }, ext: { data: ext, size: 4, divisor: 1 },
      });
      use(gl, P.stamp, { uSize: size });
      gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(sv.v); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ns);
      gl.disable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); sv.free();
    }
    mark('stamps', T.stamps);

    // 2. occlusion (only when geometry changed)
    const geoKey = opts.geoKey || String(Math.random());
    if (T.occKey !== geoKey) {
      const G = geoArrays(model, 0);
      const dv = vao(gl, { pos: 0 }, { pos: { data: G.pos, size: 3 } }, G.idx);
      const ov = vao(gl, { uv: 0, pos: 1, nrm: 2 }, { uv: { data: B.uv, size: 2 }, pos: { data: B.pos, size: 3 }, nrm: { data: B.nrm, size: 3 } }, B.idx);
      const cen = [0, 1, 2].map((i) => (bb.min[i] + bb.max[i]) / 2), rad = 0.5 * Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) * 1.02;
      bindTarget(gl, T.occAcc); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const K = opts.occDirs || 96; let skyNorm = 0;
      for (let k = 0; k < K; k++) {
        // Fibonacci sphere
        const y = 1 - (2 * (k + 0.5)) / K, rr = Math.sqrt(1 - y * y), ph = k * 2.399963229728653;
        const d = [Math.cos(ph) * rr, y, Math.sin(ph) * rr];
        if (d[1] > 0) skyNorm += d[1] * d[1];
        const eye = [cen[0] + d[0] * rad * 2, cen[1] + d[1] * rad * 2, cen[2] + d[2] * rad * 2];
        const up = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
        const VP = M4.mul(M4.ortho(-rad, rad, -rad, rad, rad * 0.9, rad * 3.1), M4.lookAt(eye, cen, up));
        bindTarget(gl, state.depth); gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
        use(gl, P.depth, { uVP: VP });
        gl.bindVertexArray(dv.v); gl.drawElements(gl.TRIANGLES, dv.count, gl.UNSIGNED_INT, 0);
        bindTarget(gl, T.occAcc); gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        use(gl, P.occ, { uDepth: state.depth.depthTex, uVP: VP, uDir: d, uBias: 0.004 });
        gl.bindVertexArray(ov.v); gl.drawElements(gl.TRIANGLES, ov.count, gl.UNSIGNED_INT, 0);
        gl.disable(gl.BLEND);
      }
      bindTarget(gl, T.occ);
      use(gl, P.occResolve, { uAcc: T.occAcc.tex[0], uSkyNorm: skyNorm });
      drawQuad(gl);
      for (let i = 0; i < 2; i++) {
        bindTarget(gl, T.occB); use(gl, P.occDilate, { uT: T.occ.tex[0] }); drawQuad(gl);
        bindTarget(gl, T.occ); use(gl, P.occDilate, { uT: T.occB.tex[0] }); drawQuad(gl);
      }
      dv.free(); ov.free();
      T.occKey = geoKey;
    }
    mark('occlusion', T.occ);

    // 3. material
    bindTarget(gl, T.mat); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const lin = (c) => c.map((x) => Math.pow(x, 2.2));
    const hex = (h) => { const n = parseInt(String(h).replace('#', ''), 16) || 0; return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
    const sp = SPECIES[look.species] || SPECIES.pine;
    const su = styleUniforms(opts.style);
    use(gl, materialFor(su.uStyle), {
      uStamps: T.stamps.tex[0], uOcc: T.occ.tex[0], uTexel: texel, uSeed: (model.seed % 1000) * 0.37, uModelH: bb.max[1] - bb.min[1],
      uEarly: lin(sp.early), uLate: lin(sp.late), uHeartTint: sp.heartTint, uKnotCol: lin(sp.knotCol),
      uRingW: sp.ringW, uLateStart: sp.lateStart, uKnots: sp.knots, uPores: sp.pores, uRays: sp.rays, uFigure: sp.figure,
      uRelief: look.relief, uChecks: look.checks, uSawn: look.sawn, uSapstain: look.sapstain,
      uAge: look.age, uSun: look.sun, uDirt: look.dirt, uDamp: look.damp, uRust: look.rust, uWear: look.wear,
      ...decalUniforms(model, opts.marks || []),
      ...su,
      uGrunge: opts.grunge || blank, uGr: [look.stains || 0, look.wet || 0, look.splash || 0, look.moss || 0], uGr2: [look.rot || 0, 0, 0, 0],
      uStainCol: lin(hex(look.stainCol || '#5a3a22')), uSplashCol: lin(hex(look.splashCol || '#c9c2ae')),
      uWrap: model.wrap ? [1, model.wrap, 0, 0] : [0, 1, 0, 0],
      uFire: model.fire && model.fire.burns ? [model.fire.amount, model.fire.r0, model.fire.spread, model.fire.Lh] : [0, 1, 1, 1],
      uFireSeat: model.fire ? model.fire.seat : [0, 0, 0],
    });
    gl.bindVertexArray(bakeVao.v); gl.drawElements(gl.TRIANGLES, bakeVao.count, gl.UNSIGNED_INT, 0);

    mark('material', T.mat);
    // 4. resolve
    bindTarget(gl, T.a);
    use(gl, P.resolve, { uAlbedo: T.mat.tex[0], uSurf: T.mat.tex[1], uTexel: texel, uNormalStrength: look.normalStrength });
    drawQuad(gl);

    // 5. dilate
    let src = T.a, dst = T.b; const iters = 6;
    for (let i = 0; i < iters; i++) {
      bindTarget(gl, dst);
      use(gl, P.dilate, { uA: src.tex[0], uB: src.tex[1], uC: src.tex[2], uLast: i === iters - 1 ? 1 : 0 });
      drawQuad(gl);
      [src, dst] = [dst, src];
    }
    bakeVao.free();
    // a one-pixel readback is the only honest way to wait for the GPU
    gl.bindFramebuffer(gl.FRAMEBUFFER, src.fbo); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    bindTarget(gl, null);
    mark('resolve', src);
    state.result = { albedo: src.tex[0], normal: src.tex[1], orm: src.tex[2], fbo: src.fbo, size, ms: performance.now() - t0, times };
    return state.result;
  }

  // read one map back as RGBA8, top row first (the way image files and glTF want it)
  function read(index) {
    const r = state.result, px = new Uint8Array(r.size * r.size * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo); gl.readBuffer(gl.COLOR_ATTACHMENT0 + index);
    gl.readPixels(0, 0, r.size, r.size, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const row = r.size * 4, out = new Uint8ClampedArray(px.length);
    for (let y = 0; y < r.size; y++) out.set(px.subarray(y * row, (y + 1) * row), (r.size - 1 - y) * row);
    return out;
  }
  return { bake, read, state };
}
