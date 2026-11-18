// Markings: where their images come from. Three sources: the built-in stencil
// library, text typed by the user (cut like a stencil), and any image the
// user loads. Each becomes a texture whose alpha is coverage ("paint here").

import { STENCILS } from './assets/stencils.js';

const MAXPX = 512;
// letters with enclosed counters need a bridge or the middle falls out of the stencil
const COUNTERS = new Set('ABDOPQR04689abdegopq@&%#'.split(''));

export function createMarks(gl, onReady) {
  const cache = new Map();
  let pending = 0;          // images still decoding

  function upload(rgba, w, h) {
    // flip rows: images are top-down, textures bottom-up
    const row = w * 4, flipped = new Uint8Array(rgba.length);
    for (let y = 0; y < h; y++) flipped.set(rgba.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { tex };
  }

  // Draw a source onto a canvas no larger than MAXPX, with a clear two-pixel frame.
  function toPixels(src, sw, sh) {
    const s = Math.min(1, (MAXPX - 4) / Math.max(sw, sh)), w = Math.max(4, Math.round(sw * s)) + 4, h = Math.max(4, Math.round(sh * s)) + 4;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(src, 2, 2, w - 4, h - 4);
    return { d: cx.getImageData(0, 0, w, h).data, w, h };
  }
  const frame = (a, w, h) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) a[(y * w + x) * 4 + 3] = 0; };

  // kind: 'mask' (white is paint), 'auto' (work out what the picture means)
  function build(src, sw, sh, kind) {
    const { d, w, h } = toPixels(src, sw, sh), n = w * h;
    const cov = new Uint8Array(n * 4), lab = new Uint8Array(d);
    let minA = 255, sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) { const a = d[i * 4 + 3]; if (a < minA) minA = a; if (a > 8) { sum += 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]; cnt++; } }
    const inner = (x, y) => x >= 2 && y >= 2 && x < w - 2 && y < h - 2;
    let hasAlpha = false;
    for (let y = 2; y < h - 2 && !hasAlpha; y++) for (let x = 2; x < w - 2; x++) if (d[(y * w + x) * 4 + 3] < 250) { hasAlpha = true; break; }
    const mean = cnt ? sum / cnt / 255 : 1, dark = mean > 0.5;       // dark art on a light ground, or the reverse
    for (let i = 0; i < n; i++) {
      const x = i % w, y = (i / w) | 0, L = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
      let c;
      if (kind === 'mask') c = L * (d[i * 4 + 3] / 255);
      else if (hasAlpha) c = d[i * 4 + 3] / 255;                      // a cut-out: its shape is the stencil
      else { const t = dark ? 1 - L : L; c = Math.max(0, Math.min(1, (t - 0.3) / 0.4)); }
      if (!inner(x, y)) c = 0;
      cov[i * 4] = kind === 'mask' ? 255 : d[i * 4]; cov[i * 4 + 1] = kind === 'mask' ? 255 : d[i * 4 + 1]; cov[i * 4 + 2] = kind === 'mask' ? 255 : d[i * 4 + 2];
      cov[i * 4 + 3] = Math.round(c * 255);
      // the label keeps the picture whole; an opaque picture is a full rectangle of paper
      if (!hasAlpha) lab[i * 4 + 3] = 255;
    }
    frame(lab, w, h);
    return { tex: upload(cov, w, h), texLabel: upload(lab, w, h), aspect: (w - 4) / (h - 4), ready: true };
  }

  function loadImage(key, url, kind) {
    const entry = { ready: false }; cache.set(key, entry); pending++;
    const img = new Image();
    img.onload = () => { pending--; Object.assign(entry, build(img, img.naturalWidth, img.naturalHeight, kind)); onReady(); };
    img.onerror = () => { pending--; entry.failed = true; };
    img.src = url;
    return entry;
  }

  function textCanvas(str) {
    const px = 150, font = `900 ${px}px "Arial Black", "Helvetica Neue", Impact, "DejaVu Sans", sans-serif`;
    const cv = document.createElement('canvas'), cx = cv.getContext('2d');
    cx.font = font;
    const lines = String(str).split('\n').slice(0, 4), widths = lines.map((l) => cx.measureText(l).width);
    cv.width = Math.max(40, Math.ceil(Math.max(...widths)) + 24); cv.height = Math.ceil(lines.length * px * 1.1) + 16;
    cx.font = font; cx.textBaseline = 'top'; cx.fillStyle = '#fff';
    lines.forEach((l, li) => {
      const x0 = (cv.width - widths[li]) / 2, y0 = 8 + li * px * 1.1;
      cx.fillText(l, x0, y0 + px * 0.06);
      // bridges, so it could really be cut from a sheet
      cx.save(); cx.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < l.length; i++) {
        if (!COUNTERS.has(l[i])) continue;
        const a = cx.measureText(l.slice(0, i)).width, b = cx.measureText(l.slice(0, i + 1)).width, bw = px * 0.055;
        cx.fillRect(x0 + (a + b) / 2 - bw / 2, y0, bw, px * 1.1);
      }
      cx.restore();
    });
    return cv;
  }

  return {
    library: STENCILS,
    pending: () => pending,
    // spec: { src: 'lib' | 'text' | 'user' | 'none', id, text, slot }
    get(spec, slotKey) {
      let key, make;
      if (spec.src === 'lib') { const st = STENCILS.find((s) => s.id === spec.id); if (!st) return null; key = 'lib:' + st.id; make = () => loadImage(key, st.src, 'mask'); }
      else if (spec.src === 'text') { if (!spec.text) return null; key = 'text:' + spec.text; make = () => { const cv = textCanvas(spec.text), e = build(cv, cv.width, cv.height, 'auto'); cache.set(key, e); return e; }; }
      else if (spec.src === 'user') { key = 'user:' + slotKey; make = () => null; }
      else return null;
      const e = cache.get(key) || make();
      return e && e.ready ? e : null;
    },
    // a picture the user chose for one slot
    setUser(slotKey, file) {
      const old = cache.get('user:' + slotKey); if (old && old.ready) { gl.deleteTexture(old.tex.tex); gl.deleteTexture(old.texLabel.tex); }
      const url = URL.createObjectURL(file), e = loadImage('user:' + slotKey, url, 'auto');
      e.name = file.name;
      return e;
    },
    userName: (slotKey) => (cache.get('user:' + slotKey) || {}).name || '',
  };
}

export const hexToRgb = (hex) => { const n = parseInt(String(hex).replace('#', ''), 16) || 0; return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
