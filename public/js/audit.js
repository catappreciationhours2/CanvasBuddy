// audit.js — the "Audit Agent". It does NOT trust the tutor. For every step it resolves the guides the tutor produced,
// rasterises them on the image's own pixel maps, and checks the claims against evidence:
//   • "this is a dark eye socket"  → is the marked area really darker than its surroundings?
//   • "soften this edge"           → is there really an edge there?
//   • "frame the whole picture"    → rejected;  "draw the teeth" with nothing marked → unanchored;
//   • does the instruction text actually point at the markers it ships with?  does it carry injected instructions?
// Steps that fail are flagged "unverified / possibly manipulated" and can be repaired locally or re-requested.
import { resolveGuide } from './lesson.js';
import { makeMask, rasterizePrimitive } from './artist.js';
import { dilate } from './construct.js';
import { detectInjection } from './guard.js';

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

function maskStats(mask, maps) {
  const { w, h, gray, edges } = maps; let n = 0, g = 0, e = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) { n++; g += gray[i]; e += edges[i] ? 1 : 0; }
  return { n, gray: n ? g / n : 0, edge: n ? e / n : 0 };
}

/** Evaluate one resolved target primitive against the pixel evidence. */
export function auditTarget(p, maps, globals) {
  const { w, h } = maps, fill = makeMask(w, h);
  rasterizePrimitive(fill, w, h, p, 'fill');
  const area = maskStats(fill, maps).n / (w * h);
  if (area < 0.0008) return { label: p.label, ok: false, detail: 'marker is smaller than a few pixels' };
  if (area > 0.65) return { label: p.label, ok: false, detail: 'marker covers most of the picture' };
  const ringR = Math.max(2, Math.round(w * 0.035)), grown = dilate(fill, w, h, ringR), ring = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ring[i] = grown[i] && !fill[i] ? 1 : 0;
  const inside = maskStats(fill, maps), around = maskStats(ring, maps);
  const wantsEdge = p.expect === 'edge' || p.action === 'blend_edges';
  const want = wantsEdge ? 'edge' : p.expect === 'dark' || ['darkest', 'dark'].includes(p.tone) ? 'dark' : p.expect === 'light' || ['light', 'highlight'].includes(p.tone) ? 'light' : 'any';
  if (want === 'dark') {
    const ok = inside.gray < around.gray - 5 || inside.gray < globals.gray - 14;
    return { label: p.label, ok, want, detail: ok ? `darker than its surroundings (${Math.round(inside.gray)} vs ${Math.round(around.gray)})` : `not darker than the area around it (${Math.round(inside.gray)} vs ${Math.round(around.gray)})` };
  }
  if (want === 'light') {
    const ok = inside.gray > around.gray + 5 || inside.gray > globals.gray + 14;
    return { label: p.label, ok, want, detail: ok ? `lighter than its surroundings (${Math.round(inside.gray)} vs ${Math.round(around.gray)})` : `not lighter than the area around it (${Math.round(inside.gray)} vs ${Math.round(around.gray)})` };
  }
  if (want === 'edge') { // look for edge pixels near the marker's outline
    const outline = makeMask(w, h); rasterizePrimitive(outline, w, h, p, 'outline', 2);
    const band = dilate(outline, w, h, Math.max(2, Math.round(w * 0.025))), s = maskStats(band, maps);
    const ok = s.edge >= Math.max(0.03, globals.edge * 1.1);
    return { label: p.label, ok, want, detail: ok ? 'a real edge runs along this marker' : 'no clear edge found along this marker' };
  }
  return { label: p.label, ok: true, want, detail: 'placed inside the picture with a sensible size' };
}

/** A construction solid is plausible when its volume lies over the measured subject (not over empty background) and is a sensible size. */
function auditForm(label, bodies, maps) {
  const { w, h } = maps, fill = makeMask(w, h);
  for (const p of bodies) rasterizePrimitive(fill, w, h, p, 'fill');
  let n = 0; for (let i = 0; i < w * h; i++) n += fill[i];
  if (n / (w * h) < 0.0008) return { label, ok: false, detail: 'solid is smaller than a few pixels' };
  if (n / (w * h) > 0.65) return { label, ok: false, detail: 'solid covers most of the picture' };
  const near = dilate(maps.mask, w, h, Math.max(2, Math.round(w * 0.03))); let on = 0; for (let i = 0; i < w * h; i++) if (fill[i] && near[i]) on++;
  const share = on / n, ok = share >= 0.55;
  return { label, ok, want: 'subject', detail: ok ? `lies over the subject (${Math.round(share * 100)}% of it)` : `mostly over empty background (${Math.round(share * 100)}% on the subject)` };
}

const FRAME_AREA = 0.7;
const pointsAtTarget = (instruction, targets) => {
  const t = String(instruction || '').toLowerCase();
  if (!targets.length) return true;
  if (/[①-⑨]|\b(?:shape|shapes|target|targets|marker|markers|number|numbered|mark)\s*\d|\b\d\s*(?:–|-|to|and)\s*\d\b/.test(t)) return true;
  return targets.some((x) => String(x.label || '').toLowerCase().split(/[^a-z]+/).filter((wd) => wd.length > 3).some((wd) => t.includes(wd)));
};

