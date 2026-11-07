// artist.js — "Perfect Artist": a deterministic executor + metrics for generated lessons.
// Pure JS (no DOM). The question it answers: if an ideal executor followed the lesson's
// *geometry* exactly, would the result resemble the target?  It deliberately does NOT claim
// that the lesson is pedagogically good — see report.caveats.

import { hasSketchStep, hasOutlineStep, hasConstructStep, hasLineArtStep, isFormGuide, NO_SKETCH_TYPES } from './lesson.js';

export const makeMask = (w, h) => new Uint8Array(w * h);

/* ---------- rasterisers (normalised coords in, pixel masks out) ---------- */
export function fillPolygon(mask, w, h, pts) {
  if (pts.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  minY = Math.max(0, Math.floor(minY)); maxY = Math.min(h - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) mask[y * w + x] = 1;
    }
  }
}
export function strokeLine(mask, w, h, x0, y0, x1, y1, thick = 2) {
  const len = Math.hypot(x1 - x0, y1 - y0), steps = Math.max(1, Math.ceil(len));
  const r = Math.max(0.5, thick / 2);
  for (let s = 0; s <= steps; s++) {
    const cx = x0 + ((x1 - x0) * s) / steps, cy = y0 + ((y1 - y0) * s) / steps;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * w + x] = 1;
  }
}
function ellipseRho(x, y, cx, cy, rx, ry, rot) {
  const c = Math.cos(rot), s = Math.sin(rot), dx = x - cx, dy = y - cy;
  const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
  return Math.sqrt(u * u + v * v);
}
export function fillEllipse(mask, w, h, cx, cy, rx, ry, rot = 0, thick = 0) {
  const R = Math.max(rx, ry) + thick;
  for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(h - 1, Math.ceil(cy + R)); y++)
    for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(w - 1, Math.ceil(cx + R)); x++) {
      const rho = ellipseRho(x + 0.5, y + 0.5, cx, cy, rx, ry, rot);
      if (thick > 0 ? Math.abs(rho - 1) * Math.min(rx, ry) <= thick / 2 : rho <= 1) mask[y * w + x] = 1;
    }
}

/**
 * Rasterise one guide primitive. mode 'fill' -> filled silhouette, 'outline' -> stroked path.
 * Primitive kinds: ellipse, polygon, polyline, line, rect, grid, cross.
 */
export function rasterizePrimitive(mask, w, h, g, mode = 'fill', thick = 2) {
  const P = (p) => [p[0] * w, p[1] * h];
  switch (g.kind) {
    case 'ellipse': {
      const [cx, cy] = P(g.center);
      fillEllipse(mask, w, h, cx, cy, Math.max(1, g.radius[0] * w), Math.max(1, g.radius[1] * h), ((g.rotation || 0) * Math.PI) / 180, mode === 'outline' ? thick : 0);
      break;
    }
    case 'polygon': {
      const pts = g.points.map(P);
      if (mode === 'fill') fillPolygon(mask, w, h, pts);
      else for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; strokeLine(mask, w, h, a[0], a[1], b[0], b[1], thick); }
      break;
    }
    case 'polyline':
    case 'line': {
      const pts = (g.points || [g.from, g.to]).map(P);
      for (let i = 0; i + 1 < pts.length; i++) strokeLine(mask, w, h, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], thick);
      break;
    }
    case 'rect': {
      const [x0, y0] = P([g.x, g.y]), [x1, y1] = P([g.x + g.w, g.y + g.h]);
      if (mode === 'fill') fillPolygon(mask, w, h, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
      else { strokeLine(mask, w, h, x0, y0, x1, y0, thick); strokeLine(mask, w, h, x1, y0, x1, y1, thick); strokeLine(mask, w, h, x1, y1, x0, y1, thick); strokeLine(mask, w, h, x0, y1, x0, y0, thick); }
      break;
    }
    case 'strokes': {
      for (const path of g.paths || []) for (let i = 0; i + 1 < path.length; i++) strokeLine(mask, w, h, path[i][0] * w, path[i][1] * h, path[i + 1][0] * w, path[i + 1][1] * h, thick);
      break;
    }
    case 'grid': {
      for (let i = 1; i < g.cols; i++) strokeLine(mask, w, h, (i / g.cols) * w, 0, (i / g.cols) * w, h, thick);
      for (let j = 1; j < g.rows; j++) strokeLine(mask, w, h, 0, (j / g.rows) * h, w, (j / g.rows) * h, thick);
      break;
    }
    case 'cross': {
      const [cx, cy] = P(g.center), s = (g.size || 0.04) * Math.max(w, h);
      strokeLine(mask, w, h, cx - s, cy, cx + s, cy, thick); strokeLine(mask, w, h, cx, cy - s, cx, cy + s, thick);
      break;
    }
    default: break;
  }
  return mask;
}

