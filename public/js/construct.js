// construct.js — pure image analysis (no DOM). Runs in the browser AND in Node tests.
// Everything operates on typed arrays at a small working resolution (~192px).
// Deterministic geometry (ellipses, contours, value maps) comes from here, NOT from the LLM:
// the model's coordinates are estimates, these are pixel-derived.

import { distanceTransform } from './artist.js';
import { extractLineArt } from './lineart.js';

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- color ---------- */
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
export function rgbToLab(r, g, b) {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const inv = (t) => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const G = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  const gm = (c) => { c = Math.max(0, Math.min(1, c)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); };
  return [gm(R), gm(G), gm(B)];
}
export const toHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/* ---------- basic filters ---------- */
export function rgbaToGray(rgba, n) {
  const g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2];
  return g;
}

export function boxBlur(src, w, h, r) {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), d = 2 * r + 1;
  const cl = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  for (let y = 0; y < h; y++) {
    const row = y * w; let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + cl(x, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / d;
      sum += src[row + cl(x + r + 1, w - 1)] - src[row + cl(x - r, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[cl(y, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / d;
      sum += tmp[cl(y + r + 1, h - 1) * w + x] - tmp[cl(y - r, h - 1) * w + x];
    }
  }
  return out;
}

export function otsu(values, maxV = 255) {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, Math.round((values[i] / maxV) * 255)))]++;
  const total = values.length; let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, best = -1, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return (thr / 255) * maxV;
}

function morph(mask, w, h, r, dilate) {
  if (r < 1) return Uint8Array.from(mask);
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const outside = dilate ? 0 : 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r; k++) {
      const xx = x + k; const m = xx < 0 || xx >= w ? outside : mask[y * w + xx];
      if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
    }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r; k++) {
      const yy = y + k; const m = yy < 0 || yy >= h ? outside : tmp[yy * w + x];
      if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
    }
    out[y * w + x] = v;
  }
  return out;
}
export const dilate = (m, w, h, r) => morph(m, w, h, r, true);
export const erode = (m, w, h, r) => morph(m, w, h, r, false);
export const closeMask = (m, w, h, r) => erode(dilate(m, w, h, r), w, h, r);

/** Fill enclosed holes (background not reachable from the image border). */
export function fillHoles(mask, w, h) {
  const seen = new Uint8Array(w * h), stack = [];
  const push = (i) => { if (!mask[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w); if (y < h - 1) push(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] || !seen[i] ? 1 : 0;
  return out;
}

/* ---------- components, ellipses, contours ---------- */
export function labelComponents(mask, w, h, minArea = 1) {
  const labels = new Int32Array(w * h).fill(-1), stack = new Int32Array(w * h), comps = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s] !== -1) continue;
    const id = comps.length; let sp = 0; stack[sp++] = s; labels[s] = id;
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && labels[p - w] === -1) { labels[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && labels[p + w] === -1) { labels[p + w] = id; stack[sp++] = p + w; }
    }
    comps.push({ id, area: n, bbox: [x0, y0, x1, y1], cx: sx / n, cy: sy / n, sxx, syy, sxy, start: s });
  }
  return { labels, comps: comps.filter((c) => c.area >= minArea).sort((a, b) => b.area - a.area) };
}

/** Moment-based ellipse. Result is normalized: radius=[a/W, b/H], rotation in degrees (pixel space). */
export function ellipseFromComp(c, w, h) {
  const n = c.area, mx = c.cx, my = c.cy;
  const vxx = c.sxx / n - mx * mx + 1 / 12, vyy = c.syy / n - my * my + 1 / 12, vxy = c.sxy / n - mx * my;
  const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const rot = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
  return {
    center: [(mx + 0.5) / w, (my + 0.5) / h],
    radius: [(2 * Math.sqrt(l1)) / w, (2 * Math.sqrt(l2)) / h],
    rotation: (rot * 180) / Math.PI,
    area: n / (w * h),
  };
}

