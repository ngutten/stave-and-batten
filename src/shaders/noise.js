// Shared GLSL: integer hashes and noise. Deterministic across GPUs (no sin-hash).
export const NOISE = `
uint hashu(uint x){ x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16; return x; }
float hash3i(ivec3 p){ return float(hashu(uint(p.x) + hashu(uint(p.y) + hashu(uint(p.z))))) * (1.0/4294967296.0); }
float hash1(float a){ return float(hashu(uint(int(floor(a*8191.0))) + 0x9e3779b9U)) * (1.0/4294967296.0); }
float hash2(float a, float b){ return hash3i(ivec3(int(floor(a)), int(floor(b)), 77)); }
vec3 hash3v(ivec3 p){ uint h = hashu(uint(p.x) + hashu(uint(p.y) + hashu(uint(p.z)))); uint h2 = hashu(h + 0x68bc21ebU); uint h3 = hashu(h2 + 0x02e5be93U);
  return vec3(float(h), float(h2), float(h3)) * (1.0/4294967296.0); }

// value noise, 0..1
float vnoise(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f*f*f*(f*(f*6.0-15.0)+10.0); ivec3 I = ivec3(i);
  return mix(mix(mix(hash3i(I), hash3i(I+ivec3(1,0,0)), f.x), mix(hash3i(I+ivec3(0,1,0)), hash3i(I+ivec3(1,1,0)), f.x), f.y),
             mix(mix(hash3i(I+ivec3(0,0,1)), hash3i(I+ivec3(1,0,1)), f.x), mix(hash3i(I+ivec3(0,1,1)), hash3i(I+ivec3(1,1,1)), f.x), f.y), f.z);
}
// gradient noise, roughly -1..1
float gnoise(vec3 p){
  vec3 i = floor(p), f = fract(p), u = f*f*f*(f*(f*6.0-15.0)+10.0); ivec3 I = ivec3(i);
  float r = 0.0;
  #define GN(o) dot(hash3v(I+o)*2.0-1.0, f-vec3(o))
  r = mix(mix(mix(GN(ivec3(0,0,0)), GN(ivec3(1,0,0)), u.x), mix(GN(ivec3(0,1,0)), GN(ivec3(1,1,0)), u.x), u.y),
          mix(mix(GN(ivec3(0,0,1)), GN(ivec3(1,0,1)), u.x), mix(GN(ivec3(0,1,1)), GN(ivec3(1,1,1)), u.x), u.y), u.z);
  #undef GN
  return r * 1.6;
}
float fbm(vec3 p){ float a = 0.5, s = 0.0; for(int i=0;i<4;i++){ s += a*gnoise(p); p = p*2.03 + vec3(17.1, 3.7, 9.3); a *= 0.5; } return s; }
float fbm2(vec3 p){ float a = 0.5, s = 0.0; for(int i=0;i<2;i++){ s += a*gnoise(p); p = p*2.03 + vec3(17.1, 3.7, 9.3); a *= 0.5; } return s; }
// cellular: distance to nearest feature point and its id
vec2 worley(vec2 p){
  vec2 i = floor(p), f = fract(p); float d = 9.0, id = 0.0;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    vec3 h = hash3v(ivec3(int(i.x)+x, int(i.y)+y, 31)); vec2 o = vec2(float(x), float(y)) + h.xy - f; float dd = dot(o,o);
    if(dd < d){ d = dd; id = h.z; }
  }
  return vec2(sqrt(d), id);
}
float smin(float a, float b, float k){ float h = max(k - abs(a-b), 0.0)/k; return min(a,b) - h*h*k*0.25; }
float sat(float x){ return clamp(x, 0.0, 1.0); }
vec3 srgb2lin(vec3 c){ return pow(c, vec3(2.2)); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;
