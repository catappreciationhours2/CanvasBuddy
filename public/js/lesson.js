// lesson.js — pure lesson logic: schema validation, guide resolution, offline lesson templates.
// Used by the browser, the server (to validate model output) and the Perfect Artist tests.

export const SCHEMA_VERSION = '0.2';
export const TONES = ['darkest', 'dark', 'mid', 'light', 'highlight'];
export const SHADE_ACTIONS = ['fill', 'hatch', 'blend_edges', 'lift'];
export const SCAFFOLD_PHASES = ['gesture', 'composition', 'construction', 'landmarks'];
export const BRUSH_IDS = ['pencil', 'ink', 'marker', 'airbrush', 'watercolor', 'oil', 'charcoal', 'pixel', 'smudge', 'eraser'];
export const IMAGE_TYPES = ['line_art', 'portrait', 'landscape', 'painterly', 'watercolor', 'pixel_art', 'abstract', 'geometric', 'still_life', 'cartoon', 'photo', 'general'];
export const PHASES = ['gesture', 'composition', 'value', 'underpainting', 'construction', 'contour', 'shadow', 'landmarks', 'midtone', 'secondary', 'highlight', 'detail', 'practice'];
export const AUTO_NAMES = ['silhouette', 'hollows', 'darkest_hollows', 'main_masses', 'dark_regions', 'light_regions', 'soften_edges', 'bbox', 'center_axes', 'thirds', 'construction_ellipses', 'construction_forms', 'construction_stick', 'silhouette_precise', 'lineart_main', 'lineart_fine', 'contour', 'contours', 'shadow_shapes', 'light_shapes', 'landmarks', 'edges', 'value3', 'value5', 'masses', 'pixel_grid'];
const RASTER_AUTOS = new Set(['edges', 'value3', 'value5', 'masses']);

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const clean = (s, max) => (typeof s === 'string' ? s.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max) : '');
const isPt = (p) => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1]);
const pt = (p) => [clamp01(+p[0]), clamp01(+p[1])];

export function brushFromHint(hint, fallback = 'pencil') {
  const h = String(hint || '').toLowerCase();
  if (BRUSH_IDS.includes(h)) return h;
  const rules = [
    [/eras/, 'eraser'], [/smudge|blend/, 'smudge'], [/pixel/, 'pixel'], [/charcoal|conte/, 'charcoal'],
    [/water|wash|glaz/, 'watercolor'], [/oil|bristle|flat|block|acrylic|dry ?brush|gouache|large/, 'oil'],
    [/pencil|graphite|sketch|\bhb\b|\b2b\b/, 'pencil'],
    [/air|spray|soft/, 'airbrush'], [/marker|chisel|felt/, 'marker'], [/\bink\b|\bpen\b|liner|fine|detail/, 'ink'],
  ];
  for (const [re, id] of rules) if (re.test(h)) return id;
  return fallback;
}

function geomFrom(g) {
  const pts = (Array.isArray(g.points) ? g.points : Array.isArray(g.pts) ? g.pts : []).filter(isPt).map(pt);
  if (pts.length >= 3) return { type: 'polygon', points: pts.slice(0, 80) };
  const box = Array.isArray(g.box) ? g.box : Array.isArray(g.bbox) ? g.bbox : null;
  if (box && box.length === 4 && box.every((v) => isFinite(v))) {
    const x0 = clamp01(Math.min(box[0], box[2])), x1 = clamp01(Math.max(box[0], box[2])), y0 = clamp01(Math.min(box[1], box[3])), y1 = clamp01(Math.max(box[1], box[3]));
    if (x1 - x0 < 0.004 || y1 - y0 < 0.004) return null;
    if (String(g.shape) === 'rect') return { type: 'polygon', points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
    return { type: 'ellipse', center: [(x0 + x1) / 2, (y0 + y1) / 2], radius: [(x1 - x0) / 2, (y1 - y0) / 2], rotation: num(g.rotation, 0) };
  }
  const c = g.center || g.c, r = g.radius || g.r;
  if (isPt(c) && (isPt(r) || typeof r === 'number')) { const rr = isPt(r) ? [+r[0], +r[1]] : [r, r]; return { type: 'ellipse', center: pt(c), radius: rr.map((v) => Math.max(0.004, Math.min(0.6, Math.abs(v)))), rotation: num(g.rotation, 0) }; }
  return null;
}
function geomArea(gm) {
  if (gm.type === 'ellipse') return Math.PI * gm.radius[0] * gm.radius[1];
  let a = 0; const p = gm.points; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a) / 2;
}