export function traceContour(isSet, w, h, sx, sy) {
  const dx = [1, 1, 0, -1, -1, -1, 0, 1], dy = [0, 1, 1, 1, 0, -1, -1, -1];
  const dirIndex = (bx, by) => { for (let i = 0; i < 8; i++) if (dx[i] === bx && dy[i] === by) return i; return 4; };
  const pts = [[sx, sy]]; let x = sx, y = sy, b = 4;
  const limit = w * h * 4;
  for (let it = 0; it < limit; it++) {
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const d = (b + k) % 8, nx = x + dx[d], ny = y + dy[d];
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && isSet(nx, ny)) {
        const pd = (d + 7) % 8;
        b = dirIndex(x + dx[pd] - nx, y + dy[pd] - ny);
        x = nx; y = ny; found = true; break;
      }
    }
    if (!found) break;
    if (x === sx && y === sy) break;
    pts.push([x, y]);
  }
  return pts;
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function dp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = perpDist(pts[i], pts[a], pts[b]); if (d > md) { md = d; mi = i; } }
    if (md > eps && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** Simplify a closed contour (array of [x,y]) to <= maxPts points. */
export function simplifyClosed(pts, eps, maxPts = 64) {
  if (pts.length < 8) return pts;
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
  let e = eps, out;
  for (let tries = 0; tries < 12; tries++) {
    const a = dp(pts.slice(0, far + 1), e), b = dp(pts.slice(far).concat([pts[0]]), e);
    out = a.slice(0, -1).concat(b.slice(0, -1));
    if (out.length <= maxPts) break;
    e *= 1.4;
  }
  return out;
}


/**
 * Construction blobs: repeatedly take the largest inscribed circle of the (hole-filled) mask.
 * Unlike a single moment-fitted ellipse this splits a head from a body — what a teacher would sketch first.
 */
export function constructionBlobs(mask, w, h, maxN = 4, minRFrac = 0.03) {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  const dt = distanceTransform(inv, w, h), covered = new Uint8Array(w * h), blobs = [];
  const minR = Math.max(3, Math.min(w, h) * minRFrac);
  for (let n = 0; n < maxN; n++) {
    let best = -1, bi = -1;
    for (let i = 0; i < dt.length; i++) if (mask[i] && !covered[i] && dt[i] > best) { best = dt[i]; bi = i; }
    if (bi < 0 || best < minR) break;
    const cx = bi % w, cy = (bi / w) | 0, r = best * 1.05, cr = best * 1.25;
    blobs.push({ center: [(cx + 0.5) / w, (cy + 0.5) / h], radius: [r / w, r / h], rotation: 0, area: (Math.PI * r * r) / (w * h) });
    for (let y = Math.max(0, Math.floor(cy - cr)); y <= Math.min(h - 1, Math.ceil(cy + cr)); y++)
      for (let x = Math.max(0, Math.floor(cx - cr)); x <= Math.min(w - 1, Math.ceil(cx + cr)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= cr * cr) covered[y * w + x] = 1;
  }
  return blobs;
}

/**
 * fitForms — decompose the subject into the simple solids a teacher blocks in first:
 *   sphere   = a fat, roundish mass (head, belly, hill)           → {shape:'sphere', center, radius:[rx,ry], rotation}
 *   box      = a fat, blocky mass (torso, jaw, building)           → {shape:'box', box:[x0,y0,x1,y1], rotation, depth:[dx,dy]}
 *   cylinder = a long thin mass (limb, neck, tail, trunk)          → {shape:'cylinder', from, to, radius}
 * All numbers normalised (radius of a cylinder = fraction of image width). Also returns the "line of action" (principal axis).
 * Method: the thick cores of the mask (distance transform ≥ half the biggest inscribed circle) are the fat masses; what is left
 * after removing them, minus slivers, are the limbs. Each part is classified from its own moments / oriented extents.
 */
export function fitForms(mask, w, h, maxN = 8) {
  const n = w * h; let area = 0; for (let i = 0; i < n; i++) area += mask[i] ? 1 : 0;
  if (area < n * 0.01) return { forms: [], axis: null };
  const inv = new Uint8Array(n); for (let i = 0; i < n; i++) inv[i] = mask[i] ? 0 : 1;
  const dt = distanceTransform(inv, w, h); let R0 = 0; for (let i = 0; i < n; i++) if (mask[i] && dt[i] > R0) R0 = dt[i];
  if (R0 < 2) return { forms: [], axis: null };
  const minComp = Math.max(8, Math.round(area * 0.012));
  const classify = (partMask) => {
    const L = labelComponents(partMask, w, h, minComp); if (!L.comps.length) return null;
    const c = L.comps[0], e = ellipseFromComp(c, w, h), rot = (e.rotation * Math.PI) / 180, cs = Math.cos(rot), sn = Math.sin(rot);
    const a = Math.max(1, e.radius[0] * w), b = Math.max(1, e.radius[1] * h);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9, cnt = 0;
    for (let y = c.bbox[1]; y <= c.bbox[3]; y++) for (let x = c.bbox[0]; x <= c.bbox[2]; x++) {
      if (L.labels[y * w + x] !== c.id) continue; cnt++;
      const dx = x + 0.5 - (c.cx + 0.5), dy = y + 0.5 - (c.cy + 0.5), u = dx * cs + dy * sn, v = -dx * sn + dy * cs;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const Lu = u1 - u0 + 1, Lv = v1 - v0 + 1, rect = cnt / (Lu * Lv), elong = a / b, cx = c.cx + 0.5, cy = c.cy + 0.5;
    const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2, ccx = cx + mu * cs - mv * sn, ccy = cy + mu * sn + mv * cs; // centre of the oriented extents
    const rotDeg = e.rotation, N = (x, y) => [+(x / w).toFixed(4), +(y / h).toFixed(4)];
    if (elong >= 1.9) { // long and thin → cylinder along the major axis
      const hx = (Lu / 2) * cs, hy = (Lu / 2) * sn;
      return { shape: 'cylinder', from: N(ccx - hx, ccy - hy), to: N(ccx + hx, ccy + hy), radius: +(Lv / 2 / w).toFixed(4), area: cnt / n };
    }
    // box or ball? compare how well the part fills its oriented rectangle vs how well it fills the equal-moment ellipse
    let inE = 0; { const ra = Math.max(1, a), rb = Math.max(1, b);
      for (let y = c.bbox[1]; y <= c.bbox[3]; y++) for (let x = c.bbox[0]; x <= c.bbox[2]; x++) {
        if (L.labels[y * w + x] !== c.id) continue; const dx = x + 0.5 - (c.cx + 0.5), dy = y + 0.5 - (c.cy + 0.5), u = dx * cs + dy * sn, v = -dx * sn + dy * cs;
        if ((u / ra) ** 2 + (v / rb) ** 2 <= 1) inE++; } }
    const iouE = inE / (cnt + Math.PI * a * b - inE), blocky = rect >= 0.55 && rect >= iouE - 0.03; // a ball fills its ellipse (≈0.95+) far better than its rectangle (≤0.79); a torso or jaw does not
    if (blocky && elong < 1.9) { // fills its oriented rectangle better than any ellipse → box (front face + a little depth)
      const d = Math.min(Lu, Lv) * 0.28;
      let bu = Lu, bv = Lv, br = rotDeg; // keep the tilt within ±45° (a 90° turn of a box is the same box with its sides swapped)
      if (br > 45) { br -= 90; [bu, bv] = [bv, bu]; } else if (br < -45) { br += 90; [bu, bv] = [bv, bu]; }
      return { shape: 'box', box: [...N(ccx - bu / 2, ccy - bv / 2), ...N(ccx + bu / 2, ccy + bv / 2)], rotation: +br.toFixed(1), depth: [+(d / w).toFixed(4), +(-d / h).toFixed(4)], area: cnt / n };
    }
    const r = elong < 1.25 ? (a + b) / 2 : null; // roundish → circle, egg-shaped → ellipse
    return { shape: 'sphere', center: N(cx, cy), radius: r ? [+(r / w).toFixed(4), +(r / h).toFixed(4)] : [+(a / w).toFixed(4), +(b / h).toFixed(4)], rotation: r ? 0 : +rotDeg.toFixed(1), area: cnt / n };
  };
  const forms = [], taken = new Uint8Array(n);
  // 1. fat masses: thick cores, each grown back to its part of the silhouette
  const rho = R0 * 0.4, core = new Uint8Array(n); for (let i = 0; i < n; i++) core[i] = mask[i] && dt[i] >= rho ? 1 : 0;
  const coreLab = labelComponents(core, w, h, Math.max(4, Math.round(area * 0.004))), cores = coreLab.comps.slice(0, 3);
  for (const c of cores) {
    const one = new Uint8Array(n); for (let i = 0; i < n; i++) one[i] = coreLab.labels[i] === c.id ? 1 : 0;
    const dd = distanceTransform(one, w, h), part = new Uint8Array(n); // morphological opening by a disc: keeps what is at least as fat as the core, drops the thin limbs hanging off it
    for (let i = 0; i < n; i++) { part[i] = dd[i] <= rho + 0.5 && mask[i] && !taken[i] ? 1 : 0; }
    const f = classify(part); if (f) { forms.push(f); for (let i = 0; i < n; i++) if (part[i]) taken[i] = 1; }
  }
  // 2. what is left, once slivers are opened away, are the limbs / necks / tails
  const rest = new Uint8Array(n); for (let i = 0; i < n; i++) rest[i] = mask[i] && !taken[i] ? 1 : 0;
  const open = dilate(erode(rest, w, h, Math.max(1, Math.round(R0 * 0.12))), w, h, Math.max(1, Math.round(R0 * 0.12)));
  const L = labelComponents(open, w, h, minComp);
  for (const c of L.comps.slice(0, 4)) {
    const part = new Uint8Array(n); for (let i = 0; i < n; i++) part[i] = L.labels[i] === c.id ? 1 : 0;
    const f = classify(part); if (f) forms.push(f);
  }
  forms.sort((p, q) => q.area - p.area);
  // line of action: principal axis of the whole silhouette, spanning its extent
  const all = labelComponents(mask, w, h, 1), tot = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
  for (const c of all.comps) { tot.n += c.area; tot.sx += c.cx * c.area; tot.sy += c.cy * c.area; tot.sxx += c.sxx; tot.syy += c.syy; tot.sxy += c.sxy; }
  let axis = null;
  if (tot.n) {
    const comp = { area: tot.n, cx: tot.sx / tot.n, cy: tot.sy / tot.n, sxx: tot.sxx, syy: tot.syy, sxy: tot.sxy }, e = ellipseFromComp(comp, w, h), r = (e.rotation * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
    let t0 = 1e9, t1 = -1e9; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { const t = (x + 0.5 - comp.cx - 0.5) * cs + (y + 0.5 - comp.cy - 0.5) * sn; if (t < t0) t0 = t; if (t > t1) t1 = t; }
    const px = (t) => [+((comp.cx + 0.5 + t * cs) / w).toFixed(4), +((comp.cy + 0.5 + t * sn) / h).toFixed(4)];
    if (t1 - t0 > Math.min(w, h) * 0.15) axis = { from: px(t0), to: px(t1) };
  }
  return { forms: forms.slice(0, maxN).map(({ area: _a, ...f }) => f), axis };
}

/* ---------- value maps & edges ---------- */
export function valueLevels(gray, w, h, levels = 3, blurR = 2) {
  const g = boxBlur(gray, w, h, blurR);
  const sorted = Float32Array.from(g).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.floor(sorted.length * 0.98)];
  const span = Math.max(1, hi - lo);
  const thresholds = [];
  for (let i = 1; i < levels; i++) thresholds.push(lo + (span * i) / levels);
  const map = new Uint8Array(w * h), counts = new Array(levels).fill(0);
  for (let i = 0; i < g.length; i++) {
    let l = 0; while (l < thresholds.length && g[i] > thresholds[l]) l++;
    map[i] = l; counts[l]++;
  }
  return { map, thresholds, fractions: counts.map((c) => c / g.length), blurred: g };
}

export function sobel(gray, w, h) {
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
    const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
    mag[i] = Math.hypot(gx, gy);
  }
  return mag;
}
export function edgeMask(mag, topFraction = 0.12, minMag = 40) {
  const sorted = Float32Array.from(mag).sort();
  const t = Math.max(minMag, sorted[Math.floor(sorted.length * (1 - topFraction))]);
  const m = new Uint8Array(mag.length);
  for (let i = 0; i < mag.length; i++) m[i] = mag[i] >= t ? 1 : 0;
  return m;
}

/* ---------- palette ---------- */
export function kmeansPalette(rgba, w, h, k = 6, seed = 7) {
  const n = w * h, step = Math.max(1, Math.floor(n / 5000)), pts = [];
  for (let i = 0; i < n; i += step) { const j = i * 4; if (rgba[j + 3] < 10) continue; pts.push(rgbToLab(rgba[j], rgba[j + 1], rgba[j + 2])); }
  if (!pts.length) return [];
  k = Math.min(k, pts.length);
  const rnd = mulberry32(seed);
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const cent = [pts[Math.floor(rnd() * pts.length)].slice()];
  while (cent.length < k) {
    const ds = pts.map((p) => Math.min(...cent.map((c) => d2(p, c))));
    const total = ds.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let r = rnd() * total, idx = 0;
    for (; idx < ds.length - 1; idx++) { r -= ds[idx]; if (r <= 0) break; }
    cent.push(pts[idx].slice());
  }
  const assign = new Int32Array(pts.length);
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < pts.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < cent.length; c++) { const d = d2(pts[i], cent[c]); if (d < bd) { bd = d; bi = c; } }
      assign[i] = bi;
    }
    const sums = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) { const s = sums[assign[i]]; s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++; }
    sums.forEach((s, c) => { if (s[3]) cent[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const counts = new Array(cent.length).fill(0);
  for (let i = 0; i < pts.length; i++) counts[assign[i]]++;
  let list = cent.map((c, i) => ({ lab: c, count: counts[i] })).filter((c) => c.count > 0);
  // merge near-duplicates
  const merged = [];
  for (const c of list.sort((a, b) => b.count - a.count)) {
    const m = merged.find((x) => deltaE(x.lab, c.lab) < 7);
    if (m) { m.lab = m.lab.map((v, i) => (v * m.count + c.lab[i] * c.count) / (m.count + c.count)); m.count += c.count; } else merged.push({ ...c });
  }
  const total = merged.reduce((a, c) => a + c.count, 0);
  const pal = merged.sort((a, b) => b.count - a.count).map((c) => {
    const [r, g, b] = labToRgb(c.lab[0], c.lab[1], c.lab[2]);
    return { hex: toHex(r, g, b), lab: c.lab, L: c.lab[0], chroma: Math.hypot(c.lab[1], c.lab[2]), fraction: c.count / total };
  });
  assignRoles(pal);
  return pal;
}
function assignRoles(pal) {
  if (!pal.length) return;
  const byL = [...pal].sort((a, b) => a.L - b.L);
  byL[0].role = 'shadow';
  if (pal.length > 1) byL[byL.length - 1].role = 'highlight';
  const rest = pal.filter((p) => !p.role);
  if (rest.length) {
    const acc = [...rest].sort((a, b) => b.chroma - a.chroma)[0];
    if (acc.chroma > 25) acc.role = 'accent';
  }
  const rest2 = pal.filter((p) => !p.role);
  if (rest2.length) rest2[0].role = 'base';
  for (const p of pal) if (!p.role) p.role = 'midtone';
}

/* ---------- full local analysis ---------- */
function borderMedianLab(labs, w, h) {
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.03)), L = [], A = [], B = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < ring || y < ring || x >= w - ring || y >= h - ring) { const i = y * w + x; L.push(labs[i * 3]); A.push(labs[i * 3 + 1]); B.push(labs[i * 3 + 2]); }
  }
  const med = (a) => { a.sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
  return [med(L), med(A), med(B)];
}

