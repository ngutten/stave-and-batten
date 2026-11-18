// Solid wood: a function of position inside a log. Every board is a slice of
// this, so face grain and end grain agree and knots pass through the board.
//
// The ring field F counts years outward from the pith. Branches are their own
// cones of growth, joined to the trunk with a smooth minimum, so rings flow
// round a knot the way they do in timber.
export const WOOD = `
uniform vec3 uEarly, uLate, uHeartTint, uKnotCol;
uniform float uRingW, uLateStart, uKnots, uPores, uRays, uFigure, uRelief, uChecks, uSapstain;

// flatc: the board's colour with all its figure taken out (for the drawn styles); krho, kr: distance from the nearest knot in knot radii, and that radius
struct Wood { vec3 col; vec3 base; vec3 flatc; float h; float rough; float late; float knot; float crack; float F; float krho; float kr; };

// knots: how knotty this piece is allowed to be (the species' figure, less for timber picked to be clear)
Wood woodAt(vec3 L, float seed, float texel, float knots){
  Wood W;
  vec2 pith = 0.03 * (vec2(vnoise(vec3(L.z*0.7, 3.1, 7.7)), vnoise(vec3(L.z*0.7, 9.2, 1.3))) - 0.5);
  vec2 q = L.xy - pith;

  // --- branches ---
  // A branch is a cone growing out from the pith. The trunk's fibres part
  // round it like water round a pile, and each year's growth climbs a little
  // way up it as a collar, so on a sawn face the rings swing wide of the knot
  // and close in loops beside it.
  float cellH = 0.45, zc = floor(L.z / cellH);
  vec2 shift = vec2(0.0); float dip = 0.0, halo = 0.0, tail = 0.0;
  float bRho = 1e9, bKr = 1.0, bFb = 0.0, bId = 0.0; vec2 bKp = vec2(0.0); vec3 bH = vec3(0.0), bH2 = vec3(0.0);
  for(int dz=-1; dz<=1; dz++) for(int j=0; j<2; j++){
    float cz = zc + float(dz);
    vec3 hs = hash3v(ivec3(int(cz), j, 17)), hs2 = hash3v(ivec3(int(cz), j, 91));
    if(hs.x > knots * 0.55) continue;
    float th = hs.y * 6.28318, z0 = (cz + 0.5 + (hs.z - 0.5) * 0.7) * cellH, tilt = 0.25 + 0.45 * hs2.x;
    vec3 a = vec3(cos(th)*cos(tilt), sin(th)*cos(tilt), sin(tilt));
    vec3 rel = vec3(q, L.z - z0);
    float t = dot(rel, a); if(t < 0.003) continue;
    vec3 perp = rel - a*t; float d = length(perp);
    float wbw = 0.10 + 0.30 * hs2.y * hs2.y;                 // most knots are small, a few are big
    float kr = t * wbw * (cos(tilt) - 0.2);                  // the cone: radius grows with distance from the pith
    if(d > kr * 5.0) continue;                               // a branch's reach stays inside the cells we search
    d *= 0.91 + 0.18 * vnoise(perp / max(d, 1e-5) * 1.3 + vec3(cz * 3.1, float(j) * 5.0, t * 6.0));     // no branch is round
    float rho = d / kr, outd = max(d - kr, 0.0), reach = 1.0 - smoothstep(3.0, 5.0, rho);
    vec3 c = normalize(vec3(a.y, -a.x, 0.0)), g = cross(c, a);       // across the grain, and along it, in the plane of the knot
    float yp = dot(perp, c), zp = dot(perp, g);
    shift -= c.xy * yp * (kr*kr) / max(d*d, kr*kr) * reach;
    dip += (2.0 + 4.5 * hs2.x) * exp(-outd / (0.85 * kr + 0.002)) * reach;
    halo = max(halo, exp(-outd / (0.32 * kr + 0.0015)));
    // sometimes resin bleeds down the grain from a knot
    tail = max(tail, step(0.6, hs.z) * exp(-abs(yp) / (0.5 * kr)) * exp(-max(zp * (hs2.z > 0.5 ? 1.0 : -1.0) - kr * 0.5, 0.0) / (4.0 * kr)) * step(0.0, zp * (hs2.z > 0.5 ? 1.0 : -1.0) + kr));
    if(rho < bRho){ bRho = rho; bKr = kr; bKp = vec2(yp, zp) / kr; bH = hs; bH2 = hs2; bFb = d / (wbw * uRingW) + t / (5.0 * uRingW); bId = cz * 2.0 + float(j); }
  }
  q += shift;

  float r = length(q);
  vec2 dirn = q / max(r, 1e-5);
  // trees are not round, and not the same shape all the way up
  float lobes = vnoise(vec3(dirn*1.7 + 4.0, L.z*0.6)) - 0.5;
  r *= 1.0 + uFigure * 0.16 * lobes;
  r += uFigure * 0.0030 * gnoise(vec3(q*22.0, L.z*1.6));
  float F = r / uRingW - dip;

  // --- the knot itself ---
  float kaa = clamp(1.3 * texel / bKr, 0.03, 0.6);
  float knot = 1.0 - smoothstep(1.0 - kaa, 1.0 + kaa, bRho);
  float star = 0.0, fine = 0.0, gap = 0.0, krings = 0.0, krim = 0.0;
  if(bRho < 1.6){
    float ang = atan(bKp.y, bKp.x), tk = texel / bKr;
    // the big checks run from the heart outward, widest in the middle of their length
    float narms = 3.0 + floor(bH2.z * 2.99);
    for(int i=0; i<5; i++){
      if(float(i) >= narms || bKr < 0.006) break;
      float hi = hash2(float(i) + 3.0, bId + 40.0);
      float aa = bH.z * 6.28318 + (float(i) + 0.7 * (hi - 0.5)) * 6.28318 / narms;
      vec2 dr = vec2(cos(aa), sin(aa));
      float al = dot(bKp, dr), len = 0.5 + 0.5 * hash2(float(i) + 9.0, bId + 40.0);
      float pd = abs(dot(bKp, vec2(-dr.y, dr.x)) + 0.05 * sin(al * 11.0 + hi * 20.0));
      float wd = 0.012 + 0.045 * pow(max(sin(3.14159 * clamp(al / len, 0.0, 1.0)), 0.0), 0.7) * (0.5 + hi) + 0.6 * tk;
      star = max(star, (1.0 - smoothstep(0.0, wd, pd)) * step(0.0, al) * step(al, len));
    }
    // finer checks live only in the outer rings, band by band
    float nb = 3.0 + floor(bH.x * 30.0), band = floor(bRho * nb), bf = fract(bRho * nb);
    float cells = 7.0 + 5.0 * band, ac = (ang / 6.28318 + 0.5) * cells + hash2(band, bId) * 7.0;
    fine = (1.0 - smoothstep(0.0, 0.07 + 0.5 * tk * cells / max(bRho, 0.2) / 6.28, abs(fract(ac) - 0.5))) * step(hash2(floor(ac) + 20.0 * band, bId + 7.0), 0.38)
         * smoothstep(0.0, 0.15, bf) * smoothstep(1.0, 0.75, bf) * step(0.4, bRho) * step(bRho, 1.0) * step(0.008, bKr);
    krings = 0.5 + 0.5 * cos(bRho * (5.0 + 7.0 * bH.y) * 3.14159 + 1.5 * sin(ang * 2.0 + bId));
    krim = smoothstep(0.35, 0.98, bRho);
    // where the knot has shrunk away from the wood that grew round it
    float gapA = smoothstep(0.30, 0.60, vnoise(vec3(cos(ang) * 1.4, sin(ang) * 1.4, bId * 1.7))) * (0.45 + 0.55 * step(bH2.x, 0.65));
    gap = (1.0 - smoothstep(0.0, max(0.0007, texel * 0.8), abs(bRho - 1.0) * bKr)) * gapA;
  }
  F = mix(F, bFb, knot);

  // good years and bad years
  F += 0.9 * (vnoise(vec3(F*0.23, 0.5, 0.5)) - 0.5) + 0.35 * (vnoise(vec3(F*1.1, 2.5, 0.5)) - 0.5);
  float fw = fwidth(F);
  float rf = fract(F), yr = floor(F);
  float edge = max(0.045, fw * 1.2);
  float late = pow(smoothstep(uLateStart, 0.955, rf), 1.5) * (1.0 - smoothstep(1.0 - edge, 1.0, rf));
  late = mix(late, 0.42 * (1.0 - uLateStart) + 0.08, smoothstep(0.4, 1.1, fw));   // rings finer than texels: fade to the mean
  float yearTint = hash2(yr, 5.0);

  // fibres: long and thin, following the grain, at three scales
  float s1 = vnoise(vec3(q*95.0, L.z*1.1));
  float s2 = vnoise(vec3(q*240.0, L.z*2.6));
  float s3 = vnoise(vec3(q*520.0, L.z*8.0));
  float f2 = 1.0 - smoothstep(0.7, 1.6, texel * 240.0), f3 = 1.0 - smoothstep(0.7, 1.6, texel * 520.0);
  float fib = 0.5 + (s1 - 0.5) * 0.45 + (s2 - 0.5) * 0.40 * f2 + (s3 - 0.5) * 0.35 * f3;

  vec3 col = mix(uEarly, uLate, sat(late * (0.75 + 0.5 * yearTint)));
  // heartwood, and slow mottling through the log
  float heart = smoothstep(0.11, 0.05, r + 0.02 * gnoise(vec3(q*9.0, L.z*0.8)));
  col = mix(col, col * uHeartTint, heart);
  col *= 0.88 + 0.24 * vnoise(vec3(q*5.0, L.z*1.1));
  col *= 0.86 + 0.28 * fib;
  // per-board character: each board came from a slightly different tree
  float tv = hash1(seed), th2 = hash1(seed + 0.37), th3 = hash1(seed + 0.61);
  col *= 0.80 + 0.34 * tv;
  col = mix(col, col * vec3(1.07, 1.0, 0.88), th2);
  col = mix(col, vec3(luma(col)), 0.22 * th3);
  vec3 fc = mix(uEarly, uLate, 0.30) * (0.80 + 0.34 * tv); fc = mix(fc, fc * vec3(1.07, 1.0, 0.88), th2); fc = mix(fc, vec3(luma(fc)), 0.22 * th3);

  // resin canals and flecks: short dark dashes in the summer wood
  float fleck = smoothstep(0.80, 0.90, vnoise(vec3(q*330.0, L.z*38.0))) * (0.35 + 0.65 * late) * (1.0 - smoothstep(0.6, 1.5, texel * 330.0));
  col *= 1.0 - 0.30 * fleck;

  // sapstain: blue-grey fungus streaks some boards arrive with
  float sap = 0.0;
  if(uSapstain > 0.0 && hash1(seed + 0.83) < 0.4 * uSapstain){
    sap = smoothstep(0.50, 0.78, vnoise(vec3(q*26.0, L.z*0.5 + seed*5.0))) * smoothstep(0.25, 0.7, s1 * 0.6 + s2 * 0.4) * (1.0 - heart);
    col = mix(col, luma(col) * vec3(0.66, 0.70, 0.76), sap * 0.55);
  }

  // ring-porous woods: open vessels in the spring growth
  float pore = 0.0;
  if(uPores > 0.0){
    float pn = vnoise(vec3(q*700.0, L.z*30.0));
    pore = smoothstep(0.66, 0.78, pn) * (1.0 - smoothstep(0.0, 0.45, rf)) * uPores * (1.0 - smoothstep(0.6, 1.8, texel * 700.0));
    col *= 1.0 - 0.45 * pore;
  }
  // medullary rays: thin sheets running out from the pith. They only show as
  // fleck where the sawn face lies almost along a radius; elsewhere they are
  // finer than a texel and fade out.
  float ray = 0.0;
  if(uRays > 0.0){
    vec2 ra = dirn * 210.0;
    float vis = (1.0 - smoothstep(0.25, 0.9, length(fwidth(ra)))) * (1.0 - smoothstep(0.5, 1.2, texel * 330.0));
    if(vis > 0.0){
      ray = smoothstep(0.60, 0.74, vnoise(vec3(ra, L.z * 330.0))) * smoothstep(0.30, 0.55, vnoise(vec3(r * 40.0, L.z * 50.0, 3.0))) * uRays * vis;
      col = mix(col, col * 1.20 + 0.02, ray * 0.75);
    }
  }
  W.base = col;
  // knots: dark at the rim, paler at the heart, in a stained halo
  col = mix(col, col * vec3(0.66, 0.52, 0.40), halo * 0.8 * (1.0 - knot));
  col = mix(col, col * vec3(0.84, 0.56, 0.42), tail * 0.55 * (1.0 - knot));
  vec3 kc = mix(uKnotCol * vec3(2.5, 2.25, 1.7), uKnotCol * 0.80, krim) * (0.82 + 0.36 * krings + 0.25 * (s2 - 0.5));
  col = mix(col, kc, knot * 0.96);
  col *= 1.0 - 0.9 * max(star, fine * 0.75) * knot;
  col *= 1.0 - 0.9 * gap;

  // seasoning checks: thin splits along the grain
  float cn = vnoise(vec3(q*55.0, L.z*1.3 + seed*31.0));
  float cw = max(0.012, texel * 55.0 * 0.55);
  float crack = (1.0 - smoothstep(0.0, cw, abs(cn - 0.5))) * smoothstep(0.52, 0.72, vnoise(vec3(q*14.0, L.z*2.2 + 7.0)));
  crack = max(crack * uChecks * (1.0 - knot), max(max(star, fine * 0.6) * knot, gap));

  W.col = col; W.late = late; W.knot = knot; W.crack = crack; W.F = F; W.flatc = fc; W.krho = bRho; W.kr = bKr;
  // latewood is harder and stands proud once the soft spring wood wears
  W.h = uRelief * (late - 0.35) * 0.00030 + (fib - 0.5) * 0.00022 * (0.4 + uRelief) - pore * 0.00012 - fleck * 0.00008 + knot * (0.00025 + 0.00012 * krings) - halo * (1.0 - knot) * 0.00012;
  W.rough = mix(0.76, 0.60, late) - 0.12 * ray + 0.10 * (fib - 0.5) - 0.16 * knot;
  return W;
}
`;
