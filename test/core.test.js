import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLocal, kmeansPalette, boxBlur, labelComponents, ellipseFromComp } from '../public/js/construct.js';
import { iou, chamfer, makeMask, rasterizePrimitive, perfectArtistReport, coverageReport, lessonConsistency, ssim } from '../public/js/artist.js';
import { validateLesson, buildLocalLesson, resolveGuide, brushFromHint } from '../public/js/lesson.js';
import { strokeMetrics, analyzeTelemetry, localCritique, valueNotesFrom, techniqueFor } from '../public/js/feedback.js';
import { catLineArt, catTruthMask, blobPainting } from './helpers.js';

const W = 192, H = 192;

test('ellipse fitting recovers a filled ellipse', () => {
  const m = makeMask(W, H);
  rasterizePrimitive(m, W, H, { kind: 'ellipse', center: [0.4, 0.5], radius: [0.25, 0.12], rotation: 30 }, 'fill');
  const { comps } = labelComponents(m, W, H);
  const e = ellipseFromComp(comps[0], W, H);
  assert.ok(Math.abs(e.center[0] - 0.4) < 0.01 && Math.abs(e.center[1] - 0.5) < 0.01);
  assert.ok(Math.abs(e.radius[0] - 0.25) < 0.02, `rx ${e.radius[0]}`);
  assert.ok(Math.abs(e.radius[1] - 0.12) < 0.02, `ry ${e.radius[1]}`);
  assert.ok(Math.abs(e.rotation - 30) < 3, `rot ${e.rotation}`);
});

test('boxBlur preserves mean', () => {
  const a = new Float32Array(20 * 20).map((_, i) => (i % 7) * 10);
  const b = boxBlur(a, 20, 20, 2);
  const mean = (x) => x.reduce((p, q) => p + q, 0) / x.length;
  assert.ok(Math.abs(mean(a) - mean(b)) < 3);
});