/**
 * analyzeLocal(rgba, w, h, opts) -> { summary (JSON-safe), maps (typed arrays) }
 * `summary` is what we send to the model as hints and what guides are resolved from.
 */
/**
 * valueRegions — the labelled dark/light blobs of the three-value map. These are the "snap targets"
 * the AI tutor can refer to by id (D1, L2…), so guides land on real pixels instead of guessed coordinates.
 */
export function valueRegions(levelMap, gray, w, h, eps) {
  const n = w * h, out = [];
  for (const [level, tone, prefix, limit] of [[0, 'dark', 'D', 9], [2, 'light', 'L', 7]]) {
    const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = levelMap[i] === level ? 1 : 0;
    const cm = closeMask(m, w, h, Math.max(1, Math.round(w * 0.005)));
    const L = labelComponents(cm, w, h, Math.max(8, Math.round(n * 0.0035)));
    L.comps.slice(0, limit).forEach((c, i) => {
      let sum = 0, cnt = 0; for (let y = c.bbox[1]; y <= c.bbox[3]; y++) for (let x = c.bbox[0]; x <= c.bbox[2]; x++) if (L.labels[y * w + x] === c.id) { sum += gray[y * w + x]; cnt++; }
      const e = ellipseFromComp(c, w, h);
      const contour = simplifyClosed(traceContour((x, y) => L.labels[y * w + x] === c.id, w, h, c.start % w, (c.start / w) | 0), eps, 40).map(([x, y]) => [+((x + 0.5) / w).toFixed(3), +((y + 0.5) / h).toFixed(3)]);
      out.push({ id: `${prefix}${i + 1}`, tone, area: +(c.area / n).toFixed(4), meanGray: cnt ? Math.round(sum / cnt) : 0,
        bbox: [c.bbox[0] / w, c.bbox[1] / h, (c.bbox[2] + 1) / w, (c.bbox[3] + 1) / h].map((v) => +v.toFixed(3)),
        centroid: [+((c.cx + 0.5) / w).toFixed(3), +((c.cy + 0.5) / h).toFixed(3)], ellipse: { center: e.center, radius: e.radius, rotation: e.rotation }, contour });
    });
  }
  return out;
}


