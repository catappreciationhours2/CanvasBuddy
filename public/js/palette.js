// palette.js — browser glue for the Palette engine: loading images, running the pure analysis,
// and rendering the visual breakdowns (value studies, edges, color masses, peel-back painting layers).
import { analyzeLocal, hexToRgb, rgbToLab, deltaE, boxBlur, rgbaToGray } from './construct.js';
import { extractLineArt } from './lineart.js';

export const ANALYSIS_MAX = 320;
const LINEART_MAX = 720;
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

export function loadImageFromSrc(src) {
  return new Promise((resolve, reject) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img); img.onerror = () => reject(new Error('Could not load that image')); img.src = src;
  });
}
export function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpe?g|webp|gif|svg\+xml)$/.test(file.type)) return reject(new Error('Please choose a PNG, JPG, WebP or SVG image'));
    if (file.size > 25 * 1024 * 1024) return reject(new Error('That file is over 25MB — please pick a smaller one'));
    const url = URL.createObjectURL(file);
    loadImageFromSrc(url).then((img) => resolve(img)).catch(reject);
  });
}

/** Draw an image onto a white canvas whose long side is `maxSide` (never upscales beyond the source for analysis). */
export function toCanvas(img, maxSide) {
  const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  const s = maxSide / Math.max(sw, sh), w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
  const c = mk(w, h), ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.imageSmoothingQuality = 'high'; if (Math.min(sw, sh) <= 128) ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, w, h); return c;
}

/** Full local analysis for an image element. */
export function analyzeImage(img) {
  const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  const c = toCanvas(img, ANALYSIS_MAX), ctx = c.getContext('2d');
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const res = analyzeLocal(data.data, c.width, c.height, { sourceW: sw, sourceH: sh, skipLineArt: true });
  { // line art needs far more detail than the 192-px analysis maps (whiskers, hatching): extract it from a larger copy
    const big = toCanvas(img, LINEART_MAX), bd = big.getContext('2d').getImageData(0, 0, big.width, big.height);
    try { const la = extractLineArt(rgbaToGray(bd.data, big.width * big.height), big.width, big.height); res.summary.lineart = { strokes: la.strokes, main: la.main, mode: la.mode, count: la.count }; } catch { res.summary.lineart = null; }
  }
  res.analysisCanvas = c; res.sourceSize = [sw, sh];
  return res;
}

/** JPEG data URL for the vision model (small = cheap + fast). */
export function modelImage(img, maxSide = 768, q = 0.82) { return toCanvas(img, maxSide).toDataURL('image/jpeg', q); }

/**
 * The ONLY pixels that ever leave the device: a re-rasterised, size-capped copy. Re-drawing through a canvas drops EXIF/GPS/XMP and
 * any text chunks; optional mosaic patches hide areas the artist marked sensitive; optional grayscale + small size for "privacy mode".
 */
export function modelCanvas(img, { maxSide = 768, scrub = [], gray = false } = {}) {
  const c = toCanvas(img, gray ? Math.min(maxSide, 448) : maxSide), ctx = c.getContext('2d'), W = c.width, H = c.height;
  for (const [x0, y0, x1, y1] of scrub) {
    const x = Math.round(x0 * W), y = Math.round(y0 * H), w = Math.max(1, Math.round((x1 - x0) * W)), h = Math.max(1, Math.round((y1 - y0) * H));
    const t = document.createElement('canvas'); t.width = Math.max(2, Math.round(w / 24)); t.height = Math.max(2, Math.round(h / 24));
    t.getContext('2d').drawImage(c, x, y, w, h, 0, 0, t.width, t.height);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(t, 0, 0, t.width, t.height, x, y, w, h); ctx.imageSmoothingEnabled = true;
  }
  if (gray) { const d = ctx.getImageData(0, 0, W, H), a = d.data; for (let i = 0; i < a.length; i += 4) { const g = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]; a[i] = a[i + 1] = a[i + 2] = g; } ctx.putImageData(d, 0, 0); }
  return c;
}