/* ---------- metrics ---------- */
export function iou(a, b) {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { const x = a[k] ? 1 : 0, y = b[k] ? 1 : 0; i += x & y; u += x | y; }
  return u === 0 ? 1 : i / u;
}
export function dice(a, b) {
  let i = 0, s = 0;
  for (let k = 0; k < a.length; k++) { const x = a[k] ? 1 : 0, y = b[k] ? 1 : 0; i += x & y; s += x + y; }
  return s === 0 ? 1 : (2 * i) / s;
}
/** Two-pass 3-4 chamfer distance transform: distance (px) from every pixel to nearest set pixel. */
export function distanceTransform(mask, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 3);
    if (y > 0) { v = Math.min(v, d[i - w] + 3); if (x > 0) v = Math.min(v, d[i - w - 1] + 4); if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4); }
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
    if (y < h - 1) { v = Math.min(v, d[i + w] + 3); if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4); if (x > 0) v = Math.min(v, d[i + w - 1] + 4); }
    d[i] = v;
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}
export function edgePixels(mask, w, h) {
  const e = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) e[i] = 1;
  }
  return e;
}
/** Symmetric mean contour distance (px) between the boundaries of two filled masks. */
export function chamfer(a, b, w, h) {
  const ea = edgePixels(a, w, h), eb = edgePixels(b, w, h);
  const da = distanceTransform(ea, w, h), db = distanceTransform(eb, w, h);
  let sa = 0, na = 0, sb = 0, nb = 0;
  for (let i = 0; i < ea.length; i++) { if (ea[i]) { sb += db[i]; nb++; } if (eb[i]) { sa += da[i]; na++; } }
  if (!na || !nb) return Infinity;
  return (sa / na + sb / nb) / 2;
}
/** Block SSIM on grayscale (0..255) arrays. */
export function ssim(A, B, w, h, win = 8) {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2; let total = 0, n = 0;
  for (let y = 0; y + win <= h; y += win) for (let x = 0; x + win <= w; x += win) {
    let ma = 0, mb = 0; const N = win * win;
    for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) { ma += A[(y + j) * w + x + i]; mb += B[(y + j) * w + x + i]; }
    ma /= N; mb /= N; let va = 0, vb = 0, cv = 0;
    for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) { const da = A[(y + j) * w + x + i] - ma, db = B[(y + j) * w + x + i] - mb; va += da * da; vb += db * db; cv += da * db; }
    va /= N - 1; vb /= N - 1; cv /= N - 1;
    total += ((2 * ma * mb + C1) * (2 * cv + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); n++;
  }
  return n ? total / n : 1;
}

/**
 * How well did a user's drawing follow an outline guide?
 * coverage: share of guide-outline pixels with a user mark within `tol` px.
 * stray: share of user-mark pixels farther than `farTol` px from any guide (informational only —
 *        deviating from a guide is often intentional, so this never counts as an error).
 */