/**
 * edgeSubject — figure/ground for pictures whose background is NOT a flat colour (smoky charcoal, vignettes, busy paper):
 * the subject is where the detail (edges) is. Returns {mask, frac} or null.
 */
export function edgeSubject(gray, w, h) {
  const n = w * h, mag = sobel(boxBlur(gray, w, h, 1), w, h), em = edgeMask(mag, 0.14, 30);
  const energy = boxBlur(Float32Array.from(em, (v) => v * 255), w, h, Math.max(2, Math.round(w * 0.03)));
  const t = otsu(Uint8Array.from(energy, (v) => Math.min(255, v * 3)), 255) / 3;
  let m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = energy[i] > t ? 1 : 0;
  m = fillHoles(closeMask(m, w, h, Math.max(3, Math.round(w * 0.07))), w, h); // wide closing: a form's shaded, low-detail side belongs to the form
  const L = labelComponents(m, w, h, Math.round(n * 0.01)); if (!L.comps.length) return null;
  const big = L.comps[0], out = new Uint8Array(n); let c = 0;
  for (let i = 0; i < n; i++) if (L.labels[i] === big.id) { out[i] = 1; c++; }
  return { mask: out, frac: c / n, bbox: big.bbox };
}
const bordersTouched = (m, w, h) => {
  const x0 = Math.round(w * 0.1), x1 = Math.round(w * 0.9), y0 = Math.round(h * 0.1), y1 = Math.round(h * 0.9); let t = 0, a = 0, b = 0, c = 0, d = 0;
  for (let x = x0; x < x1; x++) { a |= m[x]; b |= m[(h - 1) * w + x]; }
  for (let y = y0; y < y1; y++) { c |= m[y * w]; d |= m[y * w + w - 1]; }
  return a + b + c + d + t;
};

