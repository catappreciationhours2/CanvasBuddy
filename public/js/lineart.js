// lineart.js — "pull the colour out and keep only the lines": the strokes you would draw if you laid tracing paper over the picture.
// Pure JS (no DOM), runs in the browser and in Node tests. Pipeline:
//   1. paper normalisation   – a grayscale closing estimates the paper/background; dark marks = closing − gray (removes shading, vignettes, paper grain)
//      (photos and paintings, which are not dark-marks-on-paper, use gradient-ridge edges instead: blur → Sobel → non-max suppression)
//   2. hysteresis threshold  – strong marks seed, weaker connected marks extend them; dust is dropped
//   3. thinning              – Zhang–Suen skeleton, so a fat pencil stroke becomes one centre line
//   4. stroke tracing        – walk the skeleton between endpoints / junctions into polylines
//   5. simplify + rank       – Douglas–Peucker, drop tiny strokes, rank by length × darkness, split into "main" and "fine" lines
// Output coordinates are normalised 0..1.

const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** separable grayscale min / max filter with a (2r+1) square window (van Herk would be faster; this is fine at ≤ 800 px). */
function rank1d(src, w, h, r, isMax) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = isMax ? -1e9 : 1e9; const a = Math.max(0, x - r), b = Math.min(w - 1, x + r), row = y * w;
    for (let k = a; k <= b; k++) { const t = src[row + k]; if (isMax ? t > v : t < v) v = t; }
    tmp[row + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = isMax ? -1e9 : 1e9; const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
    for (let k = a; k <= b; k++) { const t = tmp[k * w + x]; if (isMax ? t > v : t < v) v = t; }
    out[y * w + x] = v;
  }
  return out;
}
function blur(src, w, h, r) {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), d = 2 * r + 1;
  for (let y = 0; y < h; y++) { let s = 0; for (let x = -r; x <= r; x++) s += src[y * w + clampi(x, 0, w - 1)]; for (let x = 0; x < w; x++) { tmp[y * w + x] = s / d; s += src[y * w + clampi(x + r + 1, 0, w - 1)] - src[y * w + clampi(x - r, 0, w - 1)]; } }
  for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[clampi(y, 0, h - 1) * w + x]; for (let y = 0; y < h; y++) { out[y * w + x] = s / d; s += tmp[clampi(y + r + 1, 0, h - 1) * w + x] - tmp[clampi(y - r, 0, h - 1) * w + x]; } }
  return out;
}
const percentile = (arr, p) => { const a = Float32Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

/** hysteresis: keep `weak` pixels (≥ lo) that are 8-connected to a `strong` pixel (≥ hi). */
function hysteresis(val, w, h, lo, hi) {
  const keep = new Uint8Array(w * h), stack = [];
  for (let i = 0; i < val.length; i++) if (val[i] >= hi) { keep[i] = 1; stack.push(i); }
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue; const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx; if (!keep[q] && val[q] >= lo) { keep[q] = 1; stack.push(q); }
    }
  }
  return keep;
}

/** Zhang–Suen thinning. Input/Output: Uint8Array 0/1 (modified in place and returned). */
export function thin(m, w, h) {
  const rm = [];
  let changed = true, guard = 0;
  while (changed && guard++ < 60) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      rm.length = 0;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x; if (!m[i]) continue;
        const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1], p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9; if (B < 2 || B > 6) continue;
        const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2); if (A !== 1) continue;
        if (pass === 0 ? (p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0) : (p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0)) rm.push(i);
      }
      if (rm.length) { changed = true; for (const i of rm) m[i] = 0; }
    }
  }
  return m;
}

/**
 * Walk a 1-px skeleton into polylines (pixel coordinates). Strokes run straight THROUGH junctions (like a pen would), so a pencil line
 * crossing another stays one long stroke; each pixel is used once, and a stroke that runs into an earlier one is joined to it.
 */