export function coverageReport(guideOutline, drawMask, w, h, tol = 4, farTol = 14) {
  const dDraw = distanceTransform(drawMask, w, h), dGuide = distanceTransform(guideOutline, w, h);
  let g = 0, hit = 0, m = 0, far = 0;
  const q = { hit: [0, 0, 0, 0], tot: [0, 0, 0, 0] }; // quadrants UL UR LL LR
  for (let i = 0; i < guideOutline.length; i++) {
    if (guideOutline[i]) {
      g++; const x = i % w, y = (i / w) | 0, k = (y >= h / 2 ? 2 : 0) + (x >= w / 2 ? 1 : 0);
      q.tot[k]++; if (dDraw[i] <= tol) { hit++; q.hit[k]++; }
    }
    if (drawMask[i]) { m++; if (dGuide[i] > farTol) far++; }
  }
  const names = ['upper left', 'upper right', 'lower left', 'lower right'];
  let weakest = null, wv = 2;
  q.tot.forEach((t, k) => { if (t > 8) { const v = q.hit[k] / t; if (v < wv) { wv = v; weakest = names[k]; } } });
  return { coverage: g ? hit / g : 0, guidePixels: g, markPixels: m, stray: m ? far / m : 0, weakest, weakestCoverage: wv > 1 ? null : wv };
}

/* ---------- lesson replay + consistency ---------- */
const KW = [
  { re: /\b(oval|circle|ellips|egg|round)/i, kinds: ['ellipse'], autos: ['construction_ellipses', 'shadow_shapes', 'light_shapes'] },
  { re: /\b(triangle|polygon|silhouette|outline|contour|edge of the)/i, kinds: ['polygon', 'polyline'], autos: ['contour', 'contours', 'silhouette', 'hollows', 'darkest_hollows', 'dark_regions', 'main_masses', 'shadow_shapes', 'light_shapes'] },
  { re: /\b(grid|thirds)/i, kinds: ['grid'], autos: ['thirds'] },
  { re: /\b(center ?line|axis|horizon|vertical line|horizontal line|midline)/i, kinds: ['line', 'cross', 'polyline'], autos: ['center_axes', 'landmarks'] },
  { re: /\b(box|bounding|frame|rectangle)/i, kinds: ['rect'], autos: ['bbox'] },
];
const PHASE_ORDER = ['gesture', 'composition', 'construction', 'contour', 'landmarks', 'value', 'underpainting', 'shadow', 'midtone', 'secondary', 'highlight', 'detail', 'practice'];

/** Heuristic text↔geometry check + ordering check. Returns {issues[], score}. NOT proof of teaching quality. */
export function lessonConsistency(lesson) {
  const issues = []; let checks = 0, ok = 0;
  const seen = new Set(); let lastRank = -1;
  for (const [i, st] of lesson.steps.entries()) {
    checks++; if (seen.has(st.id)) issues.push(`Duplicate step id ${st.id}`); else { seen.add(st.id); ok++; }
    checks++; if (st.instruction && st.why) ok++; else issues.push(`Step ${i + 1} is missing instruction or "why"`);
    const rank = PHASE_ORDER.indexOf(st.phase);
    if (rank >= 0) {
      checks++;
      if (rank + 1 < lastRank) issues.push(`Step ${i + 1} (${st.phase}) comes after a later-phase step`); else ok++;
      lastRank = Math.max(lastRank, rank);
    }
    const guides = st.guides || [];
    for (const rule of KW) {
      if (!rule.re.test(`${st.title} ${st.instruction}`)) continue;
      checks++;
      const match = guides.some((g) => rule.kinds.includes(g.kind) || (g.kind === 'auto' && rule.autos.includes(g.name)) || g.kind === 'raster' || (isFormGuide(g) && ['ellipse', 'line', 'rect'].some((k) => rule.kinds.includes(k))));
      if (match || !guides.length && false) ok++;
      else issues.push(`Step ${i + 1} text mentions ${rule.re.source.split('|')[0].replace(/[\\()?b]/g, '')}… but its guide is [${guides.map((g) => g.name || g.kind).join(', ') || 'none'}]`);
    }
  }
  return { issues, score: checks ? ok / checks : 1, checks };
}

/**
 * Replay geometry steps cumulatively. `resolve(guide)` turns {kind:'auto'} guides into primitives
 * (injected so this file stays pure). Raster guides are skipped (reported in `skipped`).
 */