/**
 * hollowRegions — dark, compact openings ENCLOSED by the subject (eye sockets, a nose opening, a doorway, a mouth interior).
 * They are what a beginner should mark as "hollows" before shading. Ids H1…Hn.
 */
export function hollowRegions(gray, subject, w, h, eps, limit = 4) {
  const n = w * h; let cnt = 0; const vals = []; for (let i = 0; i < n; i++) if (subject[i]) { cnt++; vals.push(gray[i]); }
  if (cnt < n * 0.03) return [];
  const t = otsu(Uint8Array.from(vals, (v) => Math.round(v)), 255), g2 = boxBlur(gray, w, h, 1);
  const sorted = Float32Array.from(vals).sort(), med = sorted[sorted.length >> 1]; let ds = 0, dn = 0; for (const v of vals) if (v <= t) { ds += v; dn++; }
  const thr = dn ? (ds / dn + med) / 2 : t * 0.78; // halfway between the darkest class and the typical tone of the subject
  let d = new Uint8Array(n); for (let i = 0; i < n; i++) d[i] = subject[i] && g2[i] < thr ? 1 : 0;
  d = closeMask(d, w, h, Math.max(1, Math.round(w * 0.006)));
  d = dilate(erode(d, w, h, Math.max(2, Math.round(w * 0.016))), w, h, Math.max(2, Math.round(w * 0.016))); // opening: cut thin necks that join an opening to a big shadow
  const L = labelComponents(d, w, h, Math.max(10, Math.round(cnt * 0.004))), out = [];
  for (const c of L.comps.slice(0, 14)) {
    const share = c.area / cnt; if (share > 0.12) continue;
    const cm = new Uint8Array(n); let sum = 0; for (let y = c.bbox[1]; y <= c.bbox[3]; y++) for (let x = c.bbox[0]; x <= c.bbox[2]; x++) if (L.labels[y * w + x] === c.id) { cm[y * w + x] = 1; sum += gray[y * w + x]; }
    const ring = dilate(cm, w, h, Math.max(2, Math.round(w * 0.02))); let rn = 0, rin = 0;
    for (let i = 0; i < n; i++) if (ring[i] && !cm[i]) { rn++; if (subject[i]) rin++; }
    if (!rn || rin / rn < 0.6) continue; // not enclosed by the subject: it is a cast shadow or background, not a hollow
    const e = ellipseFromComp(c, w, h), ea = Math.PI * e.radius[0] * e.radius[1] * n; if (c.area / ea < 0.42) continue; // ragged, not a clean opening
    const mean = sum / c.area;
    const contour = simplifyClosed(traceContour((x, y) => L.labels[y * w + x] === c.id, w, h, c.start % w, (c.start / w) | 0), eps, 28).map(([x, y]) => [+((x + 0.5) / w).toFixed(3), +((y + 0.5) / h).toFixed(3)]);
    out.push({ score: c.area * (255 - mean), tone: 'dark', kind: 'hollow', area: +(c.area / n).toFixed(4), meanGray: Math.round(mean),
      bbox: [c.bbox[0] / w, c.bbox[1] / h, (c.bbox[2] + 1) / w, (c.bbox[3] + 1) / h].map((v) => +v.toFixed(3)),
      centroid: [+((c.cx + 0.5) / w).toFixed(3), +((c.cy + 0.5) / h).toFixed(3)], ellipse: { center: e.center, radius: e.radius, rotation: e.rotation }, contour });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...r }, i) => ({ id: `H${i + 1}`, ...r }));
}

