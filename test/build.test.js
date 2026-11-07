// Build-up (construction solids) + precise outline trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLocal, fitForms } from '../public/js/construct.js';
import { buildLocalLesson, validateLesson, resolveGuide, ensureSketch, normalizeGuide, formPrims, hasConstructStep, hasLineArtStep, wantsConstruct } from '../public/js/lesson.js';
import { auditLesson } from '../public/js/audit.js';
import { perfectArtistReport } from '../public/js/artist.js';

const W = 192, H = 288;
/** a stick-person: head disc, neck, torso block, two arms, two legs — dark on a light page */
function figure() {
  const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
  const put = (x, y) => { const i = (y * W + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 60; };
  const rect = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - 96) ** 2 + (y - 40) ** 2 <= 22 * 22) put(x, y);
  rect(88, 60, 104, 70); rect(66, 70, 126, 150); rect(30, 72, 66, 84); rect(126, 72, 162, 84); rect(72, 150, 92, 260); rect(100, 150, 120, 260);
  return rgba;
}
const mask = () => { const m = new Uint8Array(W * H); const g = figure(); for (let i = 0; i < W * H; i++) m[i] = g[i * 4] < 128 ? 1 : 0; return m; };

test('fitForms: a figure becomes a sphere (head), a box (torso) and cylinders (limbs), plus a line of action', () => {
  const { forms, axis } = fitForms(mask(), W, H);
  const kinds = forms.map((f) => f.shape);
  assert.ok(kinds.includes('sphere') && kinds.includes('box') && kinds.filter((k) => k === 'cylinder').length >= 3, kinds.join());
  assert.ok(axis && axis.from && axis.to, 'line of action');
  const head = forms.find((f) => f.shape === 'sphere'); assert.ok(Math.abs(head.center[0] - 0.5) < 0.06 && head.center[1] < 0.25, 'head sphere sits at the top');
  const box = forms.find((f) => f.shape === 'box'); assert.ok(Math.abs(box.rotation) <= 45);
});

test('form guides validate, expand to 3D primitives, and reject nonsense', () => {
  const sph = normalizeGuide({ kind: 'form', shape: 'sphere', label: 'head sphere', center: [0.5, 0.2], radius: 0.08 });
  const cyl = normalizeGuide({ kind: 'form', shape: 'cylinder', label: 'arm cylinder', from: [0.2, 0.3], to: [0.4, 0.5], radius: 0.04 });
  const box = normalizeGuide({ kind: 'form', shape: 'box', label: 'torso box', box: [0.35, 0.3, 0.65, 0.55], rotation: -8 });
  for (const g of [sph, cyl, box]) assert.ok(g && g.kind === 'form');
  const sum = { width: 200, height: 300 };
  const ps = resolveGuide(sph, sum); assert.equal(ps.length, 2); assert.ok(Math.abs(ps[0].radius[0] * 200 - ps[0].radius[1] * 300) < 1e-6, 'a single-number radius is a true circle in pixels');
  assert.equal(resolveGuide(box, sum).filter((p) => p.kind === 'polygon').length, 2, 'front + back face');
  assert.ok(resolveGuide(cyl, sum).some((p) => p.kind === 'ellipse') && resolveGuide(cyl, sum).every((p) => p.construct));
  assert.equal(normalizeGuide({ kind: 'form', shape: 'pyramid', label: 'x' }), null);
  assert.equal(normalizeGuide({ kind: 'form', shape: 'sphere', label: 'whole', center: [0.5, 0.5], radius: 0.49 }), null, 'covering the whole picture is refused');
  assert.ok(formPrims({ shape: 'cylinder', from: [0.2, 0.3], to: [0.2, 0.3], radius: 0.04, label: 'x' }).length === 0, 'degenerate cylinder');
});

test('shapes-first only in sketch and sketch→paint; every mode traces the line art', () => {
  const { summary } = analyzeLocal(figure(), W, H);
  for (const mode of ['sketch', 'sketch_paint', 'paint']) {
    const l = buildLocalLesson({ mode, imageType: 'general', summary });
    assert.equal(hasConstructStep(l), wantsConstruct(mode, true), `${mode}: construction only in the sketch modes`);
    assert.ok(hasLineArtStep(l), `${mode}: line-art trace`);
    assert.ok(!JSON.stringify(l).includes('silhouette_precise'), `${mode}: no outline-polygon step`);
    if (wantsConstruct(mode, true)) {
      const names = l.steps.flatMap((s, i) => (s.guides || []).filter((g) => g.kind === 'auto').map((g) => [i, g.name]));
      assert.ok(names.find(([, n]) => n === 'construction_forms')[0] < names.find(([, n]) => n === 'lineart_main')[0], `${mode}: solids before line art`);
    }
  }
  assert.equal(wantsConstruct('paint', true), false); assert.equal(wantsConstruct('sketch', false), false);
});

