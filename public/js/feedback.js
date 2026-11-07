// feedback.js — pure: stroke telemetry, local critique, technique library, Buddy reaction lines.
// Rule of thumb: never invent measurements, never infer psychology from movement.

const pick = (arr, seed = Math.random()) => arr[Math.floor(seed * arr.length) % arr.length];

export const REACTIONS = {
  positive: ['That looks lovely!', 'Nice! You’ve got the big shapes down.', 'Your proportions are looking really good.', 'That curve is much smoother!', 'Beautiful color choice.', 'You’ve got the right idea!', 'That’s a strong first pass.'],
  constructive: ['Try bringing that edge in a little.', 'Try one longer stroke instead of several tiny ones.', 'The silhouette is good! Let’s refine the proportions.', 'That curve looks a little wobbly. Want to try it again?'],
  experiment: ['I like that variation!', 'That’s different from the reference, but it works.', 'Interesting color choice. Let’s see where it goes.', 'You don’t have to copy every detail.'],
  stepDone: ['Step complete! 🌸', 'Nice work — on to the next one.', 'That’s a wrap on this step!'],
};
export const reaction = (kind) => pick(REACTIONS[kind] || REACTIONS.positive);

/** Compute per-stroke metrics from [x,y,t,pressure] samples (doc pixels, ms). */
export function strokeMetrics(points, meta = {}) {
  const n = points.length;
  if (n < 2) return { len: 0, dur: 0, n, ...meta };
  let len = 0, pauses = 0, turn = 0, turnN = 0, prevAng = null;
  const speeds = [];
  for (let i = 1; i < n; i++) {
    const dx = points[i][0] - points[i - 1][0], dy = points[i][1] - points[i - 1][1], d = Math.hypot(dx, dy), dt = Math.max(1, points[i][2] - points[i - 1][2]);
    len += d; if (d > 0.5) speeds.push(d / dt);
    if (dt > 180 && d < 2) pauses++;
    if (d > 3) { const ang = Math.atan2(dy, dx); if (prevAng !== null) { let da = Math.abs(ang - prevAng); if (da > Math.PI) da = 2 * Math.PI - da; turn += da; turnN++; } prevAng = ang; }
  }
  const dur = points[n - 1][2] - points[0][2];
  const mean = speeds.reduce((a, b) => a + b, 0) / (speeds.length || 1);
  const sd = Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / (speeds.length || 1));
  const chord = Math.hypot(points[n - 1][0] - points[0][0], points[n - 1][1] - points[0][1]);
  return { len, dur, n, pauses, avgSpeed: mean, speedCV: mean ? sd / mean : 0, turnJitter: turnN ? turn / turnN : 0, straightness: len ? chord / len : 1, ...meta };
}

/** Summarise recent strokes into evidence-based notes. */
export function analyzeTelemetry(strokes, undoCount = 0) {
  const s = (strokes || []).filter((x) => x.len > 0 && x.tool !== 'eraser' && x.tool !== 'smudge');
  const out = { count: s.length, notes: [], undoCount };
  if (s.length < 3) return out;
  const recent = s.slice(-12);
  const short = recent.filter((x) => x.len < 36).length;
  const long = recent.filter((x) => x.len > 120);
  out.shortFraction = short / recent.length;
  if (recent.length >= 6 && out.shortFraction > 0.6) out.notes.push({ id: 'short_strokes', evidence: `${short} of your last ${recent.length} strokes were very short`, tip: 'Try drawing the curve in one continuous motion instead of building it from tiny strokes.' });
  const jit = long.filter((x) => x.straightness < 0.97).map((x) => x.turnJitter);
  if (jit.length >= 2) {
    const avg = jit.reduce((a, b) => a + b, 0) / jit.length;
    out.turnJitter = avg;
    const firstHalf = jit.slice(0, Math.floor(jit.length / 2)), secondHalf = jit.slice(Math.floor(jit.length / 2));
    const m = (a) => a.reduce((p, q) => p + q, 0) / (a.length || 1);
    if (jit.length >= 4 && m(secondHalf) < m(firstHalf) * 0.8) out.notes.push({ id: 'smoother_later', positive: true, evidence: `your longer strokes got steadier over the session (turn jitter ${m(firstHalf).toFixed(2)} → ${m(secondHalf).toFixed(2)} rad)`, tip: 'Keep that relaxed, confident arm movement.' });
    else if (avg > 0.45) out.notes.push({ id: 'wobbly', evidence: 'several long strokes change direction a lot along their length', tip: 'Move from your shoulder or elbow and keep your eyes on where the stroke is going, not on the pencil tip.' });
  }
  if (undoCount >= 6 && s.length) out.notes.push({ id: 'lots_of_undo', evidence: `${undoCount} undos so far`, tip: 'Try a faint, loose first pass — it is easier to correct than a committed line.' });
  return out;
}