export function replayLesson(lesson, resolve, W, H, thick = 2) {
  const fill = makeMask(W, H), outline = makeMask(W, H), forms = makeMask(W, H), lines = makeMask(W, H), stages = []; let skipped = 0;
  for (const st of lesson.steps) {
    let prims = 0;
    for (const g of st.guides || []) {
      const list = resolve(g) || [g]; // resolve() snaps feature/shade guides onto measured regions and expands autos
      for (const p of list || []) {
        if (p.kind === 'raster') { skipped++; continue; }
        if (p.kind === 'strokes') { rasterizePrimitive(outline, W, H, p, 'outline', thick); rasterizePrimitive(lines, W, H, p, 'outline', thick); prims++; continue; } // traced line art: drawing, not silhouette
        if (p.construct) { rasterizePrimitive(outline, W, H, p, 'outline', thick); if (p.body) rasterizePrimitive(forms, W, H, p, 'fill'); prims++; continue; } // build-up solids: scaffold only, tracked separately
        // scaffolding (grid, axes, boxes, crosses) is outline-only: never part of the silhouette
        if (p.kind === 'grid' || p.kind === 'cross' || p.kind === 'line' || p.kind === 'rect' || p.kind === 'polyline') { rasterizePrimitive(outline, W, H, p, 'outline', thick); prims++; continue; }
        if (p.role === 'shade') { rasterizePrimitive(outline, W, H, p, 'outline', thick); prims++; continue; } // tone areas are not outline: only sketch geometry may claim the silhouette
        rasterizePrimitive(fill, W, H, p, 'fill'); rasterizePrimitive(outline, W, H, p, 'outline', thick); prims++;
      }
    }
    stages.push({ stepId: st.id, title: st.title, primitives: prims, fill: Uint8Array.from(fill), outline: Uint8Array.from(outline) });
  }
  return { stages, final: { fill, outline, forms, lines }, skipped };
}

/* ---------- the "ideal artist" simulation: follow every marker literally, then compare with the picture ---------- */
export const TONE_VALUE = { darkest: 22, dark: 62, mid: 128, light: 200, highlight: 244 };
const FILL_AMT = [0.45, 0.78, 1], HATCH_AMT = [0.3, 0.45, 0.6];
function blurF(src, w, h, r) {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), d = 2 * r + 1, cl = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  for (let y = 0; y < h; y++) { let sum = 0; for (let x = -r; x <= r; x++) sum += src[y * w + cl(x, w - 1)]; for (let x = 0; x < w; x++) { tmp[y * w + x] = sum / d; sum += src[y * w + cl(x + r + 1, w - 1)] - src[y * w + cl(x - r, w - 1)]; } }
  for (let x = 0; x < w; x++) { let sum = 0; for (let y = -r; y <= r; y++) sum += tmp[cl(y, h - 1) * w + x]; for (let y = 0; y < h; y++) { out[y * w + x] = sum / d; sum += tmp[cl(y + r + 1, h - 1) * w + x] - tmp[cl(y - r, h - 1) * w + x]; } }
  return out;
}
const dilateDT = (mask, w, h, r) => { const d = distanceTransform(mask, w, h), o = new Uint8Array(w * h); for (let i = 0; i < o.length; i++) o[i] = d[i] <= r ? 1 : 0; return o; };

/**
 * simulateArtist — a beginner who does EXACTLY what each marker says, on a blank page:
 *   feature / outline markers → pencil line only (scaffold, no tone)
 *   shade fill/hatch          → darken that region toward the tone, as strongly as the step says
 *   shade lift                → pull light back out of that region
 *   shade blend_edges         → blur a band along that outline
 * Raster guides ("follow the three-value map") are skipped, never credited. Returns one frame per step.
 */