test('the line-art guide resolves to one strokes primitive of real stroke polylines, and can be switched off', () => {
  const { summary } = analyzeLocal(figure(), W, H);
  const ps = resolveGuide({ kind: 'auto', name: 'lineart_main' }, summary);
  assert.equal(ps.length, 1); assert.equal(ps[0].kind, 'strokes'); assert.ok(ps[0].paths.length >= 3 && ps[0].paths.every((p) => p.length >= 2));
  const l = buildLocalLesson({ mode: 'sketch', imageType: 'general', summary, construct: false, precise: false });
  assert.equal(hasConstructStep(l), false); assert.equal(hasLineArtStep(l), false);
});

test('a tutor lesson that plans its own outline is left alone; one without any line art gets the measured trace', () => {
  const { summary } = analyzeLocal(figure(), W, H);
  const raw = { analysis: { image_type: 'general', subject: 'figure' }, steps: [{ title: 'Shade', phase: 'value', instruction: 'Shade the dark parts.', why: 'x', guides: [] }] };
  const { lesson } = validateLesson(raw, { source: 'ai' });
  const r = ensureSketch(lesson, summary, { mode: 'sketch', construct: false });
  assert.ok(r.added && hasLineArtStep(r.lesson));
  assert.equal(ensureSketch(r.lesson, summary, { mode: 'sketch', construct: false }).added, false, 'idempotent');
});

test('audit: solids over the subject pass; solids over empty background fail', () => {
  const { summary, maps } = analyzeLocal(figure(), W, H);
  const good = buildLocalLesson({ mode: 'sketch', imageType: 'general', summary });
  const a = auditLesson(good, summary, maps); const ci = good.steps.findIndex((s) => s.guides.some((g) => g.name === 'construction_forms'));
  assert.ok(a.steps[ci].targets.length >= 3 && a.steps[ci].targets.every((t) => t.ok), JSON.stringify(a.steps[ci].targets));
  const bad = { ...good, steps: [{ ...good.steps[ci], guides: [normalizeGuide({ kind: 'form', shape: 'sphere', label: 'floating sphere', center: [0.1, 0.9], radius: 0.06 })] }] };
  const b = auditLesson(bad, summary, maps); assert.equal(b.steps[0].targets[0].ok, false);
});

test('Perfect Artist: build-up checks pass for the measured lesson and fail when solids are missing or misplaced', () => {
  const { summary, maps } = analyzeLocal(figure(), W, H);
  const target = { fill: maps.mask, maps, approx: summary.subject.method === 'edges' }, run = (lesson) => perfectArtistReport({ lesson, resolve: (g) => resolveGuide(g, summary), target, W, H });
  const lesson = buildLocalLesson({ mode: 'sketch', imageType: 'general', summary });
  const r = run(lesson), by = (r2, n) => r2.checks.find((c) => c.name.startsWith(n));
  for (const n of ['Subject is built up', 'Solids sit on', 'Solids cover', 'Solids come before', 'Line art is traced']) assert.ok(by(r, n) && by(r, n).pass, `${n}: ${JSON.stringify(by(r, n))}`);
  const noForms = { ...lesson, steps: lesson.steps.filter((s) => !s.guides.some((g) => g.name === 'construction_forms')) };
  assert.equal(by(run(noForms), 'Subject is built up').pass, false);
  const lost = { ...lesson, steps: lesson.steps.map((s) => (s.guides.some((g) => g.name === 'construction_forms') ? { ...s, guides: [normalizeGuide({ kind: 'form', shape: 'box', label: 'stray box', box: [0.02, 0.02, 0.2, 0.15] })] } : s)) };
  assert.equal(by(run(lost), 'Solids sit on').pass, false);
  assert.ok(r.sim.final.sketch.some((v) => v) , 'sketch lines still drawn');
});

test('construction lines never count as silhouette or as "sketch lines on real edges"', () => {
  const { summary, maps } = analyzeLocal(figure(), W, H);
  const lesson = buildLocalLesson({ mode: 'sketch', imageType: 'general', summary });
  const r = perfectArtistReport({ lesson, resolve: (g) => resolveGuide(g, summary), target: { fill: maps.mask, maps }, W, H });
  assert.ok(!r.checks.some((c) => c.name === 'Silhouette IoU'), 'no silhouette fill exists, so no silhouette score');
  const edgeCheck = r.checks.find((c) => c.name.startsWith('Sketch lines sit'));
  assert.ok(edgeCheck && edgeCheck.value > 0.6, JSON.stringify(edgeCheck));
});