/** Local critique from measurable evidence only. */
export function localCritique({ coverage = null, valueNotes = [], telemetry = null, stepTitle = '', emptiness = 0, strokeCount = 0, targets = [] }) {
  if (emptiness > 0.985 || strokeCount === 0) {
    return { positive: 'Fresh canvas — a great place to start!', improve: 'Make a few light marks, then ask me again and I can say something specific.', evidence: 'The canvas is almost empty.', confidence: 'high', tip: 'Start with the biggest shape and keep the lines light.', source: 'local' };
  }
  let positive = null, improve = null, evidence = []; let conf = 'low';
  const tgt = (targets || []).filter((t) => t && typeof t.pct === 'number');
  if (tgt.length) { // per-marker progress, measured from the artist's own marks
    conf = 'medium';
    const best = tgt.slice().sort((a, b) => b.pct - a.pct)[0], worst = tgt.slice().sort((a, b) => a.pct - b.pct)[0];
    evidence.push(tgt.slice(0, 4).map((t) => `${t.label}: ${t.pct}% ${t.kind === 'fill' ? 'filled' : 'traced'}`).join(', '));
    if (best.pct >= 65) positive = `“${best.label}” is looking well ${best.kind === 'fill' ? 'covered' : 'traced'}.`;
    if (worst.pct < 60 && worst !== best) improve = worst.kind === 'fill' ? `“${worst.label}” is only about ${worst.pct}% filled${worst.where ? ` — the ${worst.where} part still needs tone` : ''}.` : `“${worst.label}” has few marks near it yet${worst.where ? ` — start at the ${worst.where}` : ''}.`;
  }
  if (coverage && coverage.guidePixels > 20 && !tgt.length) {
    const pct = Math.round(coverage.coverage * 100); conf = 'medium';
    evidence.push(`about ${pct}% of the guide outline has a mark near it`);
    if (coverage.coverage >= 0.7) positive = `You’ve followed the guide for “${stepTitle}” really well.`;
    else if (coverage.coverage >= 0.35) positive = 'You’re on your way — the main shapes are starting to line up.';
    else positive = 'You’ve started marking out the shape — that’s the hardest part.';
    if (coverage.coverage < 0.7 && coverage.weakest) improve = `The ${coverage.weakest} part of the guide still has few marks — try that area next.`;
    else if (coverage.stray > 0.4) { improve = 'Some marks sit away from the guide. That is fine if it is intentional!'; evidence.push(`${Math.round(coverage.stray * 100)}% of marks are away from the guide`); }
  }
  for (const n of valueNotes) { evidence.push(n.evidence); if (!improve) { improve = n.tip; conf = 'medium'; } else if (!positive && n.positive) positive = n.tip; }
  if (telemetry && telemetry.notes) {
    for (const n of telemetry.notes) { if (n.positive && !positive) { positive = `Your longer strokes got steadier — nice. ${n.tip}`; evidence.push(n.evidence); } else if (!n.positive && !improve) { improve = n.tip; evidence.push(n.evidence); } }
  }
  if (!positive) positive = reaction('positive');
  if (!improve) improve = 'Squint at the reference and compare the biggest shapes with yours.';
  return { positive, improve, evidence: evidence.join('; ') || 'Based on the marks on your canvas.', confidence: conf, tip: null, source: 'local' };
}