export function traceSkeleton(sk, w, h) {
  const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const nb = (i) => { const x = i % w, y = (i / w) | 0, out = []; for (const [dx, dy] of N8) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h && sk[ny * w + nx]) out.push(ny * w + nx); } return out; };
  const deg = new Uint8Array(w * h), seen = new Uint8Array(w * h), strokes = [];
  for (let i = 0; i < sk.length; i++) if (sk[i]) deg[i] = nb(i).length;
  const walk = (start) => {
    const path = [start]; seen[start] = 1;
    for (let guard = 0; guard < w * h; guard++) {
      const cur = path[path.length - 1], cx = cur % w, cy = (cur / w) | 0, cand = nb(cur).filter((q) => !seen[q]);
      if (!cand.length) { // run into an already-drawn stroke? join to it so the lines connect
        const joined = nb(cur).find((q) => seen[q] && q !== path[path.length - 2] && !path.slice(-4).includes(q)); if (joined !== undefined && path.length > 2) path.push(joined);
        break;
      }
      let best = cand[0];
      if (cand.length > 1) { // keep going in the same direction (compare with where we were ~4 px ago)
        const ref = path[Math.max(0, path.length - 5)], dx = cx - (ref % w), dy = cy - ((ref / w) | 0), dl = Math.hypot(dx, dy) || 1; let bs = -9;
        for (const q of cand) { const qx = (q % w) - cx, qy = ((q / w) | 0) - cy, s = (dx * qx + dy * qy) / (dl * Math.hypot(qx, qy)) - (qx && qy ? 0.02 : 0); if (s > bs) { bs = s; best = q; } }
      }
      seen[best] = 1; path.push(best);
    }
    return path;
  };
  const order = []; for (let i = 0; i < sk.length; i++) if (sk[i] && deg[i] === 1) order.push(i);
  for (const i of order) if (!seen[i]) strokes.push(walk(i));
  for (let i = 0; i < sk.length; i++) if (sk[i] && !seen[i]) strokes.push(walk(i)); // loops and anything left over
  return strokes.map((p) => p.map((i) => [i % w, (i / w) | 0]));
}

function dp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let md = 0, mi = -1; const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay, l2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const t = l2 ? clampi(((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2, 0, 1) : 0, d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy));
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const plen = (p) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return s; };

/**
 * extractLineArt(gray, w, h, opts) → { strokes: [[ [x,y]… ]…] (normalised), main: n, mode, count, points }
 * strokes are sorted most-important first; the first `main` of them are the "main lines", the rest the "fine lines".
 * opts.mode: 'auto' | 'marks' (dark marks on light paper) | 'edges' (photos / paintings).
 */