export function simulateArtist(lesson, resolve, W, H, { paper = 236 } = {}) {
  const n = W * H, tone = new Float32Array(n).fill(paper), sketch = makeMask(W, H), cons = makeMask(W, H), stages = [], thick = Math.max(2, Math.round(W * 0.007));
  let skipped = 0, shadeOps = 0;
  for (const st of lesson.steps) {
    let prims = 0;
    for (const g of st.guides || []) {
      for (const p of resolve(g) || [g]) {
        if (!p) continue;
        if (p.kind === 'raster') { skipped++; continue; }
        if (p.role === 'shade') {
          const reg = makeMask(W, H); rasterizePrimitive(reg, W, H, p, 'fill'); const s3 = Math.max(1, Math.min(3, p.strength || 2)) - 1; shadeOps++; prims++;
          if (p.action === 'blend_edges') {
            const ol = makeMask(W, H); rasterizePrimitive(ol, W, H, p, 'outline', 2); const band = dilateDT(ol, W, H, Math.max(2, W * 0.03)), bl = blurF(tone, W, H, Math.max(2, Math.round(W * 0.025)));
            for (let i = 0; i < n; i++) if (band[i]) tone[i] = bl[i];
          } else if (p.action === 'lift') { for (let i = 0; i < n; i++) if (reg[i]) tone[i] += (TONE_VALUE.highlight - tone[i]) * 0.85; }
          else { const tv = TONE_VALUE[p.tone] ?? TONE_VALUE.dark, a = (p.action === 'hatch' ? HATCH_AMT : FILL_AMT)[s3]; for (let i = 0; i < n; i++) if (reg[i] && tv < tone[i]) tone[i] += (tv - tone[i]) * a; }
          continue;
        }
        if (p.construct) { rasterizePrimitive(cons, W, H, p, 'outline', thick); prims++; continue; } // build-up solids: light scaffold lines, kept apart from the drawing proper
        if (p.kind === 'grid' || p.kind === 'cross' || p.kind === 'line' || p.kind === 'rect') { prims++; continue; } // scaffold: helps placement, draws no picture
        rasterizePrimitive(sketch, W, H, p, 'outline', thick); prims++;
      }
    }
    const frame = new Uint8ClampedArray(n); for (let i = 0; i < n; i++) frame[i] = sketch[i] ? Math.min(tone[i], 95) : cons[i] ? Math.min(tone[i], 150) : tone[i];
    stages.push({ stepId: st.id, title: st.title, primitives: prims, tone: frame, sketch: Uint8Array.from(sketch) });
  }
  const last = stages[stages.length - 1];
  return { stages, skipped, shadeOps, final: { tone: Float32Array.from(tone), sketch: Uint8Array.from(sketch), frame: last ? last.tone : new Uint8ClampedArray(n) } };
}
const pearson = (a, b) => { let ma = 0, mb = 0; const n = a.length; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; c += x * y; va += x * x; vb += y * y; } return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : 0; };

/** Compare what the ideal artist ended up with against the picture's own measurements. */
export function toneChecks(sim, maps, W, H) {
  const n = W * H, { gray, levels3, edges, mask } = maps, out = [], tone = sim.final.tone, diag = Math.hypot(W, H);
  if (sim.shadeOps) {
    const sd = new Uint8Array(n), td = new Uint8Array(n); let tl = 0, kept = 0;
    for (let i = 0; i < n; i++) { sd[i] = tone[i] < 170 ? 1 : 0; td[i] = levels3[i] === 0 ? 1 : 0; if (levels3[i] === 2) { tl++; if (tone[i] >= 165) kept++; } }
    const di = iou(sd, td), lk = tl ? kept / tl : 1, rc = Math.max(1, Math.round(W * 0.03)), co = pearson(blurF(tone, W, H, rc), blurF(gray, W, H, rc));
    out.push({ name: 'Shadows land where the picture is dark (IoU)', value: di, threshold: 0.4, pass: di >= 0.4, note: 'Areas the lesson tells you to darken vs. the picture’s darkest tone group' });
    out.push({ name: 'Lights are left alone or lifted', value: lk, threshold: 0.7, pass: lk >= 0.7, note: 'Share of the picture’s light areas the lesson does not darken' });
    out.push({ name: 'Tone pattern correlation', value: co, threshold: 0.3, pass: co >= 0.3, note: 'Simulated drawing vs. the picture, both softened (1 = same light/dark pattern)' });
  }
  { // how much of the picture's real detail does a literal follower end up drawing?  (tone steps and pencil lines both count)
    const sm = blurF(tone, W, H, 1), simEdge = Uint8Array.from(sim.final.sketch);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (Math.abs(sm[i + 1] - sm[i - 1]) + Math.abs(sm[i + W] - sm[i - W]) > 24) simEdge[i] = 1; }
    const d = distanceTransform(simEdge, W, H), tol = diag * 0.01; let te = 0, near = 0;
    for (let i = 0; i < n; i++) if (edges[i]) { te++; if (d[i] <= tol) near++; }
    if (te > n * 0.004) out.push({ name: 'Detail: strong edges of the picture that get marked', value: near / te, threshold: 0.3, pass: near / te >= 0.3, note: 'Share of the picture’s strong edges that lie within a few pixels of a pencil line or tone edge the lesson produces. Low = the lesson skips most of what makes this picture look like itself.' });
  }
  let sk = 0; for (let i = 0; i < n; i++) sk += sim.final.sketch[i];
  if (sk) {
    const ref = Uint8Array.from(edges), eb = edgePixels(mask, W, H); for (let i = 0; i < n; i++) if (eb[i]) ref[i] = 1;
    const d = distanceTransform(ref, W, H), tol = diag * 0.018; let hit = 0; for (let i = 0; i < n; i++) if (sim.final.sketch[i] && d[i] <= tol) hit++;
    out.push({ name: 'Sketch lines sit on real edges', value: hit / sk, threshold: 0.45, pass: hit / sk >= 0.45, note: 'Share of the pencil lines the lesson asks for that run along an edge in the picture' });
  }
  return out;
}