/* ---------- technique library (offline coach) ---------- */
export const TECHNIQUES = {
  gesture_drawing: { title: 'Gesture first', body: 'Capture the movement of the whole subject in a few fast, light lines before anything else.', why: 'It sets energy and proportion while changes are still cheap.', exercise: { exercise: 'Five 30-second gesture drawings', duration_minutes: 3, why: 'Trains you to see the whole, not the parts' } },
  construction_shapes: { title: 'Build from simple shapes', body: 'Reduce every form to ovals, boxes and cylinders. Draw through them lightly so the structure is visible.', why: 'Simple shapes are easier to correct than finished forms.', exercise: { exercise: 'Three quick sketches using only construction shapes', duration_minutes: 5, why: 'Practices seeing structure first' } },
  confident_linework: { title: 'Draw from the shoulder', body: 'Draw the curve in one smooth motion, moving your arm instead of your wrist. Practice the movement slightly above the page first.', why: 'Long strokes are smoother because there are fewer start-stop joins.', exercise: { exercise: 'Draw five continuous C-curves without lifting your pencil', duration_minutes: 2, why: 'Practice continuous motion' } },
  proportion_checking: { title: 'Flip to check proportions', body: 'Flip your canvas horizontally (the mirror button). Errors you stopped seeing become obvious.', why: 'A fresh view breaks your brain’s habit of auto-correcting what it expects.', exercise: { exercise: 'Flip your canvas after every major step for one drawing', duration_minutes: 5, why: 'Builds a proportion-checking habit' } },
  composition: { title: 'Squint to simplify', body: 'Squint at the reference. Notice how the image collapses into 2–3 big shapes of light and dark.', why: 'Composition lives in the big shapes, not the details.', exercise: { exercise: 'Make three tiny thumbnails (1 minute each) with 3 big shapes', duration_minutes: 4, why: 'Practices planning placement' } },
  value_grouping: { title: 'Group your values', body: 'Block in the entire shadow as one connected shape before worrying about smaller variations.', why: 'Grouped values read clearly from far away.', exercise: { exercise: 'Create three grayscale thumbnails with only three values', duration_minutes: 6, why: 'Trains value simplification' } },
  brush_economy: { title: 'Use the biggest brush that works', body: 'Use a larger brush for your first pass. You can refine edges later.', why: 'It stops you from chasing details before the structure is right.', exercise: { exercise: 'Paint a simple object in under 10 strokes', duration_minutes: 5, why: 'Practices brush economy' } },
  edge_hierarchy: { title: 'Soft edges recede, hard edges advance', body: 'Make edges near the focal point crisp and let the rest melt away.', why: 'Edge contrast steers the viewer’s eye.', exercise: { exercise: 'Paint one sphere twice: once all crisp edges, once with a mix', duration_minutes: 8, why: 'Shows how edges change depth' } },
  color_harmony: { title: 'Try a limited palette', body: 'Pick three or four colors plus white and mix everything from those.', why: 'Fewer colors make a painting feel cohesive.', exercise: { exercise: 'Paint the same object using two different limited palettes', duration_minutes: 10, why: 'Practices color relationships' } },
  shape_language: { title: 'Find the repeated shape', body: 'Look for the shape that appears most — round, angular, long — and use it deliberately.', why: 'Consistent shape language is a big part of any style.', exercise: { exercise: 'Draw one subject three times: all circles, all triangles, all rectangles', duration_minutes: 6, why: 'Shows how shape changes mood' } },
  pixel_grid: { title: 'Think in clusters', body: 'Place colors in clean groups instead of scattered pixels, and keep outlines one pixel thick.', why: 'Clusters read as forms; noise reads as mess.', exercise: { exercise: 'Redraw a 16×16 icon using only 4 colors', duration_minutes: 8, why: 'Practices restraint' } },
  silhouette: { title: 'Squint test for silhouettes', body: 'Fill the shape with one color. Can you still tell what it is?', why: 'A readable silhouette is the foundation of every other detail.', exercise: { exercise: 'Draw three object silhouettes in solid black', duration_minutes: 4, why: 'Trains shape clarity' } },
  color_clusters: { title: 'Keep colors in clean clusters', body: 'Group same-colored pixels together and avoid single stray pixels.', why: 'It keeps small sprites readable.', exercise: { exercise: 'Fill a 16×16 shape with two colors without stray pixels', duration_minutes: 5, why: 'Practices clean clusters' } },
  free_practice: { title: 'Warm up with thumbnails', body: 'Try a few quick thumbnails before committing to a bigger drawing.', why: 'Quick tries let you explore without pressure.', exercise: { exercise: 'Three 1-minute thumbnails of the same idea', duration_minutes: 3, why: 'Explores options quickly' } },
};
const GENERIC = ['confident_linework', 'proportion_checking', 'composition', 'value_grouping', 'brush_economy'];

/** Pick a technique for the topic, optionally avoiding ones already shown. */
export function techniqueFor(topic, shown = []) {
  const ids = [topic, ...GENERIC, ...Object.keys(TECHNIQUES)].filter((id, i, a) => TECHNIQUES[id] && a.indexOf(id) === i);
  const id = ids.find((x) => !shown.includes(x)) || ids[0];
  return { id, ...TECHNIQUES[id] };
}

/* ---------- local value/color comparison of drawing vs reference (arrays at small res) ---------- */
/**
 * refGray, drawGray: Float32/Uint8 luminance (0..255); drawAlpha: 0..255 painted coverage; refLevels: 0..2 (3-value map).
 * Compares only PAINTED pixels so an unfinished canvas is not blamed for emptiness.
 */
export function valueNotesFrom({ refGray, refLevels, drawGray, drawAlpha }) {
  const notes = []; const sums = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < refGray.length; i++) {
    if (drawAlpha[i] < 128) continue;
    const l = refLevels[i]; sums[l][0] += drawGray[i]; sums[l][1] += refGray[i]; sums[l][2]++;
  }
  const names = ['shadows', 'midtones', 'highlights'];
  for (let l = 0; l < 3; l++) {
    const [d, r, n] = sums[l]; if (n < 150) continue;
    const diff = d / n - r / n;
    if (l === 0 && diff > 22) notes.push({ evidence: `painted shadow areas are about ${Math.round(diff)} levels lighter than the reference`, tip: 'Your shadows could be a bit darker.' });
    else if (l === 2 && diff < -22) notes.push({ evidence: `painted highlight areas are about ${Math.round(-diff)} levels darker than the reference`, tip: 'Your highlights could be a touch lighter.' });
    else if (Math.abs(diff) < 12) notes.push({ evidence: `${names[l]} are close in value to the reference`, tip: `Your ${names[l]} are well matched in value.`, positive: true });
  }
  return notes;
}