/** Audit a whole lesson. Never throws. */
export function auditLesson(lesson, summary, maps) {
  const gAll = maskStats(Uint8Array.from({ length: maps.w * maps.h }, () => 1), maps), globals = { gray: gAll.gray, edge: gAll.edge };
  const steps = (lesson.steps || []).map((st) => {
    const issues = [], targets = [];
    let prims = []; try { prims = (st.guides || []).flatMap((g) => resolveGuide(g, summary)); } catch { issues.push('guides could not be resolved'); }
    const measured = (st.guides || []).some((g) => g.kind === 'auto') && prims.length > 0; // auto guides are computed from the pixels themselves
    const rawGeom = (st.guides || []).flatMap((g) => (g.kind === 'ellipse' || g.kind === 'polygon' ? resolveGuide(g, summary) : []));
    for (const p of rawGeom) { try { targets.push(auditTarget({ ...p, label: p.label || 'shape' }, maps, globals)); } catch { targets.push({ label: p.label || 'shape', ok: false, detail: 'geometry could not be checked' }); } }
    for (const p of prims) {
      if (p.kind === 'rect' && p.w * p.h > FRAME_AREA) issues.push('a box frames almost the whole picture');
      if (p.role) { try { targets.push(auditTarget(p, maps, globals)); } catch { targets.push({ label: p.label, ok: false, detail: 'geometry could not be checked' }); } }
    }
    { const groups = {}; for (const p of prims) if (p.construct && p.body) (groups[p.form] ||= []).push(p);
      for (const [label, ps] of Object.entries(groups)) { try { targets.push(auditForm(label, ps, maps)); } catch { targets.push({ label, ok: false, detail: 'geometry could not be checked' }); } } }
    if (detectInjection(`${st.title} ${st.instruction} ${st.why} ${st.tip}`).length) issues.push('step text contains instruction-like or link content');
    const rasterOk = prims.some((p) => p.kind === 'raster' || p.kind === 'grid');
    if (!targets.length && !rasterOk && st.phase !== 'practice' && !prims.length) issues.push('step asks for something but marks nothing on the canvas');
    if (targets.length && !pointsAtTarget(st.instruction, targets)) issues.push('instruction does not refer to its markers');
    const okShare = targets.length ? targets.filter((t) => t.ok).length / targets.length : rasterOk || measured ? 0.9 : st.phase === 'practice' ? 1 : 0;
    const score = Math.max(0, okShare * (issues.length ? 0.75 : 1) - 0.1 * (issues.length > 1 ? 1 : 0));
    const status = score >= 0.7 && !issues.some((i) => /instruction-like|frames almost/.test(i)) ? 'verified' : score >= 0.4 ? 'weak' : 'unverified';
    return { id: st.id, title: st.title, status, score: +score.toFixed(2), targets, issues };
  });
  const overall = mean(steps.map((s) => s.score));
  const feedback = [];
  for (const s of steps) {
    for (const t of s.targets) if (!t.ok) feedback.push(`Step "${s.title}": "${t.label}" ${t.detail}`);
    for (const i of s.issues) feedback.push(`Step "${s.title}": ${i}`);
  }
  return { steps, overall: +overall.toFixed(2), verified: steps.filter((s) => s.status === 'verified').length, unverified: steps.filter((s) => s.status === 'unverified').length, weak: steps.filter((s) => s.status === 'weak').length, feedback: feedback.slice(0, 8) };
}

const bboxOfPrim = (p) => {
  if (p.kind === 'ellipse') return [p.center[0] - p.radius[0], p.center[1] - p.radius[1], p.center[0] + p.radius[0], p.center[1] + p.radius[1]];
  const xs = p.points.map((q) => q[0]), ys = p.points.map((q) => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

/**
 * Cheap local repair: a failing feature/shade that sits NEAR a measured region of the right tone is re-attached
 * (snapped) to that region. Everything else stays unverified. Returns {lesson, repaired}.
 */
export function repairLesson(lesson, summary, report) {
  let repaired = 0; const regions = summary.regions || [];
  const out = JSON.parse(JSON.stringify(lesson));
  out.steps.forEach((st, si) => {
    const rep = report.steps[si]; if (!rep) return;
    (st.guides || []).forEach((g) => {
      if ((g.kind !== 'feature' && g.kind !== 'shade') || g.snap) return;
      const prim = resolveGuide(g, summary)[0]; if (!prim) return;
      const t = rep.targets.find((x) => x.label === g.label); if (!t || t.ok || !t.want || !['dark', 'light'].includes(t.want)) return;
      const bb = bboxOfPrim(prim), cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2, sz = (bb[2] - bb[0]) * (bb[3] - bb[1]);
      let best = null, bd = 0.18;
      for (const r of regions) {
        if (r.tone !== t.want) continue;
        const ra = (r.bbox[2] - r.bbox[0]) * (r.bbox[3] - r.bbox[1]); if (ra / Math.max(sz, 1e-6) > 4 || ra / Math.max(sz, 1e-6) < 0.25) continue;
        const d = Math.hypot(r.centroid[0] - cx, r.centroid[1] - cy); if (d < bd) { bd = d; best = r; }
      }
      if (best) { g.snap = best.id; repaired++; }
    });
  });
  return { lesson: out, repaired };
}
