// journey.js — personal art journey: sessions, milestones, practice log, recap. Local-only (localStorage).
// Rule: never invent progress. Trends need history; with none, the recap says "starting point".
import { techniqueFor, TECHNIQUES } from './feedback.js';

const KEY = 'canvasbuddy.journey.v1';

export const MILESTONES = [
  { id: 'first_guided_study', icon: '🌱', title: 'First complete guided study', test: (c) => c.finished.length >= 1 },
  { id: 'first_value_study', icon: '🌗', title: 'First value study', test: (c) => c.s.stepsDone.some((x) => x.phase === 'value') },
  { id: 'first_portrait', icon: '🙂', title: 'First portrait', test: (c) => c.s.finished && c.s.reference_type === 'portrait' },
  { id: 'first_landscape', icon: '🏞️', title: 'First landscape', test: (c) => c.s.finished && c.s.reference_type === 'landscape' },
  { id: 'three_projects', icon: '🖼️', title: 'Three completed projects', test: (c) => c.finished.length >= 3 },
  { id: 'five_palettes', icon: '🎨', title: 'Five palettes explored', test: (c) => c.j.analyses >= 5 },
  { id: 'new_medium', icon: '🧪', title: 'Tried a new medium', test: (c) => new Set(c.all.map((x) => x.medium)).size >= 2 },
  { id: 'no_guides', icon: '🕊️', title: 'Worked without guides', test: (c) => c.s.evidence.strokes >= 20 && c.s.evidence.guideRevealsPerStep === 0 },
  { id: 'line_control_5', icon: '〰️', title: 'Practiced line control five times', test: (c) => (c.j.practice.confident_linework || 0) >= 5 },
];

/** Keep one entry per id (the latest), preserving order of first appearance. */
export function dedupeById(list) {
  const seen = new Map(); (Array.isArray(list) ? list : []).forEach((x, i) => { if (x && x.id != null) seen.set(x.id, { x, i: seen.has(x.id) ? seen.get(x.id).i : i }); });
  return [...seen.values()].sort((a, b) => a.i - b.i).map((v) => v.x);
}
const emptyState = () => ({ sessions: [], practice: {}, milestones: {}, analyses: 0 });

export class Journey {
  constructor(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
    this.storage = storage; this.state = this._load();
  }
  _load() {
    try {
      const raw = this.storage && this.storage.getItem(KEY);
      if (raw) { const st = { ...emptyState(), ...JSON.parse(raw) }; st.sessions = dedupeById(st.sessions); return st; } // repairs older saves that stored one project twice
    } catch { /* corrupt → start fresh */ }
    return emptyState();
  }
  _save() {
    if (!this.storage) return;
    for (let tries = 0; tries < 6; tries++) {
      try { this.storage.setItem(KEY, JSON.stringify(this.state)); return; } catch {
        const withThumb = this.state.sessions.find((s) => s.thumb); if (!withThumb) return; delete withThumb.thumb; // quota: shed oldest thumbnails first
      }
    }
  }
  noteAnalysis() { this.state.analyses++; this._save(); }
  practiceDone(id) { this.state.practice[id] = (this.state.practice[id] || 0) + 1; this._save(); return this.state.practice[id]; }
  get sessions() { return this.state.sessions; }
  get isFirst() { return this.state.sessions.length === 0; }

  /** Store a finished/abandoned session and return the milestones newly earned by it. */
  record(session) {
    const prev = this.state.sessions.filter((x) => x.id !== session.id);
    const at = this.state.sessions.findIndex((x) => x.id === session.id); // saving the same project again updates it, never duplicates it
    if (at >= 0) { session.milestones = this.state.sessions[at].milestones || []; this.state.sessions[at] = session; } else this.state.sessions.push(session);
    const all = this.state.sessions, finished = all.filter((x) => x.finished);
    const earned = [];
    for (const m of MILESTONES) {
      if (this.state.milestones[m.id]) continue;
      let ok = false; try { ok = m.test({ s: session, all, finished, j: this.state, prev }); } catch { ok = false; }
      if (ok) { this.state.milestones[m.id] = { at: session.at, session: session.id }; earned.push(m); }
    }
    session.milestones = earned.map((m) => m.id);
    this._save(); return earned;
  }
  remove(id) { this.state.sessions = this.state.sessions.filter((s) => s.id !== id); this._save(); }
  clearAll() { this.state = emptyState(); this._save(); }
  exportJson() { return JSON.stringify({ app: 'CanvasBuddy', exported: new Date().toISOString(), ...this.state }, null, 2); }
  milestoneList() { return MILESTONES.map((m) => ({ ...m, earned: this.state.milestones[m.id] || null })); }
}