export function extractLineArt(gray, w, h, opts = {}) {
  const n = w * h, diag = Math.hypot(w, h);
  const g = blur(gray, w, h, Math.max(0, Math.round(Math.max(w, h) * 0.0012)));
  // dark marks on a lighter ground: closing (dilate then erode) fills thin dark lines, so closing − gray isolates them and ignores shading / vignettes
  const rM = Math.max(2, Math.round(Math.max(w, h) * 0.011)), closed = rank1d(rank1d(g, w, h, rM, true), w, h, rM, false), marks = new Float32Array(n);
  let busy = 0; for (let i = 0; i < n; i++) { marks[i] = Math.max(0, closed[i] - g[i]); if (marks[i] > 18) busy++; }
  busy /= n; // a pencil sketch / ink drawing has thin marks over a quiet ground (few % of pixels); a photo or painting is "busy" everywhere
  // a drawing has a quiet paper tone with a few thin dark marks; a photo / painting has big dark masses (a large share of pixels far darker than the median)
  const med = percentile(gray, 0.5); let heavy = 0; for (let i = 0; i < n; i++) if (gray[i] < med - 40) heavy++; heavy /= n;
  const mode = opts.mode && opts.mode !== 'auto' ? opts.mode : (busy > 0.004 && busy < 0.3 && heavy < 0.2 ? 'marks' : 'edges');
  let strength = new Float32Array(n), lo, hi;
  if (mode === 'marks') {
    strength = marks;
    const p = percentile(strength, 0.985); hi = Math.max(14, p * 0.45); lo = Math.max(7, hi * 0.4);
  } else {
    const sr = Math.max(1, Math.round(Math.max(w, h) * 0.0045)), s = blur(blur(blur(gray, w, h, sr), w, h, sr), w, h, sr), mag = new Float32Array(n), dir = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, gx = s[i + 1] - s[i - 1] + 0.5 * (s[i - w + 1] + s[i + w + 1] - s[i - w - 1] - s[i + w - 1]), gy = s[i + w] - s[i - w] + 0.5 * (s[i + w + 1] + s[i + w - 1] - s[i - w + 1] - s[i - w - 1]);
      mag[i] = Math.hypot(gx, gy); const a = Math.atan2(gy, gx) * 57.2958, aa = ((a % 180) + 180) % 180; dir[i] = aa < 22.5 || aa >= 157.5 ? 0 : aa < 67.5 ? 1 : aa < 112.5 ? 2 : 3;
    }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { // non-maximum suppression across the edge direction
      const i = y * w + x, d = dir[i], m = mag[i], a = d === 0 ? mag[i - 1] : d === 1 ? mag[i - w - 1] : d === 2 ? mag[i - w] : mag[i - w + 1], b = d === 0 ? mag[i + 1] : d === 1 ? mag[i + w + 1] : d === 2 ? mag[i + w] : mag[i + w - 1];
      strength[i] = m >= a && m >= b ? m : 0;
    }
    const p = percentile(mag, 0.93); hi = Math.max(8, p * 0.9); lo = Math.max(4, hi * 0.4);
  }
  let mask = hysteresis(strength, w, h, lo, hi);
  if (mode === 'marks') { // remove dust: tiny connected specks
    const lab = new Int32Array(n).fill(-1), minArea = Math.max(6, Math.round(diag * 0.012)); const st = [];
    for (let s0 = 0; s0 < n; s0++) {
      if (!mask[s0] || lab[s0] !== -1) continue; const comp = [s0]; lab[s0] = s0; st.push(s0);
      while (st.length) { const p = st.pop(), x = p % w, y = (p / w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const q = ny * w + nx; if (mask[q] && lab[q] === -1) { lab[q] = s0; comp.push(q); st.push(q); } } }
      if (comp.length < minArea) for (const q of comp) mask[q] = 0;
    }
  }
  const premask = opts.debug ? Uint8Array.from(mask) : null;
  thin(mask, w, h);
  const eps = Math.max(0.8, diag * (mode === 'edges' ? 0.0022 : 0.0014)), minLen = Math.max(5, diag * 0.018);
  const raw = traceSkeleton(mask, w, h).map((p) => dp(p, eps)).filter((p) => p.length >= 2 && plen(p) >= minLen);
  // importance = length × mean strength along the stroke
  const scored = raw.map((p) => { let s = 0; for (const [x, y] of p) s += strength[y * w + x]; return { p, len: plen(p), score: plen(p) * (s / p.length + 1) }; }).sort((a, b) => b.score - a.score);
  const maxStrokes = opts.maxStrokes || 700, kept = scored.slice(0, maxStrokes);
  const totalLen = kept.reduce((s, k) => s + k.len, 0) || 1; let acc = 0, main = 0;
  for (const k of kept) { if (acc / totalLen >= 0.7 && main >= 3) break; acc += k.len; main++; }
  main = Math.min(main, kept.length);
  const strokes = kept.map((k) => k.p.map(([x, y]) => [+((x + 0.5) / w).toFixed(4), +((y + 0.5) / h).toFixed(4)]));
  return { strokes, main, mode, busy: +busy.toFixed(3), heavy: +heavy.toFixed(3), count: strokes.length, points: strokes.reduce((s, p) => s + p.length, 0), ...(opts.debug ? { debug: { strength, premask, skeleton: mask, lo, hi } } : {}) };
}
