// glTF binary export. One mesh per level of detail. Each material has three
// textures (base colour; normal; occlusion / roughness / metallic packed the
// way glTF wants them); the card level of detail has its own, cut out by
// alpha. Lower LODs hang off the first through MSFT_lod, so viewers that do
// not know the extension simply show the first.

const pad4 = (n) => (n + 3) & ~3;

// lods: [{ geo: { pos, nrm, tan, uv, idx, nv }, material, label }]; materials: [{ name, images: { albedo, normal, orm } as PNG bytes, mask }]
export function buildGLB({ name, lods, materials, extras }) {
  const chunks = [], views = [], accessors = [];
  let offset = 0;
  const addView = (bytes, target) => {
    const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    views.push({ buffer: 0, byteOffset: offset, byteLength: u8.byteLength, ...(target ? { target } : {}) });
    chunks.push(u8); offset += u8.byteLength;
    const p = pad4(offset) - offset; if (p) { chunks.push(new Uint8Array(p)); offset += p; }
    return views.length - 1;
  };
  const addAcc = (arr, type, comp, count, target, minmax) => {
    accessors.push({ bufferView: addView(arr, target), componentType: comp, count, type, ...(minmax || {}) });
    return accessors.length - 1;
  };
  const F = 5126, U16 = 5123, U32 = 5125, ARRAY = 34962, ELEMENT = 34963;
  const meshes = [], nodes = [];
  lods.forEach((L, li) => {
    const g = L.geo;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < g.pos.length; i += 3) for (let j = 0; j < 3; j++) { mn[j] = Math.min(mn[j], g.pos[i + j]); mx[j] = Math.max(mx[j], g.pos[i + j]); }
    // glTF puts v = 0 at the top of the image
    const uv = new Float32Array(g.uv.length); for (let i = 0; i < uv.length; i += 2) { uv[i] = g.uv[i]; uv[i + 1] = 1 - g.uv[i + 1]; }
    // unit normals and tangents, as the format requires
    const nrm = new Float32Array(g.nrm.length), tan = new Float32Array(g.tan.length);
    for (let i = 0; i < g.nv; i++) {
      let nx = g.nrm[i * 3], ny = g.nrm[i * 3 + 1], nz = g.nrm[i * 3 + 2]; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      let tx = g.tan[i * 4], ty = g.tan[i * 4 + 1], tz = g.tan[i * 4 + 2]; const d = tx * nx + ty * ny + tz * nz; tx -= nx * d; ty -= ny * d; tz -= nz * d;
      let tl = Math.hypot(tx, ty, tz);
      if (tl < 1e-6) { const ax = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 1, 0], dd = ax[0] * nx + ax[1] * ny + ax[2] * nz; tx = ax[0] - nx * dd; ty = ax[1] - ny * dd; tz = ax[2] - nz * dd; tl = Math.hypot(tx, ty, tz); }
      nrm.set([nx, ny, nz], i * 3); tan.set([tx / tl, ty / tl, tz / tl, 1], i * 4);
    }
    const small = g.nv < 65536, idx = small ? new Uint16Array(g.idx) : g.idx;
    const prim = {
      attributes: {
        POSITION: addAcc(g.pos, 'VEC3', F, g.nv, ARRAY, { min: mn, max: mx }), NORMAL: addAcc(nrm, 'VEC3', F, g.nv, ARRAY),
        TANGENT: addAcc(tan, 'VEC4', F, g.nv, ARRAY), TEXCOORD_0: addAcc(uv, 'VEC2', F, g.nv, ARRAY),
      },
      indices: addAcc(idx, 'SCALAR', small ? U16 : U32, idx.length, ELEMENT), material: L.material || 0, mode: 4,
    };
    meshes.push({ name: `${name}_${L.label}`, primitives: [prim] });
    nodes.push({ name: `${name}_${L.label}`, mesh: li });
  });
  if (nodes.length > 1) nodes[0].extensions = { MSFT_lod: { ids: nodes.slice(1).map((_, i) => i + 1) } };
  const imgs = [], textures = [], mats = [];
  materials.forEach((M, mi) => {
    for (const k of ['albedo', 'normal', 'orm']) { imgs.push({ name: `${M.name}_${k}`, mimeType: 'image/png', bufferView: addView(M.images[k]) }); textures.push({ source: imgs.length - 1, sampler: 0 }); }
    mats.push({
      name: M.name, pbrMetallicRoughness: { baseColorTexture: { index: mi * 3 }, metallicRoughnessTexture: { index: mi * 3 + 2 }, metallicFactor: 1, roughnessFactor: 1 },
      normalTexture: { index: mi * 3 + 1 }, occlusionTexture: { index: mi * 3 + 2 },
      ...(M.mask ? { alphaMode: 'MASK', alphaCutoff: 0.4, doubleSided: true } : {}),
      // a drawn style is its own lighting: ask the engine not to light it again
      ...(M.unlit ? { extensions: { KHR_materials_unlit: {} } } : {}),
    });
  });
  const used = [...(nodes.length > 1 ? ['MSFT_lod'] : []), ...(materials.some((M) => M.unlit) ? ['KHR_materials_unlit'] : [])];
  const gltf = {
    asset: { version: '2.0', generator: 'Stave & Batten' },
    scene: 0, scenes: [{ name, nodes: [0] }], nodes, meshes,
    materials: mats, textures,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    images: imgs, accessors, bufferViews: views, buffers: [{ byteLength: offset }],
    ...(used.length ? { extensionsUsed: used } : {}),
    ...(extras ? { extras } : {}),
  };
  const enc = new TextEncoder().encode(JSON.stringify(gltf)), jlen = pad4(enc.length), blen = pad4(offset);
  const out = new Uint8Array(12 + 8 + jlen + 8 + blen), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jlen, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(enc, 20); for (let i = enc.length; i < jlen; i++) out[20 + i] = 0x20;
  dv.setUint32(20 + jlen, blen, true); dv.setUint32(24 + jlen, 0x004e4942, true);
  let o = 28 + jlen; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(parts) { let c = 0xffffffff; for (const u8 of parts) for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// RGBA bytes (top row first) -> PNG bytes.
// A canvas is quickest, but it multiplies colour by alpha, which throws away
// the colour under the transparent parts of a cut-out and leaves a dark fringe
// in any engine that filters the texture. So anything with real alpha is
// encoded here by hand.
export async function encodePNG(rgba, size, keepAlpha = false) {
  if (keepAlpha && typeof CompressionStream !== 'undefined') {
    const row = size * 4, raw = new Uint8Array((row + 1) * size);
    for (let y = 0; y < size; y++) {
      const o = y * (row + 1), i = y * row; raw[o] = 1;                       // filter: difference from the pixel to the left
      for (let x = 0; x < row; x++) raw[o + 1 + x] = (rgba[i + x] - (x >= 4 ? rgba[i + x - 4] : 0)) & 255;
    }
    const cs = new CompressionStream('deflate'), w = cs.writable.getWriter(); w.write(raw); w.close();
    const z = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    const chunk = (type, data) => {
      const head = new Uint8Array(8), dv = new DataView(head.buffer); dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
      const tail = new Uint8Array(4); new DataView(tail.buffer).setUint32(0, crc32([head.subarray(4), data]));
      return [head, data, tail];
    };
    const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, size); dv.setUint32(4, size); ihdr.set([8, 6, 0, 0, 0], 8);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunk('IHDR', ihdr), ...chunk('IDAT', z), ...chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
  cv.getContext('2d').putImageData(new ImageData(rgba, size, size), 0, 0);
  const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export function download(bytes, filename, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type })), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