/** Normalise one guide. Returns null if unusable. Accepts a few synonym keys models like to use. */
export function normalizeGuide(g, warn = () => {}) {
  if (!g || typeof g !== 'object') return null;
  const kind = String(g.kind || g.type || '').toLowerCase();
  const label = clean(g.label, 40);
  const ptsOf = (a) => (Array.isArray(a) ? a.filter(isPt).map(pt) : []);
  switch (kind) {
    case 'ellipse': case 'circle': case 'oval': {
      const c = g.center || g.c, r = g.radius || g.r;
      if (!isPt(c)) { warn('ellipse without center'); return null; }
      let rr = isPt(r) ? [+r[0], +r[1]] : typeof r === 'number' ? [r, r] : null;
      if (!rr) { warn('ellipse without radius'); return null; }
      rr = rr.map((v) => Math.max(0.005, Math.min(0.75, Math.abs(v))));
      return { kind: 'ellipse', center: pt(c), radius: rr, rotation: num(g.rotation, 0), label };
    }
    case 'rect': case 'box': case 'bbox': {
      let x = num(g.x, NaN), y = num(g.y, NaN), w = num(g.w ?? g.width, NaN), h = num(g.h ?? g.height, NaN);
      if (Array.isArray(g.bbox) && g.bbox.length === 4) { x = g.bbox[0]; y = g.bbox[1]; w = g.bbox[2] - g.bbox[0]; h = g.bbox[3] - g.bbox[1]; }
      if (![x, y, w, h].every(isFinite) || w <= 0 || h <= 0) { warn('invalid rect'); return null; }
      x = clamp01(x); y = clamp01(y); w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
      return { kind: 'rect', x, y, w, h, label };
    }
    case 'line': {
      const a = g.from || (g.points && g.points[0]), b = g.to || (g.points && g.points[1]);
      if (!isPt(a) || !isPt(b)) { warn('line needs from/to'); return null; }
      return { kind: 'line', points: [pt(a), pt(b)], label };
    }
    case 'polyline': case 'path': {
      const p = ptsOf(g.points || g.pts); if (p.length < 2) { warn('polyline needs >=2 points'); return null; }
      return { kind: 'polyline', points: p.slice(0, 200), label };
    }
    case 'polygon': {
      const p = ptsOf(g.points || g.pts); if (p.length < 3) { warn('polygon needs >=3 points'); return null; }
      return { kind: 'polygon', points: p.slice(0, 200), label };
    }
    case 'grid': {
      const cols = Math.max(2, Math.min(64, Math.round(num(g.cols, 3)))), rows = Math.max(2, Math.min(64, Math.round(num(g.rows, 3))));
      return { kind: 'grid', cols, rows, label };
    }
    case 'cross': case 'point': {
      const c = g.center || g.c || g.xy; if (!isPt(c)) return null;
      return { kind: 'cross', center: pt(c), size: Math.max(0.01, Math.min(0.2, num(g.size, 0.04))), label };
    }
    case 'form': { // a 3D building block for the construction stage: sphere / box / cylinder / axis (line of action)
      const shape = String(g.shape || '').toLowerCase();
      if (!['sphere', 'box', 'cylinder', 'axis'].includes(shape)) { warn(`form "${label}" has an unknown shape "${shape}"`); return null; }
      const lab = label || `${shape[0].toUpperCase()}${shape.slice(1)} form`;
      if (shape === 'sphere') {
        const c = g.center || g.c, r = g.radius ?? g.r;
        if (!isPt(c)) { warn('sphere needs a center'); return null; }
        if (isPt(r)) {
          const radius = [+r[0], +r[1]].map((v) => Math.max(0.01, Math.min(0.5, Math.abs(v))));
          if (Math.PI * radius[0] * radius[1] > 0.6) { warn(`form "${lab}" covers the whole picture — removed`); return null; }
          return { kind: 'form', shape, label: lab, center: pt(c), radius, rotation: num(g.rotation, 0) };
        }
        if (typeof r !== 'number' || !isFinite(r)) { warn('sphere needs a radius'); return null; }
        const rn = Math.max(0.01, Math.min(0.5, Math.abs(r)));
        if (rn > 0.4) { warn(`form "${lab}" covers the whole picture — removed`); return null; } // a single number = fraction of the picture's width (a true circle)
        return { kind: 'form', shape, label: lab, center: pt(c), r: rn, rotation: 0 };
      }
      if (shape === 'box') {
        const b = Array.isArray(g.box) ? g.box : Array.isArray(g.bbox) ? g.bbox : null;
        if (!b || b.length !== 4 || !b.every((v) => isFinite(v))) { warn('box needs box:[x0,y0,x1,y1]'); return null; }
        const x0 = clamp01(Math.min(b[0], b[2])), x1 = clamp01(Math.max(b[0], b[2])), y0 = clamp01(Math.min(b[1], b[3])), y1 = clamp01(Math.max(b[1], b[3]));
        if (x1 - x0 < 0.01 || y1 - y0 < 0.01) { warn('box too small'); return null; }
        if ((x1 - x0) * (y1 - y0) > 0.65) { warn(`form "${lab}" covers the whole picture — removed`); return null; }
        const d = isPt(g.depth) ? [Math.max(-0.3, Math.min(0.3, +g.depth[0])), Math.max(-0.3, Math.min(0.3, +g.depth[1]))] : null;
        return { kind: 'form', shape, label: lab, box: [x0, y0, x1, y1], rotation: Math.max(-90, Math.min(90, num(g.rotation, 0))), depth: d };
      }
      if (shape === 'cylinder') {
        const a = g.from || (g.points && g.points[0]), b = g.to || (g.points && g.points[1]), r = typeof g.radius === 'number' ? g.radius : num(g.r, NaN);
        if (!isPt(a) || !isPt(b)) { warn('cylinder needs from/to'); return null; }
        if (!isFinite(r)) { warn('cylinder needs a radius'); return null; }
        return { kind: 'form', shape, label: lab, from: pt(a), to: pt(b), radius: Math.max(0.005, Math.min(0.3, Math.abs(r))) };
      }
      const a = g.from || (g.points && g.points[0]), b = g.to || (g.points && g.points[1]);
      if (!isPt(a) || !isPt(b)) { warn('axis needs from/to'); return null; }
      return { kind: 'form', shape: 'axis', label: lab, from: pt(a), to: pt(b) };
    }
    case 'feature': case 'shade': {
      const geom = geomFrom(g), snap = /^[DLMH]\d{1,2}$/i.test(String(g.snap || '')) ? String(g.snap).toUpperCase() : null;
      if (!geom && !snap) { warn(`${kind} "${label}" has no position`); return null; }
      if (!label) { warn(`${kind} without a label`); return null; }
      if (geom && geomArea(geom) > 0.65) { warn(`${kind} "${label}" covers the whole picture — removed`); return null; }
      const base = { kind, label, geom, snap, note: clean(g.note, 70) };
      if (kind === 'feature') return { ...base, expect: ['dark', 'light', 'edge', 'any'].includes(g.expect) ? g.expect : 'any' };
      const tone = TONES.includes(g.tone) ? g.tone : 'dark', action = SHADE_ACTIONS.includes(g.action) ? g.action : tone === 'light' || tone === 'highlight' ? 'lift' : 'fill';
      return { ...base, tone, action, strength: Math.max(1, Math.min(3, Math.round(num(g.strength, 2)))) };
    }
    case 'auto': {
      const name = String(g.name || '').toLowerCase();
      if (!AUTO_NAMES.includes(name)) { warn(`unknown auto guide "${name}"`); return null; }
      return { kind: 'auto', name, label };
    }
    default: warn(`unknown guide kind "${kind}"`); return null;
  }
}

/**
 * validateLesson(raw, ctx) — never throws. Returns {lesson|null, warnings[]}.
 * ctx.fallbackType lets the caller supply a locally guessed image type.
 */
export function validateLesson(raw, ctx = {}) {
  const warnings = []; const warn = (m) => warnings.push(m);
  if (!raw || typeof raw !== 'object') return { lesson: null, warnings: ['not an object'] };
  const a = raw.analysis && typeof raw.analysis === 'object' ? raw.analysis : {};
  let type = String(a.image_type || raw.image_type || ctx.fallbackType || 'general').toLowerCase().replace(/[\s-]+/g, '_');
  if (!IMAGE_TYPES.includes(type)) { warn(`unknown image_type "${type}" → general`); type = 'general'; }
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!rawSteps.length) return { lesson: null, warnings: [...warnings, 'no steps'] };
  const steps = []; const usedIds = new Set();
  rawSteps.slice(0, 9).forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    const instruction = clean(s.instruction, 320);
    if (!instruction) { warn(`step ${i + 1} dropped (no instruction)`); return; }
    let id = clean(s.id, 24).replace(/[^\w-]/g, '') || `step-${i + 1}`;
    if (usedIds.has(id)) id = `step-${i + 1}`;
    usedIds.add(id);
    const gs = [];
    const inGuides = Array.isArray(s.guides) ? s.guides : s.guide ? [s.guide] : [];
    for (const g of inGuides.slice(0, 10)) {
      const ng = normalizeGuide(g, (m) => warn(`step ${i + 1}: ${m}`));
      if (ng && ng.kind === 'rect' && ng.w * ng.h > 0.7) { warn(`step ${i + 1}: full-frame box removed`); continue; }
      if (ng) gs.push(ng);
    }
    const phase = PHASES.includes(String(s.phase)) ? s.phase : guessPhase(s);
    const comp = s.completion && typeof s.completion === 'object' ? s.completion : {};
    steps.push({
      id, title: clean(s.title, 70) || `Step ${i + 1}`, phase, instruction,
      why: clean(s.why, 240), tip: clean(s.tip, 240),
      guides: gs, layer: SCAFFOLD_PHASES.includes(phase) ? 'scaffold' : 'art', unanchored: gs.length === 0 && phase !== 'practice' && ctx.source !== 'local', tool_hint: clean(s.tool_hint, 60),
      brush: brushFromHint(s.brush || s.tool_hint, 'pencil'),
      size_hint: ['large', 'medium', 'small'].includes(s.size_hint) ? s.size_hint : undefined,
      technique: clean(s.technique, 40).toLowerCase().replace(/\s+/g, '_') || undefined,
      completion: { kind: ['user_marks_done', 'guide_coverage'].includes(comp.kind) ? comp.kind : 'user_marks_done', tolerance: ['lenient', 'normal', 'strict'].includes(comp.tolerance) ? comp.tolerance : 'lenient' },
    });
  });
  if (!steps.length) return { lesson: null, warnings: [...warnings, 'no usable steps'] };
  const comp = raw.composition && typeof raw.composition === 'object' ? raw.composition : {};
  const anchors = (Array.isArray(comp.anchors) ? comp.anchors : []).filter((x) => x && isPt(x.xy)).slice(0, 8).map((x) => ({ label: clean(x.label, 40), xy: pt(x.xy) }));
  const pal = (Array.isArray(raw.palette) ? raw.palette : []).filter((p) => p && /^#[0-9a-f]{6}$/i.test(p.hex)).slice(0, 10)
    .map((p) => ({ hex: p.hex.toUpperCase(), role: clean(p.role, 20) || 'midtone', fraction_estimate: Math.max(0, Math.min(1, num(p.fraction_estimate, 0))) }));
  const tips = (Array.isArray(raw.tips) ? raw.tips : []).slice(0, 6).map((t) => ({ title: clean(t && t.title, 50), body: clean(t && t.body, 260), topic: clean(t && t.topic, 30) })).filter((t) => t.body);
  const lesson = {
    schema_version: SCHEMA_VERSION,
    source: ctx.source || 'ai',
    analysis: {
      image_type: type, medium: clean(a.medium, 40) || ctx.medium || 'unknown',
      complexity: ['beginner', 'intermediate', 'advanced'].includes(a.complexity) ? a.complexity : 'intermediate',
      confidence: Math.max(0, Math.min(1, num(a.confidence, 0.5))),
      uncertainties: (Array.isArray(a.uncertainties) ? a.uncertainties : []).slice(0, 5).map((u) => clean(u, 120)).filter(Boolean),
      summary: clean(a.summary || raw.summary, 420),
      subject: clean(a.subject, 80),
    },
    learning_goal: clean(raw.learning_goal, 160) || 'Understand how this image is built, then make your own version',
    strategy: clean(raw.strategy, 50).toLowerCase().replace(/\s+/g, '_') || 'general',
    buddy_intro: clean(raw.buddy_intro, 300),
    composition: { focal_point: isPt(comp.focal_point) ? pt(comp.focal_point) : null, anchors, notes: clean(comp.notes, 300) },
    palette: pal, steps, tips,
  };
  return { lesson, warnings };
}