/** IMAGE 2 for the tutor: the same picture with a 0..1 coordinate grid and the measured dark/light regions labelled D1…/L1…. */
export function annotatedDataUrl(canvas, regions = [], q = 0.82) {
  const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; const ctx = c.getContext('2d'), W = c.width, H = c.height;
  ctx.drawImage(canvas, 0, 0);
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,0,170,.38)'; ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.font = `${Math.max(10, Math.round(W / 70))}px sans-serif`;
  for (let i = 1; i < 10; i++) {
    ctx.beginPath(); ctx.moveTo((i / 10) * W, 0); ctx.lineTo((i / 10) * W, H); ctx.moveTo(0, (i / 10) * H); ctx.lineTo(W, (i / 10) * H); ctx.stroke();
    const label = (i / 10).toFixed(1), tw = ctx.measureText(label).width + 4;
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect((i / 10) * W - tw / 2, 0, tw, 14); ctx.fillRect(0, (i / 10) * H - 7, tw, 14);
    ctx.fillStyle = '#b0007a'; ctx.fillText(label, (i / 10) * W - tw / 2 + 2, 11); ctx.fillText(label, 2, (i / 10) * H + 4);
  }
  for (const r of regions) {
    const col = r.kind === 'hollow' ? '#12b886' : r.tone === 'dark' ? '#00b8ff' : '#ff8a00';
    ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.beginPath();
    (r.contour || []).forEach(([x, y], k) => (k ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H))); ctx.closePath(); ctx.stroke();
    const cx = r.centroid[0] * W, cy = r.centroid[1] * H, tw = ctx.measureText(r.id).width + 8;
    ctx.fillStyle = col; ctx.fillRect(cx - tw / 2, cy - 8, tw, 16); ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.max(10, Math.round(W / 62))}px sans-serif`; ctx.fillText(r.id, cx - tw / 2 + 4, cy + 4);
  }
  return c.toDataURL('image/jpeg', q);
}

/* ---------- visual breakdowns ---------- */
const GRAYS3 = [[52, 50, 61], [158, 152, 176], [255, 249, 242]];
const GRAYS5 = [[40, 38, 48], [96, 92, 112], [152, 146, 170], [208, 202, 218], [255, 249, 242]];

function fromRgba(w, h, fn) {
  const c = mk(w, h), ctx = c.getContext('2d'), img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) { const px = fn(i); img.data[i * 4] = px[0]; img.data[i * 4 + 1] = px[1]; img.data[i * 4 + 2] = px[2]; img.data[i * 4 + 3] = px[3] ?? 255; }
  ctx.putImageData(img, 0, 0); return c;
}
function nearestPalette(pal, rgb) {
  const lab = rgbToLab(rgb[0], rgb[1], rgb[2]); let best = 0, bd = Infinity;
  for (let i = 0; i < pal.length; i++) { const d = deltaE(lab, pal[i].lab); if (d < bd) { bd = d; best = i; } }
  return pal[best].rgb;
}
function paletteRgb(maps) { return maps.palette.map((p) => ({ ...p, rgb: hexToRgb(p.hex) })); }

/** kind: original | value3 | value5 | edges | masses. Returns a canvas at analysis resolution. */
export function renderBreakdown(maps, kind) {
  const { w, h, rgba } = maps; const n = w * h;
  switch (kind) {
    case 'value3': return fromRgba(w, h, (i) => GRAYS3[maps.levels3[i]]);
    case 'value5': return fromRgba(w, h, (i) => GRAYS5[maps.levels5[i]]);
    case 'edges': return fromRgba(w, h, (i) => (maps.edges[i] ? [52, 50, 61] : [255, 249, 242]));
    case 'masses': {
      const pal = paletteRgb(maps);
      const ch = [0, 1, 2].map((k) => boxBlur(Float32Array.from({ length: n }, (_, i) => rgba[i * 4 + k]), w, h, Math.max(2, Math.round(w * 0.04))));
      return fromRgba(w, h, (i) => nearestPalette(pal, [ch[0][i], ch[1][i], ch[2][i]]));
    }
    default: { const c = mk(w, h); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0); return c; }
  }
}

/** Translucent raster overlays used as lesson guides. */
export function renderGuideRaster(maps, name) {
  const { w, h } = maps;
  if (name === 'edges') return fromRgba(w, h, (i) => (maps.edges[i] ? [124, 107, 214, 230] : [0, 0, 0, 0]));
  if (name === 'value3') return fromRgba(w, h, (i) => [[52, 50, 61, 120], [140, 128, 190, 70], [0, 0, 0, 0]][maps.levels3[i]]);
  if (name === 'value5') return fromRgba(w, h, (i) => [[52, 50, 61, 130], [92, 84, 130, 95], [140, 128, 190, 60], [190, 180, 225, 35], [0, 0, 0, 0]][maps.levels5[i]]);
  if (name === 'masses') { const c = renderBreakdown(maps, 'masses'); const ctx = c.getContext('2d'); ctx.globalCompositeOperation = 'destination-in'; ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(0, 0, w, h); return c; }
  return null;
}

/**
 * The "peel" stack: a plausible teaching sequence, NOT the artist's real process.
 * Each stage is built from the previous idea at higher fidelity.
 */
export function buildPaintingLayers(maps) {
  const { w, h, rgba } = maps, n = w * h, pal = paletteRgb(maps);
  const meanColors = (levels, count) => {
    const sums = Array.from({ length: count }, () => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) { const s = sums[levels[i]]; s[0] += rgba[i * 4]; s[1] += rgba[i * 4 + 1]; s[2] += rgba[i * 4 + 2]; s[3]++; }
    return sums.map((s) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : [128, 128, 128]));
  };
  const blurred = (r) => [0, 1, 2].map((k) => boxBlur(Float32Array.from({ length: n }, (_, i) => rgba[i * 4 + k]), w, h, r));
  const soften = (canvas, px) => { const c = mk(w, h), x = c.getContext('2d'); x.filter = `blur(${px}px)`; x.drawImage(canvas, 0, 0); return c; };
  const m3 = meanColors(maps.levels3, 3), m5 = meanColors(maps.levels5, 5);
  const bl1 = blurred(Math.max(3, Math.round(w * 0.05))), bl2 = blurred(Math.max(1, Math.round(w * 0.012)));

  const stages = [
    { id: 'masses', title: 'Big color masses', note: 'Block in the largest shapes with a big brush — no detail yet.', canvas: soften(fromRgba(w, h, (i) => nearestPalette(pal, [bl1[0][i], bl1[1][i], bl1[2][i]])), 1.5) },
    { id: 'shadows', title: 'Shadow, mid & light blocks', note: 'Three values only. If these are right, the picture already reads.', canvas: soften(fromRgba(w, h, (i) => m3[maps.levels3[i]]), 1.2) },
    { id: 'midtones', title: 'Midtones', note: 'Split the values further and refine the color relationships.', canvas: soften(fromRgba(w, h, (i) => m5[maps.levels5[i]]), 0.8) },
    { id: 'highlights', title: 'Colors & highlights', note: 'Bring in the palette colors and place the brightest lights.', canvas: fromRgba(w, h, (i) => nearestPalette(pal, [bl2[0][i], bl2[1][i], bl2[2][i]])) },
    { id: 'details', title: 'Edges & details', note: 'Last: sharpen edges at the focal point and add texture.', canvas: renderBreakdown(maps, 'original') },
  ];
  return stages;
}
