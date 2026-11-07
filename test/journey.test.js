import test from 'node:test';
import assert from 'node:assert/strict';
import { Journey, buildRecap } from '../public/js/journey.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const session = (o = {}) => ({ id: 's' + Math.random(), at: Date.now(), title: 't', reference_type: 'line_art', medium: 'Digital sketching', finished: true, techniques: ['construction_shapes'], stepsDone: [{ id: 'a', title: 'A', phase: 'block_in', technique: 'construction_shapes' }], paletteExplored: true,
  evidence: { stepsCompleted: 5, stepsTotal: 5, guideRevealsPerStep: 1, strokes: 30, coverage: { median: 0.8, weakest: 'lower left', stray: 0.1 }, notes: [], valueNotes: [] }, ...o });

test('first session is a starting point: no invented trends', () => {
  const j = new Journey(mem()); const s = session(); j.record(s); const r = buildRecap(s, j);
  assert.equal(r.starting, true); assert.equal(r.trend.length, 0);
});
test('persists across instances and first milestone unlocks', () => {
  const st = mem(); const j = new Journey(st); const earned = j.record(session());
  assert.ok(earned.some((m) => m.id === 'first_guided_study'));
  assert.equal(new Journey(st).sessions.length, 1);
});
test('practice counter, remove and clearAll', () => {
  const j = new Journey(mem()); assert.equal(j.practiceDone('x'), 1); assert.equal(j.practiceDone('x'), 2);
  const s = session(); j.record(s); j.remove(s.id); assert.equal(j.sessions.length, 0);
  j.record(session()); j.clearAll(); assert.equal(j.sessions.length, 0);
});
test('corrupt storage falls back to empty state', () => {
  const st = mem(); st.setItem('canvasbuddy.journey.v1', '{nope'); assert.equal(new Journey(st).sessions.length, 0);
});