function guessPhase(s) {
  const t = `${s.title || ''} ${s.instruction || ''}`.toLowerCase();
  if (/gesture|whole|overall/.test(t)) return 'gesture';
  if (/composition|thumbnail|placement/.test(t)) return 'composition';
  if (/value|grayscale|three-value/.test(t)) return 'value';
  if (/underpaint|wash|mass/.test(t)) return 'underpainting';
  if (/construct|oval|block in|shape/.test(t)) return 'construction';
  if (/contour|outline|silhouette/.test(t)) return 'contour';
  if (/shadow/.test(t)) return 'shadow';
  if (/landmark|proportion|measure/.test(t)) return 'landmarks';
  if (/midtone/.test(t)) return 'midtone';
  if (/highlight|light/.test(t)) return 'highlight';
  if (/detail|texture|refine|edge/.test(t)) return 'detail';
  return 'secondary';
}

/* ---------- guide resolution: lesson guide -> drawable primitives ---------- */
const regionById = (summary, id) => ((summary && summary.regions) || []).find((r) => r.id === id) || null;
const bboxOf = (gm) => {
  if (gm.type === 'polygon') { const xs = gm.points.map((p) => p[0]), ys = gm.points.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
  const [cx, cy] = gm.center, [rx, ry] = gm.radius; return [cx - rx, cy - ry, cx + rx, cy + ry];
};
const inPoly = (pt2, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > pt2[1]) !== (b[1] > pt2[1]) && pt2[0] < ((b[0] - a[0]) * (pt2[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const regs = (s, prefix) => ((s && s.regions) || []).filter((r) => r.id[0] === prefix);
const boxIoU = (a, b) => { const iw = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), ih = Math.min(a[3], b[3]) - Math.max(a[1], b[1]); if (iw <= 0 || ih <= 0) return 0; const i = iw * ih, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i; return i / u; };


/* ---------- construction forms: spheres, boxes, cylinders, line of action → drawable primitives ---------- */
const capw = (t) => t[0].toUpperCase() + t.slice(1);
/** Expand one form spec into primitives (all `construct:true`; `body:true` marks the filled-in volume used for audits). Pure geometry, aspect = width/height. */
export function formPrims(f, aspect = 1) {
  const A = aspect > 0 ? aspect : 1, label = f.label || `${capw(f.shape)} form`, base = { construct: true, form: label, shape: f.shape, label };
  const U = (q) => [q[0] * A, q[1]], N = (u) => [clamp01(u[0] / A), clamp01(u[1])];
  const rot = (v, c, deg) => { const r = (deg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r), dx = v[0] - c[0], dy = v[1] - c[1]; return [c[0] + dx * cs - dy * sn, c[1] + dx * sn + dy * cs]; };
  if (f.shape === 'sphere') {
    const [rx, ry] = Array.isArray(f.radius) ? f.radius : [f.r, f.r * A];
    return [
      { kind: 'ellipse', center: f.center, radius: [rx, ry], rotation: f.rotation || 0, ...base, body: true },
      { kind: 'ellipse', center: f.center, radius: [rx, ry * 0.3], rotation: f.rotation || 0, ...base, minor: true }, // the "equator" that makes a circle read as a ball
    ];
  }
  if (f.shape === 'box') {
    const [x0, y0, x1, y1] = f.box, c = U([(x0 + x1) / 2, (y0 + y1) / 2]), m = Math.min((x1 - x0) * A, y1 - y0) * 0.3;
    const du = f.depth ? [f.depth[0] * A, f.depth[1]] : [m, -m];
    const fr = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((q) => rot(U(q), c, f.rotation || 0)), bk = fr.map((q) => [q[0] + du[0], q[1] + du[1]]);
    const out = [{ kind: 'polygon', points: fr.map(N), ...base, body: true }, { kind: 'polygon', points: bk.map(N), ...base, body: true, minor: true }];
    for (let i = 0; i < 4; i++) out.push({ kind: 'polyline', points: [N(fr[i]), N(bk[i])], ...base, minor: true });
    return out;
  }
  if (f.shape === 'cylinder') {
    const a = U(f.from), b = U(f.to), r = f.radius * A, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (len < 1e-4) return [];
    const ux = dx / len, uy = dy / len, px = -uy, py = ux, ang = (Math.atan2(py, px) * 180) / Math.PI;
    const cap = (c) => ({ kind: 'ellipse', center: N(c), radius: [r / A, r * 0.32], rotation: ang, ...base });
    return [
      { kind: 'polygon', points: [[a[0] + px * r, a[1] + py * r], [b[0] + px * r, b[1] + py * r], [b[0] - px * r, b[1] - py * r], [a[0] - px * r, a[1] - py * r]].map(N), ...base, body: true },
      cap(a), cap(b),
    ];
  }
  if (f.shape === 'axis') return [{ kind: 'line', points: [f.from, f.to], ...base, label: f.label || 'Line of action' }];
  return [];
}
const formLabels = (forms) => {
  const seen = {}; forms.forEach((f) => { seen[f.shape] = (seen[f.shape] || 0) + 1; });
  const idx = {}; return forms.map((f) => { idx[f.shape] = (idx[f.shape] || 0) + 1; return `${capw(f.shape)} form${seen[f.shape] > 1 ? ` ${idx[f.shape]}` : ''}`; });
};
const aspectOf = (summary) => (summary && summary.width && summary.height ? summary.width / summary.height : 1);

/** Turn a feature/shade guide into a drawable primitive, snapping onto a measured region when one agrees with it. */
function resolveTarget(g, summary) {
  const wantTone = g.kind === 'shade' ? (['darkest', 'dark'].includes(g.tone) ? 'dark' : ['light', 'highlight'].includes(g.tone) ? 'light' : null) : g.expect === 'dark' ? 'dark' : g.expect === 'light' ? 'light' : null;
  let region = g.snap ? regionById(summary, g.snap) : null, snapped = region ? g.snap : null;
  if (region && g.geom && boxIoU(bboxOf(g.geom), region.bbox) < 0.2) { region = null; snapped = null; } // the model's snap id disagrees with its own box: trust neither blindly, keep its box
  if (!region && g.geom && wantTone) { // auto-snap only when the measured blob clearly overlaps the model's own estimate
    const gb = bboxOf(g.geom); let best = null, bi = 0.4;
    for (const r of (summary && summary.regions) || []) { if (r.tone !== wantTone) continue; const v = boxIoU(gb, r.bbox); if (v > bi) { bi = v; best = r; } }
    if (best) { region = best; snapped = `auto:${best.id}`; }
  }
  const meta = { role: g.kind, label: g.label, note: g.note, tone: g.tone, action: g.action, strength: g.strength, expect: g.expect, snapped, outline: g.kind === 'feature' && g.expect === 'edge' };
  // the measured pixel outline is the most faithful shape; a fitted ellipse is only the fallback
  if (region && region.contour && region.contour.length >= 4) return { kind: 'polygon', points: region.contour, ...meta };
  if (region && region.ellipse) return { kind: 'ellipse', ...region.ellipse, ...meta };
  if (!g.geom) return null;
  return g.geom.type === 'ellipse' ? { kind: 'ellipse', center: g.geom.center, radius: g.geom.radius, rotation: g.geom.rotation || 0, ...meta } : { kind: 'polygon', points: g.geom.points, ...meta };
}

export function resolveGuide(g, summary) {
  if (!g) return [];
  if (g.kind === 'feature' || g.kind === 'shade') { const p = resolveTarget(g, summary); return p ? [p] : []; }
  if (g.kind === 'form') return formPrims(g, aspectOf(summary));
  if (g.kind !== 'auto') return [g];
  if (RASTER_AUTOS.has(g.name)) return [{ kind: 'raster', name: g.name }];
  const s = summary || {}; const sub = s.subject || {};
  const bb = sub.bbox || [0.1, 0.1, 0.9, 0.9], cen = sub.centroid || [0.5, 0.5];
  switch (g.name) {
    case 'lineart_main': case 'lineart_fine': { // the lines you would draw if you traced the picture: pencil strokes, whiskers, folds, inner detail
      const la = s.lineart; if (!la || !la.strokes || la.strokes.length < 3) return [];
      const paths = g.name === 'lineart_main' ? la.strokes.slice(0, la.main) : la.strokes.slice(la.main);
      return paths.length ? [{ kind: 'strokes', paths, label: g.name === 'lineart_main' ? 'Main lines' : 'Finer lines', sketch: true, lineart: true, level: g.name === 'lineart_main' ? 'main' : 'fine' }] : [];
    }
    case 'silhouette_precise': { // every substantial piece of the subject, traced with ~10× the points of the teaching outline
      const cs = (sub.contoursFine && sub.contoursFine.length ? sub.contoursFine : sub.contours) || [];
      return cs.filter((c) => c && c.length >= 4 && geomArea({ type: 'polygon', points: c }) <= 0.8).map((c, i) => ({ kind: 'polygon', points: c, label: i ? `Outline ${i + 1}` : 'Outline', sketch: true, precise: true }));
    }
    case 'construction_stick': { // stick figure first: the line of action plus a centre line for every long part (limbs, neck, trunk)
      const forms = (sub.forms || []).slice(0, 8), A = aspectOf(s), out = [];
      if (sub.axis) out.push(...formPrims({ shape: 'axis', from: sub.axis.from, to: sub.axis.to, label: 'Line of action' }, A));
      forms.filter((f) => f.shape === 'cylinder' && f.from && f.to).forEach((f, i) => out.push({ kind: 'line', points: [f.from, f.to], label: `Stick ${i + 1}`, construct: true, form: `Stick ${i + 1}`, shape: 'axis', minor: true }));
      return out;
    }
    case 'construction_forms': {
      const forms = (sub.forms || []).slice(0, 8), labs = formLabels(forms), A = aspectOf(s);
      return forms.flatMap((f, i) => formPrims({ ...f, kind: 'form', label: labs[i] }, A));
    }
    case 'silhouette': { const c = sub.contours && sub.contours[0]; if (!c || c.length < 4 || geomArea({ type: 'polygon', points: c }) > 0.8) return []; return [{ kind: 'polygon', points: c, label: 'Outline', sketch: true }]; }
    case 'hollows': return regs(s, 'H').map((r, i) => resolveTarget({ kind: 'feature', label: `Hollow ${i + 1}`, expect: 'dark', snap: r.id }, s)).filter(Boolean);
    case 'darkest_hollows': return regs(s, 'H').map((r, i) => resolveTarget({ kind: 'shade', label: `Hollow ${i + 1}`, tone: 'darkest', action: 'fill', strength: 3, snap: r.id }, s)).filter(Boolean);
    case 'main_masses': return regs(s, 'D').filter((r) => r.area < 0.5).slice(0, 2).map((r, i) => resolveTarget({ kind: 'feature', label: i === 0 ? 'Main dark mass' : 'Second dark mass', expect: 'dark', snap: r.id }, s)).filter(Boolean);
    case 'dark_regions': return regs(s, 'D').slice(0, 3).map((r, i) => resolveTarget({ kind: 'shade', label: i === 0 ? 'Shadow side' : `Dark shape ${i + 1}`, tone: 'dark', action: r.area > 0.2 ? 'hatch' : 'fill', strength: 2, snap: r.id }, s)).filter(Boolean);
    case 'light_regions': { const poly = sub.contours && sub.contours[0]; return regs(s, 'L').filter((r) => r.area < 0.35 && (!poly || inPoly(r.centroid, poly))).slice(0, 4).map((r, i) => resolveTarget({ kind: 'shade', label: `Light area ${i + 1}`, tone: 'highlight', action: 'lift', strength: 2, snap: r.id }, s)).filter(Boolean); }
    case 'soften_edges': return regs(s, 'D').slice(0, 2).map((r, i) => resolveTarget({ kind: 'shade', label: `Soft edge ${i + 1}`, tone: 'dark', action: 'blend_edges', strength: 1, snap: r.id }, s)).filter(Boolean);
    case 'bbox': if ((bb[2] - bb[0]) * (bb[3] - bb[1]) > 0.8) return [];
      return [{ kind: 'rect', x: bb[0], y: bb[1], w: bb[2] - bb[0], h: bb[3] - bb[1], label: 'whole subject' }];
    case 'center_axes': {
      const px = (bb[2] - bb[0]) * 0.06, py = (bb[3] - bb[1]) * 0.06;
      return [
        { kind: 'line', points: [[cen[0], Math.max(0, bb[1] - py)], [cen[0], Math.min(1, bb[3] + py)]], label: 'vertical axis' },
        { kind: 'line', points: [[Math.max(0, bb[0] - px), cen[1]], [Math.min(1, bb[2] + px), cen[1]]], label: 'horizontal axis' },
      ];
    }
    case 'thirds': return [{ kind: 'grid', cols: 3, rows: 3, label: 'rule of thirds' }];
    case 'pixel_grid': { const cols = 32, rows = Math.max(8, Math.round((cols * (s.height || 1)) / (s.width || 1))); return [{ kind: 'grid', cols, rows, label: 'pixel grid' }]; }
    case 'construction_ellipses': return (sub.ellipses || []).slice(0, 4).map((e, i) => ({ kind: 'ellipse', center: e.center, radius: e.radius, rotation: e.rotation, label: `shape ${i + 1}` }));
    case 'contour': return sub.contours && sub.contours[0] ? [{ kind: 'polygon', points: sub.contours[0], label: 'main outline', sketch: true }] : [];
    case 'contours': return (sub.contours || []).map((p, i) => ({ kind: 'polygon', points: p, label: `outline ${i + 1}`, sketch: true }));
    case 'shadow_shapes': return ((s.masses && s.masses.shadow && s.masses.shadow.contours) || []).map((p, i) => ({ kind: 'polygon', points: p, label: `shadow ${i + 1}` }));
    case 'light_shapes': return ((s.masses && s.masses.light && s.masses.light.contours) || []).map((p, i) => ({ kind: 'polygon', points: p, label: `light ${i + 1}` }));
    case 'landmarks': {
      const out = (sub.ellipses || []).slice(0, 4).map((e, i) => ({ kind: 'cross', center: e.center, size: 0.03, label: `landmark ${i + 1}` }));
      if (sub.focal) out.push({ kind: 'cross', center: sub.focal, size: 0.045, label: 'focal point' });
      return out;
    }
    default: return [];
  }
}

/* ---------- offline lesson templates (also the fallback when the API is unavailable) ---------- */
const A = (name) => ({ kind: 'auto', name });
const T = {
  sketch: [
    { phase: 'gesture', title: 'Find the whole shape', instruction: 'Lightly mark a box around the whole subject and a center line. Keep it faint — this is scaffolding, not drawing.', why: 'Placing the whole subject first keeps everything in proportion and on the page.', guides: [A('bbox'), A('center_axes')], brush: 'pencil', technique: 'gesture_drawing', tip: 'Squint at the reference: the whole thing should simplify into one big shape.', size_hint: 'medium' },
    { phase: 'construction', title: 'Block in the big shapes', instruction: 'Sketch the largest forms as simple ovals, one at a time. Ignore details for now.', why: 'Big simple shapes are easy to correct. Details stacked on a wrong shape are not.', guides: [A('construction_ellipses')], brush: 'pencil', technique: 'construction_shapes', tip: 'Draw each oval in one confident sweep, even if it is not perfect.', size_hint: 'medium' },
    { phase: 'contour', title: 'Connect with one outline', instruction: 'Link the shapes with a single flowing outline. Let your whole arm move, not just your wrist.', why: 'Long continuous lines look confident and are easier to keep smooth than many short ones.', guides: [A('contour')], brush: 'ink', technique: 'confident_linework', tip: 'Try one long stroke per curve instead of several tiny ones.', size_hint: 'small' },
    { phase: 'construction', title: 'Mark the openings', instruction: 'Inside the outline, sketch each dark opening (the purple shapes) with a simple closed shape.', why: 'Openings are easy to place and become the landmarks for everything else.', guides: [A('hollows')], brush: 'pencil', technique: 'landmarks', tip: 'Check each opening against its neighbours: is the gap between them about one opening wide?', size_hint: 'small' },
    { phase: 'landmarks', title: 'Check your landmarks', instruction: 'Compare the marked landmarks with your drawing. Are the key points in the same relative places?', why: 'Checking a few anchor points catches proportion problems early.', guides: [A('landmarks'), A('thirds')], brush: 'pencil', technique: 'proportion_checking', tip: 'Flip your canvas horizontally — mistakes jump out immediately.', size_hint: 'small' },
    { phase: 'detail', title: 'Add details last', instruction: 'Now add the inner details, working from larger to smaller. Stop when it reads clearly — you do not have to copy everything.', why: 'Details only look right when the structure under them is right.', guides: [A('edges')], brush: 'ink', technique: 'edge_hierarchy', tip: 'Make important edges darker and secondary ones lighter.', size_hint: 'small' },
  ],
  paint: [
    { phase: 'composition', title: 'Plan the composition', instruction: 'Look at where the big shapes sit. Lightly mark the main masses on your canvas using the grid as a guide.', why: 'Deciding placement first prevents running out of room later.', guides: [A('thirds'), A('bbox')], brush: 'pencil', technique: 'composition', tip: 'Squint until the image collapses into three big shapes.', size_hint: 'medium' },
    { phase: 'value', title: 'Three-value study', instruction: 'Fill the canvas with only three tones — dark, middle and light — following the map.', why: 'If the values are right, the color almost cannot go wrong; if they are wrong, no color will save it.', guides: [A('value3')], brush: 'marker', technique: 'value_grouping', tip: 'Group the darks into one connected shape before worrying about small variations.', size_hint: 'large' },
    { phase: 'underpainting', title: 'Lay down color masses', instruction: 'With a big brush, block in the major color areas using the palette. Work thin and loose.', why: 'A large brush stops you from chasing details too early.', guides: [A('masses')], brush: 'oil', technique: 'brush_economy', tip: 'Use a larger brush than feels comfortable for the first pass.', size_hint: 'large' },
    { phase: 'shadow', title: 'Shadow blocks', instruction: 'Fill the large dark regions as connected shapes using your shadow color.', why: 'Strong shadow shapes give the image its depth and form.', guides: [A('shadow_shapes')], brush: 'oil', technique: 'value_grouping', tip: 'Keep shadows slightly cooler and more transparent than lights.', size_hint: 'medium' },
    { phase: 'highlight', title: 'Midtones and highlights', instruction: 'Add the midtones, then place the brightest highlights only where the light is strongest.', why: 'Saving the brightest marks for last makes them read as light.', guides: [A('light_shapes')], brush: 'oil', technique: 'edge_hierarchy', tip: 'Highlights are most powerful when there are few of them.', size_hint: 'medium' },
    { phase: 'detail', title: 'Refine edges and details', instruction: 'Sharpen edges near the focal point and leave other edges soft. Add texture only where it helps.', why: 'Contrast in edge sharpness leads the viewer’s eye.', guides: [A('edges')], brush: 'ink', technique: 'edge_hierarchy', tip: 'Soft edges recede, sharp edges come forward.', size_hint: 'small' },
  ],
  style: [
    { phase: 'composition', title: 'Notice the shape language', instruction: 'Study the shapes the image keeps repeating — round, angular or long. Block them in simply.', why: 'Style is often a consistent choice of shapes, not extra detail.', guides: [A('construction_ellipses'), A('bbox')], brush: 'pencil', technique: 'shape_language', tip: 'Ask: which shape appears most often?', size_hint: 'medium' },
    { phase: 'value', title: 'Study the contrast', instruction: 'Block in light and dark masses and see how much contrast the image uses overall.', why: 'High or low contrast changes the whole mood of a piece.', guides: [A('value3')], brush: 'marker', technique: 'value_grouping', tip: 'Limit yourself to three tones.', size_hint: 'large' },
    { phase: 'underpainting', title: 'Limited palette', instruction: 'Paint the masses using only the swatches provided.', why: 'Fewer colors make a picture feel unified.', guides: [A('masses')], brush: 'oil', technique: 'color_harmony', tip: 'Warm lights and cool shadows are a classic harmony.', size_hint: 'large' },
    { phase: 'detail', title: 'Edge and texture choices', instruction: 'Decide where edges are soft or crisp, and add texture sparingly. Make the choice yours.', why: 'Your edge decisions are a big part of how a style feels.', guides: [A('edges')], brush: 'ink', technique: 'edge_hierarchy', tip: 'Deliberately differ from the reference somewhere — that is how a style becomes yours.', size_hint: 'small' },
  ],
  pixel: [
    { phase: 'composition', title: 'Set up the grid', instruction: 'Use the pixel grid to place the overall silhouette. Think in blocks, not lines.', why: 'A grid forces clear decisions about every pixel.', guides: [A('pixel_grid'), A('bbox')], brush: 'pixel', technique: 'pixel_grid', tip: 'Start with the silhouette only.', size_hint: 'medium' },
    { phase: 'contour', title: 'Silhouette first', instruction: 'Fill the outer shape in one dark color so it reads clearly even in solid black.', why: 'A strong silhouette is the backbone of readable pixel art.', guides: [A('contour')], brush: 'pixel', technique: 'silhouette', tip: 'Squint — can you still tell what it is?', size_hint: 'medium' },
    { phase: 'underpainting', title: 'Color clusters', instruction: 'Fill each area with its base color from the palette, using clean clusters instead of noise.', why: 'Clusters of the same color look intentional; scattered single pixels look messy.', guides: [A('masses')], brush: 'pixel', technique: 'color_clusters', tip: 'Limit yourself to the palette on the right.', size_hint: 'medium' },
    { phase: 'highlight', title: 'Highlights and shadows', instruction: 'Add one lighter and one darker shade, placed consistently from one light direction.', why: 'A single consistent light source makes small sprites feel solid.', guides: [A('light_shapes'), A('shadow_shapes')], brush: 'pixel', technique: 'value_grouping', tip: 'Decide where the light comes from before placing a highlight.', size_hint: 'small' },
  ],
  tonal: [
    { phase: 'gesture', title: 'Sketch the outline', instruction: 'Lightly sketch the outline of the whole subject, following the purple line. Press gently — this is scaffolding you will cover later.', why: 'The outline fixes the size, position and proportions of everything inside it, so mistakes are cheap to fix now.', guides: [A('silhouette')], brush: 'pencil', technique: 'contour_sketch', size_hint: 'medium', tip: 'Draw with your whole arm and keep the line faint; you can always darken it.' },
    { phase: 'construction', title: 'Mark the hollows', instruction: 'Inside your sketch, outline each dark opening (the purple shapes) — the deepest holes in the form, such as eye sockets and the nose.', why: 'Hollows are the easiest landmarks to place, and the other features are measured from them.', guides: [A('hollows')], brush: 'pencil', technique: 'landmarks', size_hint: 'small', tip: 'Compare the gap between hollows with the width of one hollow.' },
    { phase: 'value', title: 'Block in the darkest shapes', instruction: 'Fill the hollows with your darkest tone. Press firmly and keep inside the outlines.', why: 'Committing to the darkest darks early sets the contrast every other tone is measured against.', guides: [A('darkest_hollows')], brush: 'charcoal', technique: 'value_grouping', size_hint: 'small', tip: 'Squint at the reference — the darkest shapes will pop out.' },
    { phase: 'shadow', title: 'Shade the shadow side', instruction: 'Lay a medium-dark tone over the hatched shapes — the side of the form that turns away from the light. Keep the edges loose.', why: 'One connected shadow shape makes a form look solid; scattered dark patches make it look flat.', guides: [A('dark_regions')], brush: 'charcoal', technique: 'value_grouping', size_hint: 'large', tip: 'Use the side of the stick for a soft, wide stroke.' },
    { phase: 'midtone', title: 'Add the middle tones', instruction: 'Look at the three-value map and lay a lighter, thinner tone over the middle-gray areas. Leave the lightest areas untouched.', why: 'Most of an image lives in the middle tones; getting them right makes the shapes feel solid.', guides: [A('value3')], brush: 'charcoal', technique: 'value_grouping', size_hint: 'medium' },
    { phase: 'highlight', title: 'Lift out the lights', instruction: 'Use the eraser (or white) to pull light back out of the dotted shapes. Keep the edges crisp where light is strongest.', why: 'Lights look brightest next to deep darks, so save them for last.', guides: [A('light_regions')], brush: 'eraser', technique: 'edge_hierarchy', size_hint: 'small' },
    { phase: 'detail', title: 'Add the key details', instruction: 'Switch to the Edges view and add only the few details that make this picture recognisable — the strongest edges, working from large to small.', why: 'A handful of well-chosen details reads better than copying every line.', guides: [A('edges')], brush: 'pencil', technique: 'edge_hierarchy', size_hint: 'small', tip: 'Make the most important edges darkest; leave the rest soft.' },
    { phase: 'detail', title: 'Soften the shadow edges', instruction: 'Blend along the dotted edges so the shadow melts into the surface. Keep a few edges sharp for contrast.', why: 'Soft and sharp edges together create depth and lead the eye.', guides: [A('soften_edges')], brush: 'smudge', technique: 'edge_hierarchy', size_hint: 'medium', tip: 'Smudge in the direction of the form, not across it.' },
  ],
  free: [
    { phase: 'practice', title: 'Free practice', instruction: 'Draw on your own with no guides. Ask for a progress check whenever you want one.', why: 'Working without guides is how the skills become yours.', guides: [], brush: 'pencil', technique: 'free_practice', tip: 'Try a quick thumbnail first, then go bigger.', size_hint: 'medium' },
  ],
};

// "Sketch, then paint": a short underdrawing (axes → big shapes → outline → openings) followed by the value-first painting steps.
T.sketch_paint = [...T.sketch.slice(0, 4), ...T.paint.slice(1, 5), { ...T.paint[5], title: 'Refine edges and details', guides: [A('edges')] }];

export function pickStrategy({ mode = 'sketch', imageType = 'general', medium = '', monochrome = false }) {
  if (mode === 'free') return 'free';
  if ((mode === 'sketch' || mode === 'paint' || mode === 'sketch_paint') && monochrome && !['line_art', 'pixel_art', 'geometric', 'cartoon'].includes(imageType) && !/pixel/i.test(medium)) return 'tonal';
  if (imageType === 'pixel_art' || /pixel/i.test(medium)) return 'pixel';
  if (mode === 'style') return 'style';
  if (mode === 'sketch_paint') return 'sketch_paint';
  if (mode === 'paint') return 'paint';
  return 'sketch';
}

const MEDIUM_BRUSH = { watercolor: 'watercolor', ink: 'ink', graphite: 'pencil', 'graphite pencil': 'pencil', oil: 'oil', acrylic: 'oil', 'oil painting': 'oil', 'pixel art': 'pixel', pixel: 'pixel' };

export function buildLocalLesson({ mode = 'sketch', imageType = 'general', medium = 'digital sketching', level = 'beginner', goal = '', summary = null, construct = true, precise = true } = {}) {
  const key = pickStrategy({ mode, imageType, medium, monochrome: !!(summary && summary.stats && summary.stats.colorfulness < 14) });
  const mBrush = MEDIUM_BRUSH[String(medium).toLowerCase()];
  const empty = (s) => s.guides && s.guides.length && s.guides.every((g) => g.kind === 'auto' && !RASTER_AUTOS.has(g.name) && g.name !== 'thirds' && g.name !== 'pixel_grid' && !resolveGuide(g, summary).length);
  const hasForms = !!(wantsConstruct(mode, construct) && summary && summary.subject && summary.subject.forms && summary.subject.forms.length);
  const lines = !!precise && lineArtAvailable(summary), drawingKey = ['sketch', 'sketch_paint', 'tonal'].includes(key);
  // with real solids available, the generic box/oval warm-up steps are replaced by the measured "build it from simple shapes" step;
  // with a measured line-art trace, the old outline / hollow / edge-view steps of the drawing strategies are replaced by "Trace the main lines" (+ finer lines)
  const tpl = T[key].filter((s) => !(hasForms && ['gesture_drawing', 'construction_shapes'].includes(s.technique) && key !== 'tonal'))
    .filter((s) => !(lines && ['contour_sketch', 'confident_linework'].includes(s.technique)))
    .filter((s) => !(lines && (key === 'sketch' || key === 'sketch_paint') && (s.guides || []).some((g) => g.kind === 'auto' && g.name === 'hollows')))
    .filter((s) => !(lines && (key === 'sketch' || key === 'tonal') && s.phase === 'detail' && (s.guides || []).length === 1 && s.guides[0].name === 'edges'));
  const steps = tpl.filter((s) => !(summary && empty(s))).map((s, i) => {
    const st = { ...s, id: `step-${i + 1}`, completion: { kind: 'user_marks_done', tolerance: 'lenient' } };
    if (mBrush && ['underpainting', 'shadow', 'highlight', 'value'].includes(st.phase) && key !== 'pixel') st.brush = mBrush === 'pencil' ? st.brush : mBrush;
    return st;
  });
  const palette = (summary && summary.palette ? summary.palette : []).map((p) => ({ hex: p.hex.toUpperCase(), role: p.role, fraction_estimate: p.fraction }));
  const raw = {
    analysis: { image_type: imageType, medium, complexity: level === 'advanced' ? 'advanced' : level === 'intermediate' ? 'intermediate' : 'beginner', confidence: 0.35, uncertainties: ['Built offline from image statistics — no AI vision model was used'], summary: 'This is an offline starter lesson built from the image’s shapes, values and colors.' },
    learning_goal: goal || 'Break the image into large shapes before details',
    strategy: key === 'tonal' ? 'tonal_block_in' : key === 'sketch' ? 'constructive_drawing' : key === 'paint' ? 'value_first_painting' : key === 'sketch_paint' ? 'sketch_then_paint' : key,
    buddy_intro: 'Let’s start with the big shapes before worrying about details. I’ll keep my tips short — you’re the artist!',
    composition: { focal_point: summary && summary.subject ? summary.subject.focal : null, anchors: [], notes: '' },
    palette, steps,
  };
  const built = validateLesson(raw, { source: 'local', fallbackType: imageType, medium }).lesson;
  if (!built || !summary || mode === 'free') return built;
  return ensureSketch(built, summary, { mode, construct, precise }).lesson;
}

/* ---------- "a sketch is (almost) always established first": build-up shapes, then a precise trace ---------- */
export const SKETCH_PHASES = ['gesture', 'composition', 'construction', 'contour', 'landmarks'];
/** Styles that do not start from an outline: flat abstract compositions and grid-based pixel art (which has its own silhouette-first workflow). */
export const NO_SKETCH_TYPES = ['abstract', 'pixel_art'];
const OUTLINE_AUTOS = new Set(['silhouette', 'silhouette_precise', 'contour', 'contours', 'lineart_main']);
const FORM_AUTOS = new Set(['construction_forms', 'construction_stick', 'construction_ellipses']);
const LINEART_AUTOS = new Set(['lineart_main', 'lineart_fine']);
const early = (lesson, n = 3) => (lesson.steps || []).slice(0, n);
export const isFormGuide = (g) => g && (g.kind === 'form' || (g.kind === 'auto' && FORM_AUTOS.has(g.name)));
export const isLineArtGuide = (g) => g && g.kind === 'auto' && LINEART_AUTOS.has(g.name);
/** Shapes-first only applies to the two drawing modes. */
export const wantsConstruct = (mode, construct = true) => !!construct && (mode === 'sketch' || mode === 'sketch_paint');
/** Does the lesson build the subject from simple solids (spheres / boxes / cylinders / ovals) early on? */
export function hasConstructStep(lesson) { return early(lesson, 4).some((s) => (s.guides || []).some(isFormGuide)); }
/** Does the lesson have a traced outline / line-art step early on? */
export function hasOutlineStep(lesson) {
  return early(lesson, 5).some((s) => (s.guides || []).some((g) => (g.kind === 'auto' && OUTLINE_AUTOS.has(g.name)) || (g.kind === 'polygon' && (g.points || []).length >= 8)
    || (g.kind === 'feature' && g.expect === 'edge' && g.geom && g.geom.type === 'polygon' && g.geom.points.length >= 8)));
}
export const hasLineArtStep = (lesson) => (lesson.steps || []).some((s) => (s.guides || []).some(isLineArtGuide));
export function hasSketchStep(lesson) {
  return (lesson.steps || []).slice(0, 3).some((s) => SKETCH_PHASES.includes(s.phase) && (s.guides || []).some((g) => ['polygon', 'polyline', 'ellipse', 'feature', 'form', 'strokes'].includes(g.kind) || (g.kind === 'auto' && (OUTLINE_AUTOS.has(g.name) || FORM_AUTOS.has(g.name) || g.name === 'hollows'))));
}
/** Is a measured line-art trace available for this picture? */
export const lineArtAvailable = (summary) => !!(summary && summary.lineart && summary.lineart.strokes && summary.lineart.strokes.length >= 3);
const countWord = (forms) => {
  const c = {}; forms.forEach((f) => { c[f.shape] = (c[f.shape] || 0) + 1; });
  return Object.entries(c).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(', ');
};
export function constructStep(summary, subjectName = 'subject') {
  const forms = (summary && summary.subject && summary.subject.forms) || [];
  if (!forms.length) return [];
  const base = { phase: 'gesture', layer: 'scaffold', unanchored: false, tool_hint: '', brush: 'pencil', size_hint: 'medium', completion: { kind: 'user_marks_done', tolerance: 'lenient' } };
  const out = [];
  if (summary.subject.axis || forms.some((f) => f.shape === 'cylinder')) out.push({
    ...base, id: 'construct-0', title: 'Find the line of action and stick figure',
    instruction: `Start with one flowing line through the whole ${subjectName} (the line of action), then add a single straight line for each long part, like a stick figure. Use the purple guide lines to see where they go.`,
    why: 'A stick figure fixes the pose, the tilt and the length of each part before anything gets thick, so the proportions are settled early.',
    tip: 'Keep every line faint and quick; these are only the bones of the drawing.',
    guides: [{ kind: 'auto', name: 'construction_stick', label: '' }], technique: 'construction_stick',
  });
  out.push({
    ...base, id: 'construct-1', title: 'Build it from simple shapes',
    instruction: `Now put simple solid shapes (${countWord(forms)}) around the stick figure, biggest first. Draw each as a light 3D shape, following the purple guides.`,
    why: 'Seeing a complicated subject as spheres, boxes and cylinders gives you its size and proportions, and you can measure the final drawing against these shapes.',
    tip: 'Sphere = circle plus a curved equator. Box = a front face and a back face joined at the corners. Cylinder = two ovals joined by two lines. Keep every line faint.',
    guides: [{ kind: 'auto', name: 'construction_forms', label: '' }], technique: 'construction_forms',
  });
  return out;
}
/** The line-art steps: "Trace the main lines" (+ "Add the finer lines" for the drawing modes). The lines are measured from the picture, like tracing paper over it. */
export function lineArtSteps(summary, { mode = 'sketch' } = {}) {
  if (!lineArtAvailable(summary)) return [];
  const la = summary.lineart, fine = la.strokes.length - la.main, drawing = mode === 'sketch', phase = drawing ? 'contour' : 'gesture', layer = drawing ? 'art' : 'scaffold';
  const out = [{
    id: 'lineart-0', title: 'Follow the main lines', phase, layer, unanchored: false,
    instruction: 'Now that the shapes are in, follow the purple guide lines — the main lines of the picture — keeping them light and following every curve, including the small lines that stick out. They are a guide, so small differences are fine.',
    why: 'These lines are what is left when you take the colour away. Following them gives you the final drawing, and you can use your stick figure and shapes to check the proportions.',
    tip: 'Move your whole arm, one stroke at a time, and lift the pencil between strokes.',
    guides: [{ kind: 'auto', name: 'lineart_main', label: '' }], tool_hint: '', brush: drawing ? 'ink' : 'pencil', size_hint: 'small', technique: 'trace_line_art', completion: { kind: 'user_marks_done', tolerance: 'lenient' },
  }];
  if (fine >= 6 && (mode === 'sketch' || mode === 'sketch_paint')) out.push({
    id: 'lineart-1', title: 'Add the finer lines', phase, layer, unanchored: false,
    instruction: 'Now add the finer lines — the thinner purple strokes — the small details that make the picture feel finished.',
    why: 'Fine lines go in last so they sit on top of a correct structure instead of fighting it.',
    tip: 'Press lighter than for the main lines; these are the quiet details.',
    guides: [{ kind: 'auto', name: 'lineart_fine', label: '' }], tool_hint: '', brush: drawing ? 'ink' : 'pencil', size_hint: 'small', technique: 'trace_line_art', completion: { kind: 'user_marks_done', tolerance: 'lenient' },
  });
  return out;
}
/**
 * Guarantee the early drawing stages. Order: (1) [sketch / sketch→paint only] build the subject from simple solids, (2) trace the LINE ART
 * of the picture — what is left when colour is removed (whiskers and all), not a silhouette — then the lesson's own steps.
 * Everything is measured from the picture, so it is always placed on real pixels. Returns {lesson, added}.
 * No-ops for free practice, abstract / pixel art, or when the tutor already planned those stages.
 * opts: mode, construct (default true; only used for sketch / sketch_paint), precise = trace the line art (default true; off → rough silhouette).
 */
export function ensureSketch(lesson, summary, { mode = 'sketch', construct = true, precise = true } = {}) {
  if (!lesson || !Array.isArray(lesson.steps) || mode === 'free') return { lesson, added: false };
  if (NO_SKETCH_TYPES.includes(lesson.analysis && lesson.analysis.image_type) || lesson.strategy === 'pixel') return { lesson, added: false };
  const out = JSON.parse(JSON.stringify(lesson)); let changed = false;
  const what = (out.analysis && out.analysis.subject) || 'subject', wantC = wantsConstruct(mode, construct), useLines = !!precise && lineArtAvailable(summary);
  // 1. tutor outlines (polygons / silhouette autos) become the measured line-art trace
  if (useLines) {
    const isOutlineGuide = (g) => (g.kind === 'auto' && ['silhouette', 'silhouette_precise', 'contour', 'contours', 'lineart_main'].includes(g.name)) || (g.kind === 'feature' && g.expect === 'edge' && g.geom && g.geom.type === 'polygon' && g.geom.points.length >= 8);
    const idx = early(out, 5).findIndex((st) => (st.guides || []).some(isOutlineGuide));
    if (idx >= 0) {
      const st = out.steps[idx], only = (st.guides || []).every(isOutlineGuide);
      if (!(st.guides || []).some((g) => g.kind === 'auto' && g.name === 'lineart_main')) {
        if (only) { out.steps.splice(idx, 1, ...lineArtSteps(summary, { mode })); changed = true; }
        else { st.guides = st.guides.map((g) => (isOutlineGuide(g) ? { kind: 'auto', name: 'lineart_main', label: '' } : g)); changed = true; }
      }
    }
  }
  if (!hasOutlineStep(out)) {
    const steps = useLines ? lineArtSteps(summary, { mode }) : resolveGuide({ kind: 'auto', name: 'silhouette' }, summary).length ? [{
      id: 'sketch-0', title: 'Follow the outline', phase: 'gesture', layer: 'scaffold', unanchored: false,
      instruction: `Lightly draw the outline of the ${what}, following the purple guide line. Press gently — this is scaffolding you will cover later, and it is only a guide.`,
      why: 'Fixing the outline first keeps the size and proportions right before you commit to tone or color.', tip: 'Draw with your whole arm and keep the line faint.',
      guides: [{ kind: 'auto', name: 'silhouette', label: '' }], tool_hint: '', brush: 'pencil', size_hint: 'medium', technique: 'contour_sketch', completion: { kind: 'user_marks_done', tolerance: 'lenient' },
    }] : [];
    if (steps.length) { const ci = early(out, 4).findIndex((st) => (st.guides || []).some(isFormGuide)); out.steps.splice(ci >= 0 ? ci + 1 : 0, 0, ...steps); changed = true; }
  }
  // 2. shapes first (sketch / sketch→paint only)
  if (wantC && !hasConstructStep(out)) {
    const cs = constructStep(summary, what);
    if (cs.length) { out.steps.unshift(...cs); changed = true; }
    else if (out.source === 'local' && out.analysis) { // honest about it instead of inventing shapes that do not fit
      const note = 'Shapes-first step needs the AI tutor for this picture: the subject could not be separated cleanly enough to fit boxes, cylinders and spheres offline';
      if (!(out.analysis.uncertainties || []).includes(note)) { out.analysis.uncertainties = [...(out.analysis.uncertainties || []), note].slice(0, 5); changed = true; }
    }
  }
  // 3. order: stick figure → simple shapes → line art. Shapes a tutor placed after the line art move in front of it.
  if (wantC) {
    const isLine = (st) => (st.guides || []).some((g) => isLineArtGuide(g) || (g.kind === 'auto' && OUTLINE_AUTOS.has(g.name)));
    const onlyForms = (st) => (st.guides || []).length > 0 && st.guides.every(isFormGuide);
    const li = out.steps.findIndex(isLine);
    if (li >= 0 && out.steps.some((st, j) => j > li && onlyForms(st))) {
      const late = out.steps.filter((st, j) => j > li && onlyForms(st)), keep = out.steps.filter((st, j) => !(j > li && onlyForms(st)));
      const at = keep.findIndex(isLine); keep.splice(at, 0, ...late); out.steps = keep; changed = true;
    }
    // stick figure goes ahead of the solids
    const si = out.steps.findIndex((st) => (st.guides || []).some((g) => g.kind === 'auto' && g.name === 'construction_stick')), fi = out.steps.findIndex((st) => (st.guides || []).some((g) => g.kind === 'auto' && g.name === 'construction_forms'));
    if (si > fi && fi >= 0) { const [st] = out.steps.splice(si, 1); out.steps.splice(fi, 0, st); changed = true; }
  }
  if (hasLineArtStep(out)) out.trace_precise = true;
  out.build_up = { construct_requested: wantC && (hasConstructStep(out) || out.source !== 'local'), precise_requested: !!precise && useLines };
  if (changed) out.sketch_added = true;
  return { lesson: out, added: changed };
}