/**
 * perfectArtistReport — headline numbers + honest caveats.
 * target: {fill: Uint8Array silhouette mask, outline?: Uint8Array} at W×H.
 */
export function perfectArtistReport({ lesson, resolve, target, W, H, iouThreshold = target && target.approx ? 0.4 : 0.55, chamferThreshold = target && target.approx ? 0.09 : 0.06 }) {
  const replay = replayLesson(lesson, resolve, W, H);
  const diag = Math.hypot(W, H);
  const stageRows = replay.stages.map((s) => ({
    stepId: s.stepId, title: s.title, primitives: s.primitives,
    iou: s.primitives ? iou(s.fill, target.fill) : null,
  }));
  const finalIoU = iou(replay.final.fill, target.fill);
  const ch = chamfer(replay.final.fill, target.fill, W, H);
  const chamferNorm = ch / diag;
  const stepCoverage = lesson.steps.filter((s) => (s.guides || []).length).length / Math.max(1, lesson.steps.length);
  const consistency = lessonConsistency(lesson);
  const sim = target.maps ? simulateArtist(lesson, resolve, W, H) : null, extra = sim ? toneChecks(sim, target.maps, W, H) : [];
  const exempt = NO_SKETCH_TYPES.includes(lesson.analysis && lesson.analysis.image_type) || lesson.strategy === 'pixel' || lesson.strategy === 'free';
  const sketchOk = hasSketchStep(lesson);
  const bu = lesson.build_up || {}, formsMask = replay.final.forms, n = W * H;
  let fm = 0; for (let i = 0; i < n; i++) fm += formsMask[i];
  const buildChecks = [];
  if (!exempt && bu.construct_requested) {
    const have = hasConstructStep(lesson) && fm > 0;
    buildChecks.push({ name: 'Subject is built up from simple solids first', value: have ? 1 : 0, threshold: 1, pass: have, note: have ? 'Spheres / boxes / cylinders appear in the first steps' : 'No construction solids in the first steps (or they could not be placed)' });
  }
  if (fm > 0) {
    const near = dilateDT(target.fill, W, H, Math.max(2, W * 0.03)); let inside = 0, cov = 0, sub = 0;
    for (let i = 0; i < n; i++) { if (formsMask[i] && near[i]) inside++; if (target.fill[i]) { sub++; if (formsMask[i]) cov++; } }
    buildChecks.push({ name: 'Solids sit on the subject', value: inside / fm, threshold: 0.7, pass: inside / fm >= 0.7, note: 'Share of the spheres / boxes / cylinders that lies over the subject rather than empty background' });
    buildChecks.push({ name: 'Solids cover the subject', value: sub ? cov / sub : 0, threshold: 0.5, pass: sub ? cov / sub >= 0.5 : false, note: 'Share of the subject’s silhouette that the solids account for — low means big parts of the figure are not blocked in' });
    const prim = (st) => (st.guides || []).flatMap((g) => resolve(g) || []);
    const ci = lesson.steps.findIndex((st) => prim(st).some((p) => p.construct)), oi = lesson.steps.findIndex((st) => prim(st).some((p) => p.kind === 'strokes' || (p.kind === 'polygon' && !p.construct && (p.sketch || p.outline))));
    buildChecks.push({ name: 'Solids come before the outline', value: ci >= 0 && oi >= 0 && ci < oi ? 1 : 0, threshold: 1, pass: ci >= 0 && oi >= 0 && ci < oi, note: ci < 0 ? 'No solids' : oi < 0 ? 'No traced outline follows the solids' : `Solids at step ${ci + 1}, outline at step ${oi + 1}` });
  }
  let lm = 0; for (let i = 0; i < n; i++) lm += replay.final.lines[i];
  if (!exempt && bu.precise_requested) {
    const have = hasLineArtStep(lesson) && lm > 0;
    buildChecks.push({ name: 'Line art is traced (the lines you would draw over the picture)', value: have ? 1 : 0, threshold: 1, pass: have, note: have ? 'The lesson has a step that traces the picture’s own lines' : 'No line-art trace step' });
  }
  if (lm > 0 && target.maps) { // does the traced line art lie on the picture's real lines, and does it capture most of them?
    const { edges, gray } = target.maps, tol = Math.max(2, diag * 0.012), dl = distanceTransform(replay.final.lines, W, H);
    const med = Float32Array.from(gray).sort()[n >> 1], ref = new Uint8Array(n); for (let i = 0; i < n; i++) ref[i] = edges[i] || gray[i] < med - 18 ? 1 : 0;
    const dr = distanceTransform(ref, W, H); let te = 0, near = 0, on = 0; for (let i = 0; i < n; i++) { if (edges[i]) { te++; if (dl[i] <= tol) near++; } if (replay.final.lines[i] && dr[i] <= tol) on++; }
    buildChecks.push({ name: 'Line art lies on the picture’s real lines', value: on / lm, threshold: 0.6, pass: on / lm >= 0.6, note: 'Share of the traced line pixels that sit on an edge or dark mark in the picture' });
    if (te > n * 0.003) buildChecks.push({ name: 'Line art captures the picture’s strong lines', value: near / te, threshold: 0.35, pass: near / te >= 0.35, note: 'Share of the picture’s strong edges that have a traced line right beside them (whiskers, folds, inner detail — not just the outer shape)' });
  }
  let fillPx = 0; for (let i = 0; i < n; i++) fillPx += replay.final.fill[i];
  const checks = [
    ...(exempt ? [] : [{ name: 'A sketch is established first', value: sketchOk ? 1 : 0, threshold: 1, pass: sketchOk, note: sketchOk ? 'An outline / construction step comes in the first three steps' : 'No outline or construction shapes in the first three steps' }]),
    ...buildChecks,
    ...(fillPx ? [{ name: 'Silhouette IoU', value: finalIoU, threshold: iouThreshold, pass: finalIoU >= iouThreshold, note: 'Union of the lesson’s sketch geometry vs. target silhouette' },
    { name: 'Contour chamfer (normalised)', value: chamferNorm, threshold: chamferThreshold, pass: chamferNorm <= chamferThreshold, lowerIsBetter: true, note: 'Mean boundary distance ÷ image diagonal' }] : []),
    { name: 'Step coverage', value: stepCoverage, threshold: 0.6, pass: stepCoverage >= 0.6, note: 'Share of steps that carry executable geometry' },
    { name: 'Instruction↔geometry consistency (heuristic)', value: consistency.score, threshold: 0.7, pass: consistency.score >= 0.7, note: consistency.issues.join(' • ') || 'No keyword/geometry mismatches found' },
    ...extra,
  ];
  return {
    stages: stageRows, finalIoU, chamfer: ch, chamferNorm, stepCoverage, consistency, checks,
    skippedRasterGuides: replay.skipped, replay, sim,
    pass: checks.every((c) => c.pass),
    caveats: [
      'Geometry that is derived from the reference image (auto guides) makes the reconstruction score partly circular: it validates the pipeline and replay, not the teaching quality. For AI lessons the scores are independent evidence.',
      'The simulated artist follows only the markers. “Follow the three-value map” steps are skipped, so mid-tones are never credited.',
      'Written instructions are only checked by keyword heuristics against their geometry.',
      'Whether the lesson actually helps a person learn needs human testing.',
    ],
  };
}