/** Deterministic, evidence-grounded recap. `ai` (optional) may replace the wording but never adds claims we cannot back. */
export function buildRecap(session, journey, ai = null) {
  const e = session.evidence, wentWell = [], improve = [], next = [];
  const prior = journey.sessions.filter((s) => s.id !== session.id);
  const starting = prior.length === 0;

  if (e.stepsCompleted > 0) wentWell.push(`You worked through ${e.stepsCompleted} of ${e.stepsTotal} steps${session.stepsDone[0] && /gesture|composition|construction/.test(session.stepsDone[0].phase) ? ', starting from the big shapes before details' : ''}.`);
  if (e.coverage && e.coverage.median >= 0.6) wentWell.push('Your marks followed the construction guides closely.');
  else if (e.coverage && e.coverage.stray >= 0.4 && e.stepsCompleted) wentWell.push('You made some choices of your own instead of copying every guide — that is how a style starts.');
  if (e.notes.some((n) => n.id === 'smoother_later')) wentWell.push('Your longer strokes got steadier as you went.');
  if (session.paletteExplored) wentWell.push('You explored the reference’s palette and value structure before painting.');
  if (e.guideRevealsPerStep === 0 && e.strokes >= 20) wentWell.push('You worked without leaning on the guides.');
  if (!wentWell.length) wentWell.push(e.strokes > 0 ? 'You made a start — getting marks on the page is the hardest step.' : 'You set up a project and studied the reference — a good first step.');

  for (const n of e.notes.filter((x) => !x.positive).slice(0, 2)) improve.push(n.tip);
  if (e.coverage && e.coverage.weakest && e.coverage.median < 0.6) improve.push(`The ${e.coverage.weakest} area of the guides had the fewest marks.`);
  if (!improve.length) improve.push('Compare your biggest shapes with the reference once more before adding details.');

  const topics = [];
  for (const n of e.notes) { if (n.id === 'short_strokes' || n.id === 'wobbly') topics.push('confident_linework'); if (n.id === 'lots_of_undo') topics.push('proportion_checking'); }
  if (e.valueNotes && e.valueNotes.length) topics.push('value_grouping');
  for (const t of session.techniques.slice(-2)) topics.push(t);
  const seen = new Set();
  for (const t of topics) { if (seen.has(t) || !TECHNIQUES[t]) continue; seen.add(t); next.push({ id: t, ...TECHNIQUES[t].exercise }); if (next.length >= 2) break; }
  if (!next.length) { const t = techniqueFor('confident_linework'); next.push({ id: t.id, ...t.exercise }); }

  const trend = [];
  const last = prior[prior.length - 1];
  if (last && last.evidence && last.evidence.stepsTotal && e.stepsTotal && last.evidence.guideRevealsPerStep > e.guideRevealsPerStep && last.strategy === session.strategy)
    trend.push('You asked for guides less often than in your last project with the same approach.');

  const out = {
    starting, wentWell: wentWell.slice(0, 3), improve: improve.slice(0, 2), next, trend,
    tryNext: e.guideRevealsPerStep > 0.8 ? 'Try the next project with fewer guides visible.' : 'Try a more complex subject, or a different medium.',
    reflection: starting ? 'This is your starting point — after a few more projects I can point out real trends.' : '',
    aiWording: false,
  };
  if (ai) {
    if (ai.went_well && ai.went_well.length) { out.wentWell = ai.went_well.slice(0, 3); out.aiWording = true; }
    if (ai.improve && ai.improve.length) out.improve = ai.improve.slice(0, 2);
    if (ai.next_practice && ai.next_practice.length) out.next = ai.next_practice.map((p) => ({ id: 'ai', ...p })).slice(0, 2);
    if (ai.reflection && !starting) out.reflection = ai.reflection;
  }
  return out;
}