export function analyzeLocal(rgba, w, h, opts = {}) {
  const n = w * h;
  const gray = rgbaToGray(rgba, n);
  const palette = kmeansPalette(rgba, w, h, opts.paletteSize || 6);
  const labs = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const l = rgbToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]); labs[i * 3] = l[0]; labs[i * 3 + 1] = l[1]; labs[i * 3 + 2] = l[2]; }

  // stats
  let near = 0, rg = [], yb = [];
  for (let i = 0; i < n; i += 3) {
    if (gray[i] < 45 || gray[i] > 210) near++;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    rg.push(r - g); yb.push(0.5 * (r + g) - b);
  }
  const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const colorfulness = Math.hypot(sd(rg), sd(yb)) + 0.3 * Math.hypot(mean(rg), mean(yb));
  const meanL = mean(Array.from(gray.filter((_, i) => i % 5 === 0)));
  const contrast = sd(Array.from(gray.filter((_, i) => i % 5 === 0)));
  const bimodal = near / Math.ceil(n / 3);

  const mag = sobel(boxBlur(gray, w, h, 1), w, h);
  const edges = edgeMask(mag, 0.1, 35);
  let edgeCount = 0; for (let i = 0; i < n; i++) edgeCount += edges[i];

  // subject mask: distance from the border colour (works for line art, illustrations, many photos)
  const bg = borderMedianLab(labs, w, h);
  const dist = new Float32Array(n); let maxD = 1;
  for (let i = 0; i < n; i++) { const d = Math.hypot(labs[i * 3] - bg[0], labs[i * 3 + 1] - bg[1], labs[i * 3 + 2] - bg[2]); dist[i] = d; if (d > maxD) maxD = d; }
  const thr = otsu(dist, maxD);
  let mask = new Uint8Array(n), cnt = 0;
  for (let i = 0; i < n; i++) { mask[i] = dist[i] > Math.max(thr, 12) ? 1 : 0; cnt += mask[i]; }
  if (cnt / n < 0.008) { // fall back to luminance minority
    const t = otsu(gray); let dark = 0; for (let i = 0; i < n; i++) dark += gray[i] <= t ? 1 : 0;
    const darkIsFg = dark < n / 2; cnt = 0;
    for (let i = 0; i < n; i++) { mask[i] = (darkIsFg ? gray[i] <= t : gray[i] > t) ? 1 : 0; cnt += mask[i]; }
  }
  const lineArtGuess = bimodal > 0.88 && colorfulness < 30;
  const closeR = Math.max(1, Math.round(Math.max(w, h) * (lineArtGuess ? 0.035 : 0.012)));
  let filled = fillHoles(closeMask(mask, w, h, closeR), w, h);
  let subjectMethod = 'color';
  { // a flat-colour background lets the border-colour test find the subject; smoky / textured backgrounds do not — then use detail (edges)
    let fa = 0; for (let i = 0; i < n; i++) fa += filled[i];
    const sourceMin0 = Math.min(opts.sourceW || 9999, opts.sourceH || 9999);
    if (!lineArtGuess && sourceMin0 > 128 && (fa / n > 0.38 || bordersTouched(filled, w, h) >= 3)) {
      const es = edgeSubject(gray, w, h);
      if (es && es.frac > 0.05 && es.frac < 0.7 && es.frac < fa / n) { filled = es.mask; subjectMethod = 'edges'; }
    }
  }

  const { labels, comps } = labelComponents(filled, w, h, Math.max(12, Math.round(n * 0.006)));
  const top = comps.slice(0, 5);
  const componentEllipses = top.map((c) => ellipseFromComp(c, w, h));
  let ellipses = constructionBlobs(filled, w, h, 4);
  if (!ellipses.length) ellipses = componentEllipses;
  const eps = Math.max(w, h) * 0.012;
  const contours = top.map((c) => {
    const raw = traceContour((x, y) => labels[y * w + x] === c.id, w, h, c.start % w, (c.start / w) | 0);
    return simplifyClosed(raw, eps, 56).map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]);
  });
  // precise trace: a much finer outline for every substantial piece of the subject (the standard `contours` stay coarse for teaching)
  const epsFine = Math.max(0.7, Math.max(w, h) * 0.0022), topArea = top.reduce((q, c) => q + c.area, 0) || 1;
  const contoursFine = top.filter((c, i) => i === 0 || c.area / topArea >= 0.03).slice(0, 3).map((c) => {
    const raw = traceContour((x, y) => labels[y * w + x] === c.id, w, h, c.start % w, (c.start / w) | 0);
    return simplifyClosed(raw, epsFine, 300).map(([x, y]) => [+((x + 0.5) / w).toFixed(4), +((y + 0.5) / h).toFixed(4)]);
  });
  // build-up solids (spheres / boxes / cylinders) fitted to the subject
  const subjMask = new Uint8Array(n); { const ids = new Set(top.map((c) => c.id)); for (let i = 0; i < n; i++) subjMask[i] = ids.has(labels[i]) ? 1 : 0; }
  // a trustworthy (colour-separated) silhouette can be decomposed into solids; an approximate one (smoky photo) cannot
  let built;
  if (subjectMethod === 'edges') built = { forms: [], axis: null, approx: true }; // the silhouette is only approximate here: placing solids on it would teach the wrong shapes, so leave that to the AI tutor
  else built = fitForms(subjMask, w, h, 8);
  let bb = [1, 1, 0, 0];
  for (const c of top) { bb = [Math.min(bb[0], c.bbox[0] / w), Math.min(bb[1], c.bbox[1] / h), Math.max(bb[2], (c.bbox[2] + 1) / w), Math.max(bb[3], (c.bbox[3] + 1) / h)]; }
  if (!top.length) bb = [0.1, 0.1, 0.9, 0.9];
  let subjectArea = 0, scx = 0, scy = 0;
  for (const c of top) { subjectArea += c.area; scx += c.cx * c.area; scy += c.cy * c.area; }
  const centroid = top.length ? [(scx / subjectArea + 0.5) / w, (scy / subjectArea + 0.5) / h] : [0.5, 0.5];

  // value masses
  const v3 = valueLevels(gray, w, h, 3, Math.max(1, Math.round(w * 0.012)));
  const v5 = valueLevels(gray, w, h, 5, Math.max(1, Math.round(w * 0.008)));
  const massGuides = (level) => {
    const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = v3.map[i] === level ? 1 : 0;
    const cm = closeMask(m, w, h, Math.max(1, Math.round(w * 0.01)));
    const L = labelComponents(cm, w, h, Math.round(n * 0.01));
    return {
      contours: L.comps.slice(0, 4).map((c) => simplifyClosed(
        traceContour((x, y) => L.labels[y * w + x] === c.id, w, h, c.start % w, (c.start / w) | 0), eps * 1.3, 40
      ).map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h])),
      ellipses: L.comps.slice(0, 4).map((c) => ellipseFromComp(c, w, h)),
    };
  };
  const shadow = massGuides(0), light = massGuides(2);
  const hollows = hollowRegions(gray, filled, w, h, eps);
  const regions = [...valueRegions(v3.map, gray, w, h, eps), ...hollows];

  // focal point: edge-weighted centroid
  let fx = 0, fy = 0, fw = 0;
  const mx = Math.round(w * 0.04), my = Math.round(h * 0.04);
  for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) { const m = mag[y * w + x]; fx += x * m; fy += y * m; fw += m; }
  const focal = fw > 0 ? [(fx / fw + 0.5) / w, (fy / fw + 0.5) / h] : centroid;

  const edgeDensity = edgeCount / n;
  const sourceMin = Math.min(opts.sourceW || 9999, opts.sourceH || 9999);
  let guessedType = 'general';
  if (sourceMin <= 128) guessedType = 'pixel_art';
  else if (lineArtGuess) guessedType = 'line_art';
  else if (colorfulness > 35 && edgeDensity < 0.1) guessedType = 'painterly';

  const summary = {
    width: w, height: h,
    palette: palette.map((p) => ({ hex: p.hex, role: p.role, fraction: +p.fraction.toFixed(3) })),
    stats: { meanL: +meanL.toFixed(1), contrast: +contrast.toFixed(1), bimodal: +bimodal.toFixed(2), colorfulness: +colorfulness.toFixed(1), edgeDensity: +edgeDensity.toFixed(3), subjectFraction: +(subjectArea / n).toFixed(3), guessedType },
    subject: { method: subjectMethod, bbox: bb.map((v) => +v.toFixed(3)), centroid: centroid.map((v) => +v.toFixed(3)), focal: focal.map((v) => +v.toFixed(3)), ellipses, componentEllipses, contours, contoursFine, forms: built.forms, axis: built.axis, formsApprox: !!built.approx },
    masses: { shadow, light, valueFractions3: v3.fractions.map((v) => +v.toFixed(3)) },
    regions,
  };
  if (!opts.skipLineArt) { try { const la = extractLineArt(gray, w, h); summary.lineart = { strokes: la.strokes, main: la.main, mode: la.mode, count: la.count }; } catch { summary.lineart = null; } }
  return { summary, maps: { w, h, rgba, gray, mask: filled, levels3: v3.map, levels5: v5.map, edges, labels, palette } };
}