test('kmeans palette on a two-colour image finds both colours', () => {
  const rgba = blobPainting(64, 64);
  const pal = kmeansPalette(rgba, 64, 64, 4);
  assert.ok(pal.length >= 3 && pal.length <= 4);
  assert.ok(pal.every((p) => /^#[0-9a-f]{6}$/.test(p.hex)));
  assert.ok(Math.abs(pal.reduce((a, p) => a + p.fraction, 0) - 1) < 1e-6);
  assert.ok(pal.some((p) => p.role === 'shadow') && pal.some((p) => p.role === 'highlight'));
});

test('analyzeLocal classifies synthetic line art and finds the subject', () => {
  const { summary, maps } = analyzeLocal(catLineArt(W, H), W, H);
  assert.equal(summary.stats.guessedType, 'line_art');
  assert.ok(summary.subject.ellipses.length >= 1);
  assert.ok(summary.subject.contours[0].length >= 6);
  const [x0, y0, x1, y1] = summary.subject.bbox;
  assert.ok(x0 < 0.35 && x1 > 0.7 && y0 < 0.15 && y1 > 0.85, JSON.stringify(summary.subject.bbox));
  assert.equal(maps.levels3.length, W * H);
});

test('validateLesson repairs, clamps and drops bad data (never throws)', () => {
  const raw = {
    analysis: { image_type: 'Line Art', confidence: 7 },
    steps: [
      { id: 'a', title: '<b>Hi</b>', instruction: 'Draw an oval', guide: { kind: 'ellipse', center: [2, -1], radius: [0.2, 0.3] }, tool_hint: 'light pencil' },
      { instruction: 'No geometry here' },
      { title: 'dropped' },
      { instruction: 'bad guide', guides: [{ kind: 'polygon', points: [[0, 0]] }, { kind: 'auto', name: 'nonsense' }] },
    ],
  };
  const { lesson, warnings } = validateLesson(raw);
  assert.equal(lesson.analysis.image_type, 'line_art');
  assert.equal(lesson.analysis.confidence, 1);
  assert.equal(lesson.steps.length, 3);
  assert.deepEqual(lesson.steps[0].guides[0].center, [1, 0]);
  assert.equal(lesson.steps[0].title, 'Hi');
  assert.equal(lesson.steps[0].brush, 'pencil');
  assert.ok(warnings.length >= 3);
  assert.equal(validateLesson(null).lesson, null);
  assert.equal(validateLesson({ steps: [] }).lesson, null);
  assert.equal(brushFromHint('soft airbrush'), 'airbrush');
  assert.equal(brushFromHint('watercolor wash'), 'watercolor');
});

test('local lessons exist for every strategy and validate cleanly', () => {
  for (const mode of ['sketch', 'paint', 'style', 'free']) {
    const l = buildLocalLesson({ mode });
    assert.ok(l && l.steps.length >= 1, mode);
    assert.ok(l.steps.every((s) => s.instruction && s.why));
  }
  assert.equal(buildLocalLesson({ mode: 'sketch', imageType: 'pixel_art' }).strategy, 'pixel');
});

test('Perfect Artist: replaying a line-art lesson reproduces the picture\'s own lines', () => {
  const { summary, maps } = analyzeLocal(catLineArt(W, H), W, H);
  const lesson = buildLocalLesson({ mode: 'sketch', imageType: 'line_art', summary });
  const target = { fill: catTruthMask(W, H), maps };
  const report = perfectArtistReport({ lesson, resolve: (g) => resolveGuide(g, summary), target, W, H });
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
  for (const k of Object.keys(byName).filter((n) => n.startsWith('Line art'))) assert.ok(byName[k].pass, `${k}: ${byName[k].value}`);
  assert.ok(Object.keys(byName).some((n) => n.startsWith('Line art lies on')), 'line-art accuracy is checked');
  assert.ok(byName['Step coverage'].pass);
  assert.ok(report.caveats.length >= 3);
  // stages are cumulative: IoU after the contour step must be >= after step 1
  const ious = report.stages.filter((s) => s.iou != null).map((s) => s.iou);
  assert.ok(ious[ious.length - 1] >= ious[0] - 1e-9);
});

test('Perfect Artist: a deliberately bad lesson FAILS (the harness can detect poor instructions)', () => {
  const bad = validateLesson({
    steps: [
      { instruction: 'Draw a big oval in the corner', guides: [{ kind: 'ellipse', center: [0.1, 0.1], radius: [0.08, 0.08] }] },
      { instruction: 'Draw the triangle outline', guides: [{ kind: 'ellipse', center: [0.9, 0.9], radius: [0.05, 0.05] }] },
    ],
  }, { source: 'ai' }).lesson;
  const report = perfectArtistReport({ lesson: bad, resolve: (g) => [g], target: { fill: catTruthMask(W, H) }, W, H });
  assert.ok(!report.pass);
  assert.ok(report.finalIoU < 0.2);
  assert.ok(report.consistency.issues.length >= 1, 'text/geometry mismatch should be flagged');
});

test('metrics sanity: IoU/chamfer/SSIM', () => {
  const a = catTruthMask(W, H), b = Uint8Array.from(a);
  assert.equal(iou(a, b), 1);
  assert.ok(chamfer(a, b, W, H) < 0.01);
  const empty = makeMask(W, H);
  assert.equal(iou(a, empty), 0);
  const g = new Float32Array(W * H).map((_, i) => (i * 7) % 255);
  assert.ok(Math.abs(ssim(g, g, W, H) - 1) < 1e-6);
});

test('coverageReport: partial tracing is reported with the weakest quadrant', () => {
  const guide = makeMask(W, H); rasterizePrimitive(guide, W, H, { kind: 'ellipse', center: [0.5, 0.5], radius: [0.35, 0.35], rotation: 0 }, 'outline', 2);
  // user traced only the upper half
  const draw = Uint8Array.from(guide); for (let i = 0; i < draw.length; i++) if (((i / W) | 0) > H / 2) draw[i] = 0;
  const r = coverageReport(guide, draw, W, H, 4);
  assert.ok(r.coverage > 0.4 && r.coverage < 0.6, `coverage ${r.coverage}`);
  assert.match(r.weakest, /lower/);
  const full = coverageReport(guide, guide, W, H, 4);
  assert.ok(full.coverage > 0.99);
  const crit = localCritique({ coverage: r, stepTitle: 'Block in', strokeCount: 5 });
  assert.match(crit.improve, /lower/);
  assert.match(crit.evidence, /%/);
});

test('telemetry: short-stroke habit is detected, empty canvas is handled honestly', () => {
  const mk = (len) => ({ len, tool: 'pencil', straightness: 0.9, turnJitter: 0.1 });
  const t = analyzeTelemetry(Array.from({ length: 10 }, () => mk(20)));
  assert.ok(t.notes.some((n) => n.id === 'short_strokes'));
  const c = localCritique({ emptiness: 1, strokeCount: 0 });
  assert.match(c.positive, /Fresh canvas/);
  const pts = Array.from({ length: 30 }, (_, i) => [i * 5, Math.sin(i / 4) * 10, i * 16, 0.5]);
  const sm = strokeMetrics(pts, { tool: 'pencil' });
  assert.ok(sm.len > 100 && sm.turnJitter < 0.2);
});

test('valueNotesFrom compares only painted pixels', () => {
  const n = 400;
  const refGray = new Float32Array(n).fill(40), refLevels = new Uint8Array(n).fill(0);
  const drawGray = new Float32Array(n).fill(100), drawAlpha = new Uint8Array(n).fill(255);
  const notes = valueNotesFrom({ refGray, refLevels, drawGray, drawAlpha });
  assert.match(notes[0].tip, /darker/);
  assert.equal(valueNotesFrom({ refGray, refLevels, drawGray, drawAlpha: new Uint8Array(n) }).length, 0);
  assert.ok(techniqueFor('composition').title);
});

test('consistency checker flags ordering problems', () => {
  const l = validateLesson({ steps: [{ instruction: 'Add details', phase: 'detail', why: 'x' }, { instruction: 'Place the gesture', phase: 'gesture', why: 'x' }, { instruction: 'Contours', phase: 'contour', why: 'x' }] }).lesson;
  const c = lessonConsistency(l);
  assert.ok(c.issues.some((i) => /later-phase/.test(i)));
});
