import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLocal } from '../public/js/construct.js';
import { buildLocalLesson, validateLesson, resolveGuide, ensureSketch, hasSketchStep, normalizeGuide } from '../public/js/lesson.js';
import { perfectArtistReport } from '../public/js/artist.js';
import { blobPainting } from './helpers.js';

const W = 160, H = 160;
/** grey disc on a light page with two dark enclosed openings — a stand-in for "a skull on paper". */
function discWithHollows() {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, d = Math.hypot(x - 80, y - 80); let v = 232;
    if (d < 58) v = 128 + ((x * 7 + y * 3) % 11);
    if (Math.hypot(x - 62, y - 70) < 9 || Math.hypot(x - 98, y - 70) < 9) v = 24;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
  }
  return rgba;
}

test('hollows: dark openings enclosed by the subject are found as H regions', () => {
  const { summary } = analyzeLocal(discWithHollows(), W, H);
  const hs = summary.regions.filter((r) => r.id[0] === 'H');
  assert.ok(hs.length >= 2, `found ${hs.length}`);
  assert.ok(hs.every((r) => r.contour.length >= 4 && r.tone === 'dark'));
});

test('markers have no baked-in numbers: auto hollows resolve to plain feature shapes', () => {
  const { summary } = analyzeLocal(discWithHollows(), W, H);
  const prims = resolveGuide({ kind: 'auto', name: 'hollows' }, summary);
  assert.ok(prims.length >= 2 && prims.every((p) => p.role === 'feature' && !('n' in p)));
});

test('ensureSketch adds a measured outline step when the tutor skipped it', () => {
  const { summary } = analyzeLocal(discWithHollows(), W, H);
  const raw = { analysis: { image_type: 'portrait', subject: 'round object' }, steps: [{ title: 'Shade it', phase: 'value', instruction: 'Shade the dark parts.', why: 'Tone first.', guides: [] }] };
  const { lesson } = validateLesson(raw, { source: 'ai' });
  assert.equal(hasSketchStep(lesson), false);
  const r = ensureSketch(lesson, summary, { mode: 'sketch', construct: false });
  assert.ok(r.added); assert.equal(r.lesson.steps[0].phase, 'contour'); assert.equal(r.lesson.steps[0].layer, 'art');
  assert.ok(resolveGuide(r.lesson.steps[0].guides[0], summary).length === 1, 'the line art resolves to real geometry');
  assert.equal(ensureSketch(r.lesson, summary, { construct: false, precise: false }).added, false, 'idempotent');
});

test('ensureSketch leaves abstract art, pixel art and free practice alone', () => {
  const { summary } = analyzeLocal(discWithHollows(), W, H);
  for (const [type, mode] of [['abstract', 'sketch'], ['pixel_art', 'sketch'], ['portrait', 'free']]) {
    const { lesson } = validateLesson({ analysis: { image_type: type }, steps: [{ title: 'x', phase: 'value', instruction: 'Fill it in.', guides: [] }] }, { source: 'ai' });
    assert.equal(ensureSketch(lesson, summary, { mode }).added, false, `${type}/${mode}`);
  }
});

test('sketch_paint: the lesson sketches first and then paints', () => {
  const { summary } = analyzeLocal(blobPainting(W, H), W, H);
  const l = buildLocalLesson({ mode: 'sketch_paint', imageType: 'painterly', medium: 'Digital painting', summary });
  assert.equal(l.strategy, 'sketch_then_paint');
  const phases = l.steps.map((s) => s.phase);
  assert.ok(['gesture', 'construction', 'contour'].includes(phases[0]), phases.join());
  assert.ok(phases.indexOf('contour') < phases.indexOf('value') && phases.includes('underpainting'), phases.join());
});

test('every local strategy starts with a sketch, except pixel art and free practice', () => {
  const { summary } = analyzeLocal(discWithHollows(), W, H);
  for (const mode of ['sketch', 'sketch_paint', 'paint']) {
    const l = buildLocalLesson({ mode, imageType: 'general', summary });
    const r = ensureSketch(l, summary, { mode });
    assert.ok(hasSketchStep(r.lesson), mode);
  }
});

test('Perfect Artist (tone simulation) rewards well-placed shading and punishes displaced shading', () => {
  const rgba = discWithHollows(); const { summary, maps } = analyzeLocal(rgba, W, H);
  const target = { fill: maps.mask, maps };
  const good = buildLocalLesson({ mode: 'sketch', imageType: 'general', summary });
  const bad = JSON.parse(JSON.stringify(good));
  bad.steps.forEach((s) => (s.guides = [normalizeGuide({ kind: 'shade', label: 'misplaced', box: [0.0, 0.0, 0.18, 0.18], tone: 'darkest', action: 'fill', strength: 3 }), normalizeGuide({ kind: 'feature', label: 'misplaced outline', box: [0.82, 0.82, 0.98, 0.98], expect: 'edge' })]));
  const rg = perfectArtistReport({ lesson: good, resolve: (g) => resolveGuide(g, summary), target, W, H });
  const rb = perfectArtistReport({ lesson: bad, resolve: (g) => resolveGuide(g, summary), target, W, H });
  const by = (r, n) => r.checks.find((c) => c.name.startsWith(n));
  assert.ok(by(rg, 'Sketch lines sit on real edges').pass, 'good sketch lines follow edges');
  assert.ok(!by(rb, 'Sketch lines sit on real edges').pass, 'displaced lines do not');
  assert.ok(!rb.pass && rg.checks.length >= rb.checks.length - 1);
  assert.ok(rg.sim.stages.length === good.steps.length && rg.sim.stages[0].tone.length === W * H);
});