test('an AI-style lesson with form guides validates, audits and survives ensureSketch unchanged', () => {
  const { summary, maps } = analyzeLocal(figure(), W, H);
  const raw = { analysis: { image_type: 'general', subject: 'standing figure' }, steps: [
    { title: 'Build it from simple forms', phase: 'gesture', instruction: 'Block in the head sphere, torso box and leg cylinders, then the line of action.', why: 'Forms first.', guides: [
      { kind: 'form', shape: 'sphere', label: 'head sphere', center: [0.5, 0.14], radius: 0.115 },
      { kind: 'form', shape: 'box', label: 'torso box', box: [0.34, 0.24, 0.66, 0.52] },
      { kind: 'form', shape: 'cylinder', label: 'left leg cylinder', from: [0.43, 0.53], to: [0.43, 0.9], radius: 0.055 },
      { kind: 'form', shape: 'axis', label: 'line of action', from: [0.5, 0.07], to: [0.5, 0.9] }] },
    { title: 'Trace the main lines', phase: 'contour', instruction: 'Trace the main lines of the figure.', why: 'Line art.', guides: [{ kind: 'auto', name: 'lineart_main' }] }] };
  const { lesson } = validateLesson(raw, { source: 'ai' });
  assert.equal(lesson.steps[0].guides.length, 4);
  const r = ensureSketch(lesson, summary, { mode: 'sketch' });
  assert.equal(r.lesson.steps.length, 2, 'nothing added: it already builds from solids and traces the line art');
  const a = auditLesson(r.lesson, summary, maps);
  assert.ok(a.steps[0].targets.length === 3 && a.steps[0].targets.every((t) => t.ok), JSON.stringify(a.steps[0].targets));
  assert.equal(a.steps[0].status, 'verified');
  assert.equal(ensureSketch(r.lesson, summary).added, false, 'idempotent');
});

test('line art: whiskers, inner lines and details are kept, and a vignetted blank page produces no phantom lines', async () => {
  const { extractLineArt, thin } = await import('../public/js/lineart.js');
  const w = 200, h = 200, g = new Float32Array(w * h).fill(235);
  const line = (x0, y0, x1, y1) => { const n = 400; for (let i = 0; i <= n; i++) { const x = Math.round(x0 + ((x1 - x0) * i) / n), y = Math.round(y0 + ((y1 - y0) * i) / n); for (let d = 0; d < 2; d++) g[(y + d) * w + x] = 30; } };
  for (let a = 0; a < 720; a++) { const t = (a / 720) * 6.2832; const x = Math.round(100 + 40 * Math.cos(t)), y = Math.round(110 + 36 * Math.sin(t)); g[y * w + x] = g[y * w + x + 1] = g[(y + 1) * w + x] = 30; }
  line(10, 100, 62, 108); line(10, 120, 62, 114); line(190, 100, 138, 108); line(190, 120, 138, 114); // whiskers beyond the head
  const la = extractLineArt(g, w, h, {});
  const pts = la.strokes.flat();
  assert.ok(pts.some(([x]) => x < 0.12) && pts.some(([x]) => x > 0.88), 'whiskers far outside the head outline are present');
  assert.ok(la.strokes.length >= 5, `strokes ${la.strokes.length}`);
  const blank = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) blank[y * w + x] = 240 - 60 * (((x - 100) ** 2 + (y - 100) ** 2) / 20000);
  assert.equal(extractLineArt(blank, w, h, {}).strokes.length, 0, 'a smooth vignette has no lines');
  assert.equal(typeof thin, 'function');
});

test('order is stick figure → simple shapes → line art, even when a tutor puts the limbs after the line art', () => {
  const { summary } = analyzeLocal(figure(), W, H);
  const names = (l) => l.steps.map((s) => (s.guides || []).map((g) => g.name || (g.kind === 'form' ? `form:${g.shape}` : g.kind)).join('+'));
  const l = buildLocalLesson({ mode: 'sketch', imageType: 'general', summary });
  const n = names(l), iStick = n.findIndex((x) => x.includes('construction_stick')), iForms = n.findIndex((x) => x.includes('construction_forms')), iLine = n.findIndex((x) => x.includes('lineart_main'));
  assert.ok(iStick >= 0 && iStick < iForms && iForms < iLine, n.join(' | '));
  assert.ok(resolveGuide({ kind: 'auto', name: 'construction_stick' }, summary).length >= 2, 'line of action plus limb centre lines');
  const raw = { analysis: { image_type: 'general', subject: 'figure' }, steps: [
    { title: 'Follow the lines', phase: 'contour', instruction: 'Follow the main lines.', why: 'x', guides: [{ kind: 'auto', name: 'lineart_main' }] },
    { title: 'Add the limbs', phase: 'gesture', instruction: 'Add the leg cylinders.', why: 'x', guides: [{ kind: 'form', shape: 'cylinder', label: 'left leg cylinder', from: [0.43, 0.53], to: [0.43, 0.9], radius: 0.055 }] }] };
  const r = ensureSketch(validateLesson(raw, { source: 'ai' }).lesson, summary, { mode: 'sketch' }).lesson;
  const m = names(r), a = m.findIndex((x) => x.startsWith('form:')), b = m.findIndex((x) => x.includes('lineart_main'));
  assert.ok(a >= 0 && a < b, `limbs before line art: ${m.join(' | ')}`);
  const p = buildLocalLesson({ mode: 'paint', imageType: 'general', summary });
  assert.ok(!hasConstructStep(p), 'no shapes in paint mode');
});
