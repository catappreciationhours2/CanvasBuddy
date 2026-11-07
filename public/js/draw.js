// draw.js — the drawing engine. Pointer-Events based so one code path serves
// Apple Pencil (pressure + tilt), finger, mouse and Wacom-style pens.
//   • pen:   draws; hover cursor; pressure/tilt; palm rejection while the pen is down
//   • touch: finger draws (or navigates, user setting); two fingers pan + pinch-zoom;
//            two-finger tap = undo, three-finger tap = redo (Procreate-style)
//   • mouse: left draws, wheel zooms, space/middle/right-drag pans
import { BRUSHES, StrokePainter } from './brushes.js';
import { strokeMetrics } from './feedback.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const PAPER = '#fffdf8';
const hexToRgbArr = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0x34323d; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

export class DrawingEngine {
  constructor({ viewport, stage, cursor }) {
    this.vp = viewport; this.stage = stage; this.cursor = cursor;
    this.doc = { w: 1200, h: 900 };
    this.view = { z: 1, tx: 0, ty: 0, flip: 1 };
    this.brushId = 'pencil'; this.color = '#34323D'; this.sizes = {}; this.opacities = {}; this.opacity = 1; this.stabilizer = null;
    this.layers = []; this.active = 0; this.undoStack = []; this.redoStack = []; this.undoArea = 0;
    this.pointers = new Map(); this.stroke = null; this.gesture = null; this.gestureLock = false; this.tap = null;
    this.fingerDraws = true; this.pencilSeen = false; this.penActive = false; this.penUpAt = 0; this.spaceDown = false; this.mousePan = null;
    this.tool = 'brush'; this.listeners = {}; this.strokes = []; this.undoCount = 0; this.strokeTotal = 0;
    this._buildDom(); this._bind();
    new ResizeObserver(() => { this._rect = null; }).observe(this.vp);
  }

  /* ---------- events ---------- */
  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); return this; }
  emit(evt, data) { (this.listeners[evt] || []).forEach((f) => f(data)); }

  /* ---------- DOM ---------- */
  _buildDom() {
    this.paper = Object.assign(document.createElement('div'), { className: 'cb-paper' });
    this.layerWrap = Object.assign(document.createElement('div'), { className: 'cb-layers' });
    this.buf = Object.assign(mk(10, 10), { className: 'cb-buf' }); this.bufCtx = this.buf.getContext('2d');
    this.ghost = Object.assign(mk(10, 10), { className: 'cb-ghost' }); this.ghostCtx = this.ghost.getContext('2d');
    this.stage.prepend(this.paper, this.layerWrap, this.ghost);
    this.layerWrap.appendChild(this.buf);
    this.buf.style.display = 'none'; this.ghost.style.display = 'none';
  }

  /** (Re)initialise a blank document. Clears everything. */
  init(w, h) {
    this.doc = { w: Math.round(w), h: Math.round(h) };
    for (const l of this.layers) l.canvas.remove();
    this.layers = []; this.undoStack = []; this.redoStack = []; this.undoArea = 0; this.strokes = []; this.undoCount = 0; this.strokeTotal = 0;
    for (const c of [this.buf, this.ghost]) { c.width = this.doc.w; c.height = this.doc.h; }
    Object.assign(this.stage.style, { width: `${this.doc.w}px`, height: `${this.doc.h}px`, marginLeft: `${-this.doc.w / 2}px`, marginTop: `${-this.doc.h / 2}px` });
    this.addLayer('Layer 1'); this.fit(); this.emit('history', this.historyState());
  }

  /* ---------- layers ---------- */
  addLayer(name) {
    if (this.layers.length >= 6) { this.emit('toast', 'That’s the maximum of 6 layers'); return null; }
    const canvas = Object.assign(mk(this.doc.w, this.doc.h), { className: 'cb-layer' });
    const mirror = mk(this.doc.w, this.doc.h);
    const layer = { name: name || `Layer ${this.layers.length + 1}`, canvas, ctx: canvas.getContext('2d'), mirror, mctx: mirror.getContext('2d'), visible: true, opacity: 1 };
    this.layers.push(layer);
    this.layerWrap.insertBefore(canvas, this.buf);
    this.selectLayer(this.layers.length - 1); return layer;
  }
  selectLayer(i) { this.active = clamp(i, 0, this.layers.length - 1); this.emit('layers', this.layers); }
  setLayerVisible(i, v) { this.layers[i].visible = v; this.layers[i].canvas.style.display = v ? '' : 'none'; this.emit('layers', this.layers); }
  setLayerOpacity(i, v) { this.layers[i].opacity = v; this.layers[i].canvas.style.opacity = v; this.emit('layers', this.layers); }
  clearActive() {
    const l = this.layers[this.active]; if (!l) return;
    this._commitUndo(l, { x: 0, y: 0, w: this.doc.w, h: this.doc.h }, true);
    l.ctx.clearRect(0, 0, this.doc.w, this.doc.h); l.mctx.clearRect(0, 0, this.doc.w, this.doc.h);
    this.emit('change'); this.emit('history', this.historyState());
  }

  /* ---------- tool state ---------- */
  setBrush(id) {
    const br = BRUSHES[id]; if (!br) return;
    if (this.brushId) this.opacities[this.brushId] = this.opacity;
    this.brushId = id; this.tool = 'brush'; this.opacity = this.opacities[id] ?? br.opacity ?? 1;
    this.emit('brush', { id, size: this.sizeFor(br), opacity: this.opacity });
  }
  sizeFor(br = BRUSHES[this.brushId]) { return this.sizes[br.id] ?? br.size[2]; }
  setSize(v) { const br = BRUSHES[this.brushId]; this.sizes[br.id] = clamp(v, br.size[0], br.size[1]); this._updateCursor(); }
  setOpacity(v) { this.opacity = clamp(v, 0.05, 1); }
  setColor(hex) { this.color = hex; this.emit('color', hex); }
  setTool(t) { this.tool = t; this.emit('tool', t); }
  setFingerDraws(v) { this.fingerDraws = v; this.emit('fingermode', v); }

  /* ---------- reference ghost ---------- */
  setReference(source) {
    this.ghostCtx.clearRect(0, 0, this.doc.w, this.doc.h);
    this.ghostCtx.fillStyle = '#fff'; this.ghostCtx.fillRect(0, 0, this.doc.w, this.doc.h);
    this.ghostCtx.drawImage(source, 0, 0, this.doc.w, this.doc.h);
  }
  setGhost(mode, opacity = 0.35) {
    this.ghostMode = mode;
    this.ghost.style.display = mode === 'off' ? 'none' : 'block';
    this.ghost.style.opacity = mode === 'difference' ? 1 : opacity;
    this.ghost.style.mixBlendMode = mode === 'difference' ? 'difference' : mode === 'ghost' ? 'multiply' : 'normal';
  }

  /* ---------- view ---------- */
  get rect() { return (this._rect ||= this.vp.getBoundingClientRect()); }
  applyView() {
    const v = this.view; this.stage.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.flip * v.z}, ${v.z})`;
    this._updateCursor(); this.emit('view', v);
  }
  fit() {
    const r = this.rect; this.view.z = clamp(Math.min(r.width / this.doc.w, r.height / this.doc.h) * 0.95, 0.1, 8);
    this.view.tx = this.view.ty = 0; this.applyView();
  }
  zoomAt(factor, vx = 0, vy = 0) {
    const v = this.view, nz = clamp(v.z * factor, 0.15, 10);
    v.tx = vx - (vx - v.tx) * (nz / v.z); v.ty = vy - (vy - v.ty) * (nz / v.z); v.z = nz; this.applyView();
  }
  setFlip(on) { this.view.flip = on ? -1 : 1; this.applyView(); this.emit('flip', on); }
  _toV(cx, cy) { const r = this.rect; return { vx: cx - (r.left + r.width / 2), vy: cy - (r.top + r.height / 2) }; }
  docPoint(cx, cy) {
    const { vx, vy } = this._toV(cx, cy), v = this.view;
    return { x: this.doc.w / 2 + (vx - v.tx) / (v.flip * v.z), y: this.doc.h / 2 + (vy - v.ty) / v.z };
  }
  _updateCursor() {
    if (!this.cursor || !this._cur) return;
    const d = Math.max(4, this.sizeFor() * this.view.z), c = this.cursor;
    c.style.width = c.style.height = `${d}px`; c.style.transform = `translate(${this._cur.x - d / 2}px, ${this._cur.y - d / 2}px)`;
  }
  _moveCursor(e) {
    if (!this.cursor) return;
    if (e.pointerType === 'touch' || this.tool === 'picker' || this.gesture) { this.cursor.style.display = 'none'; return; }
    const r = this.rect; this._cur = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.cursor.style.display = 'block'; this._updateCursor();
  }

  /* ---------- history ---------- */
  historyState() { return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 }; }
  _commitUndo(layer, rect, keepMirror = false) {
    const before = mk(rect.w, rect.h);
    before.getContext('2d').drawImage(layer.mirror, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    this.undoStack.push({ layer, rect, canvas: before }); this.undoArea += rect.w * rect.h; this.redoStack = [];
    while (this.undoStack.length > 80 || this.undoArea > 40e6) { const o = this.undoStack.shift(); this.undoArea -= o.rect.w * o.rect.h; }
    if (!keepMirror) { layer.mctx.clearRect(rect.x, rect.y, rect.w, rect.h); layer.mctx.drawImage(layer.canvas, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h); }
  }
  _swap(entry) {
    const { layer, rect, canvas } = entry, after = mk(rect.w, rect.h);
    after.getContext('2d').drawImage(layer.canvas, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    for (const c of [layer.ctx, layer.mctx]) { c.clearRect(rect.x, rect.y, rect.w, rect.h); c.drawImage(canvas, rect.x, rect.y); }
    entry.canvas = after; return entry;
  }
  undo() {
    if (this.stroke) this._cancelStroke();
    const e = this.undoStack.pop(); if (!e) return false;
    this.redoStack.push(this._swap(e)); this.undoCount++; this.emit('change'); this.emit('history', this.historyState()); this.emit('undo'); return true;
  }
  redo() {
    const e = this.redoStack.pop(); if (!e) return false;
    this.undoStack.push(this._swap(e)); this.emit('change'); this.emit('history', this.historyState()); return true;
  }

  /* ---------- output ---------- */
  composite({ scale = 1, maxSide = 0, paper = true, only = null } = {}) {
    let s = scale; if (maxSide) s = Math.min(s, maxSide / Math.max(this.doc.w, this.doc.h));
    const c = mk(Math.max(1, Math.round(this.doc.w * s)), Math.max(1, Math.round(this.doc.h * s))), ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    if (paper) { ctx.fillStyle = PAPER; ctx.fillRect(0, 0, c.width, c.height); }
    for (const l of this.layers) if (l.visible && (!only || only(l))) { ctx.globalAlpha = l.opacity; ctx.drawImage(l.canvas, 0, 0, c.width, c.height); }
    ctx.globalAlpha = 1; return c;
  }
  /** Painted-alpha mask (union of visible layers) at a reduced size. */
  alphaAt(w, h) {
    const c = mk(w, h), ctx = c.getContext('2d');
    for (const l of this.layers) if (l.visible) { ctx.globalAlpha = l.opacity; ctx.drawImage(l.canvas, 0, 0, w, h); }
    return ctx.getImageData(0, 0, w, h).data;
  }
  isEmpty() { return this.strokeTotal === 0 && !this.undoStack.length; }
  _pickColor(x, y) {
    x = clamp(Math.round(x), 0, this.doc.w - 1); y = clamp(Math.round(y), 0, this.doc.h - 1);
    let r = 255, g = 253, b = 248;
    for (const l of this.layers) {
      if (!l.visible) continue;
      const d = l.ctx.getImageData(x, y, 1, 1).data, a = (d[3] / 255) * l.opacity; if (!a) continue;
      // canvas stores premultiplied-safe straight alpha in getImageData
      r = r * (1 - a) + d[0] * a; g = g * (1 - a) + d[1] * a; b = b * (1 - a) + d[2] * a;
    }
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }

  /* ---------- fill bucket ---------- */
  /**
   * Flood-fill the region under (x,y) on the ACTIVE layer. The region is decided from everything visible (so a sketch on the
   * scaffold layer can bound a fill painted on the art layer). `gap` closes small holes in the outline; the fill is slid
   * underneath existing strokes (destination-over) so line art stays crisp. Fully undoable.
   */
  floodFill(x, y, { gap = this.fillGap ?? 3, tol = this.fillTol ?? 40 } = {}) {
    const layer = this.layers[this.active]; if (!layer) return false;
    if (!layer.visible) { this.emit('toast', 'This layer is hidden — show it to fill.'); return false; }
    const W = this.doc.w, H = this.doc.h, sx = Math.round(clamp(x, 0, W - 1)), sy = Math.round(clamp(y, 0, H - 1));
    const comp = mk(W, H), cx = comp.getContext('2d', { willReadFrequently: true });
    for (const l of this.layers) if (l.visible) { cx.globalAlpha = l.opacity; cx.drawImage(l.canvas, 0, 0); }
    const px = cx.getImageData(0, 0, W, H).data, N = W * H;
    // "wall" = clearly painted pixels. Fill region = connected non-wall pixels (or similar colour when seeded on paint).
    const a = (i) => px[i * 4 + 3], seed = sy * W + sx, seedA = a(seed);
    const similar = (i) => { const d = Math.abs(px[i * 4] - px[seed * 4]) + Math.abs(px[i * 4 + 1] - px[seed * 4 + 1]) + Math.abs(px[i * 4 + 2] - px[seed * 4 + 2]) + Math.abs(a(i) - seedA); return d <= tol * 2; };
    let wall = new Uint8Array(N);
    if (seedA < 24) for (let i = 0; i < N; i++) wall[i] = a(i) >= 96 ? 1 : 0; else for (let i = 0; i < N; i++) wall[i] = similar(i) ? 0 : 1;
    const solid = wall.slice(); // exact line pixels; `wall` below may be thickened to bridge tiny gaps
    if (gap > 0 && seedA < 24) { // thicken walls so tiny breaks in the outline do not leak
      const r = gap, t = new Uint8Array(N);
      for (let y2 = 0; y2 < H; y2++) { let run = 0; for (let x2 = 0; x2 < W; x2++) { run = wall[y2 * W + x2] ? r : Math.max(0, run - 1); if (run) t[y2 * W + x2] = 1; } for (let x2 = W - 1, run2 = 0; x2 >= 0; x2--) { run2 = wall[y2 * W + x2] ? r : Math.max(0, run2 - 1); if (run2) t[y2 * W + x2] = 1; } }
      const t2 = new Uint8Array(N);
      for (let x2 = 0; x2 < W; x2++) { let run = 0; for (let y2 = 0; y2 < H; y2++) { run = t[y2 * W + x2] ? r : Math.max(0, run - 1); if (run) t2[y2 * W + x2] = 1; } for (let y2 = H - 1, run2 = 0; y2 >= 0; y2--) { run2 = t[y2 * W + x2] ? r : Math.max(0, run2 - 1); if (run2) t2[y2 * W + x2] = 1; } }
      for (let i = 0; i < N; i++) if (t2[i]) wall[i] = 1; // approximate dilation (separable running max)
      if (wall[seed]) { wall = solid; } // seed sat inside the thickened line: fall back to the exact walls
    }
    if (wall[seed]) { this.emit('toast', 'Tap inside an area, not on a line.'); return false; }
    const filled = new Uint8Array(N), stack = new Int32Array(N); let sp = 0, count = 0, x0 = W, y0 = H, x1 = 0, y1 = 0;
    stack[sp++] = seed; filled[seed] = 1;
    while (sp) {
      const i = stack[--sp], xx = i % W, yy = (i / W) | 0; count++; if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
      if (xx > 0 && !filled[i - 1] && !wall[i - 1]) { filled[i - 1] = 1; stack[sp++] = i - 1; }
      if (xx < W - 1 && !filled[i + 1] && !wall[i + 1]) { filled[i + 1] = 1; stack[sp++] = i + 1; }
      if (yy > 0 && !filled[i - W] && !wall[i - W]) { filled[i - W] = 1; stack[sp++] = i - W; }
      if (yy < H - 1 && !filled[i + W] && !wall[i + W]) { filled[i + W] = 1; stack[sp++] = i + W; }
    }
    if (count > N * 0.92) { this.emit('toast', 'That area is not closed — close the outline (or raise “gap closing”) and try again.'); return false; }
    // grow by (gap + 2) px so the fill tucks under the antialiased/thickened line instead of leaving a halo
    const grow = (gap || 0) + 2; const rx0 = Math.max(0, x0 - grow), ry0 = Math.max(0, y0 - grow), rx1 = Math.min(W - 1, x1 + grow), ry1 = Math.min(H - 1, y1 + grow), rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
    const out = new ImageData(rw, rh), rgb = hexToRgbArr(this.color), alpha = 255;
    const near = (xx, yy) => { for (let dy = -grow; dy <= grow; dy++) { const y2 = yy + dy; if (y2 < 0 || y2 >= H) continue; for (let dx = -grow; dx <= grow; dx++) { const x2 = xx + dx; if (x2 >= 0 && x2 < W && filled[y2 * W + x2]) return true; } } return false; };
    for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw; xx++) {
      const gx = rx0 + xx, gy = ry0 + yy, gi = gy * W + gx;
      // fill the region itself, plus every pixel of the line's antialiased edge and of the gap-closing margin next to it: the fill then meets the line with no halo
      const inside = filled[gi] || ((px[gi * 4 + 3] > 0 || (wall[gi] && !solid[gi])) && near(gx, gy));
      if (inside) { const o = (yy * rw + xx) * 4; out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; out.data[o + 3] = alpha; }
    }
    const tmp = mk(rw, rh); tmp.getContext('2d').putImageData(out, 0, 0);
    const rect = { x: rx0, y: ry0, w: rw, h: rh };
    this._commitUndo(layer, rect, true);
    layer.ctx.save(); layer.ctx.globalAlpha = this.opacity; layer.ctx.globalCompositeOperation = 'destination-over'; layer.ctx.drawImage(tmp, rx0, ry0); layer.ctx.restore();
    layer.mctx.clearRect(rx0, ry0, rw, rh); layer.mctx.drawImage(layer.canvas, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
    this.strokeTotal++; this.emit('change'); this.emit('history', this.historyState()); this.emit('fill', { rect });
    return true;
  }

  /* ---------- stroke lifecycle ---------- */
  _beginStroke(e) {
    if (this.tool === 'fill') { const p = this.docPoint(e.clientX, e.clientY); this.floodFill(p.x, p.y); return; }
    if (this.tool === 'picker') { const p = this.docPoint(e.clientX, e.clientY); const hex = this._pickColor(p.x, p.y); this.setColor(hex); this.emit('picked', hex); return; }
    const layer = this.layers[this.active]; if (!layer) return;
    if (!layer.visible) { this.emit('toast', 'This layer is hidden — show it to draw.'); return; }
    const br = BRUSHES[this.brushId];
    if (br.buffered) {
      this.layerWrap.insertBefore(this.buf, layer.canvas.nextSibling);
      Object.assign(this.buf.style, { display: 'block', opacity: this.opacity, mixBlendMode: br.blend || 'normal' });
      this.bufCtx.clearRect(0, 0, this.doc.w, this.doc.h);
    }
    const painter = new StrokePainter({ brush: br, color: this.color, size: this.sizeFor(br), opacity: this.opacity, ctx: layer.ctx, buf: this.bufCtx, docW: this.doc.w, docH: this.doc.h });
    this.stroke = { id: e.pointerId, type: e.pointerType, painter, layer, pts: [], s: null, raw: null, pS: null, tilt: 0, br };
    this._addSample(e);
    this.cursor && e.pointerType === 'touch' && (this.cursor.style.display = 'none');
  }
  _addSample(e) {
    const st = this.stroke; if (!st) return;
    const p = this.docPoint(e.clientX, e.clientY), t = e.timeStamp;
    let pressure, tilt = 0;
    if (e.pointerType === 'pen') {
      pressure = clamp(e.pressure > 0 ? e.pressure : 0.05, 0.02, 1);
      tilt = clamp(Math.hypot(e.tiltX || 0, e.tiltY || 0) / 70, 0, 1);
    } else {
      // no pressure hardware: slower = heavier, faster = lighter (also gives finger/mouse lines natural taper)
      let target = 0.6;
      if (st.raw) { const dist = Math.hypot(p.x - st.raw.x, p.y - st.raw.y) * this.view.z, dt = Math.max(1, t - st.raw.t); target = clamp(1 / (1 + (dist / dt) * 0.5), 0.3, 1); }
      st.pS = st.pS == null ? 0.6 : st.pS + (target - st.pS) * 0.3; pressure = st.pS;
    }
    st.raw = { x: p.x, y: p.y, t }; st.tilt = tilt; st.p = pressure;
    const sm = this.stabilizer ?? st.br.smoothing ?? 0;
    if (!st.s) st.s = { x: p.x, y: p.y }; else { st.s.x += (p.x - st.s.x) * (1 - sm); st.s.y += (p.y - st.s.y) * (1 - sm); }
    st.painter.move(st.s.x, st.s.y, pressure, tilt);
    const last = st.pts[st.pts.length - 1];
    if (!last || Math.hypot(p.x - last[0], p.y - last[1]) > 1.2 || t - last[2] > 120) { if (st.pts.length < 600) st.pts.push([p.x, p.y, t, pressure]); }
  }
  _flushStroke(st) { // let the lazy stabiliser catch up with the final pen position
    if (!st.raw || !st.s) return;
    for (let i = 0; i < 16 && Math.hypot(st.raw.x - st.s.x, st.raw.y - st.s.y) > 0.4; i++) {
      st.s.x += (st.raw.x - st.s.x) * 0.5; st.s.y += (st.raw.y - st.s.y) * 0.5; st.painter.move(st.s.x, st.s.y, st.p, st.tilt);
    }
  }
  _endStroke() {
    const st = this.stroke; if (!st) return; this.stroke = null;
    this._flushStroke(st);
    const rect = st.painter.end();
    this.buf.style.display = 'none';
    if (rect) {
      this._commitUndo(st.layer, rect);
      const m = strokeMetrics(st.pts, { tool: st.br.id, pointerType: st.type });
      this.strokes.push(m); if (this.strokes.length > 300) this.strokes.shift(); this.strokeTotal++;
      this.emit('stroke', { metrics: m, rect, layer: this.active });
      this.emit('change'); this.emit('history', this.historyState());
    }
  }
  /** Throw away an in-progress stroke without leaving a trace (second finger landed, etc.). */
  _cancelStroke() {
    const st = this.stroke; if (!st) return; this.stroke = null;
    const d = st.painter.dirty;
    if (isFinite(d.x0)) {
      const x = Math.max(0, Math.floor(d.x0) - 3), y = Math.max(0, Math.floor(d.y0) - 3), w = Math.min(this.doc.w, Math.ceil(d.x1) + 3) - x, h = Math.min(this.doc.h, Math.ceil(d.y1) + 3) - y;
      if (w > 0 && h > 0) { st.layer.ctx.clearRect(x, y, w, h); st.layer.ctx.drawImage(st.layer.mirror, x, y, w, h, x, y, w, h); this.bufCtx.clearRect(x, y, w, h); }
    }
    this.buf.style.display = 'none';
  }

  /* ---------- gestures ---------- */
  _touchList() { return [...this.pointers.values()]; }
  _startGesture() {
    this.gesture = null; const ts = this._touchList(); if (!ts.length) return;
    this._cancelStroke();
    const c = this._centroid(ts), d = ts.length >= 2 ? Math.hypot(ts[0].x - ts[1].x, ts[0].y - ts[1].y) : 0;
    this.gesture = { z0: this.view.z, tx0: this.view.tx, ty0: this.view.ty, c0: this._toV(c.x, c.y), d0: d };
    if (this.cursor) this.cursor.style.display = 'none';
  }
  _centroid(ts) { return { x: ts.reduce((a, t) => a + t.x, 0) / ts.length, y: ts.reduce((a, t) => a + t.y, 0) / ts.length }; }
  _updateGesture() {
    const g = this.gesture, ts = this._touchList(); if (!g || !ts.length) return;
    const c = this._centroid(ts), cur = this._toV(c.x, c.y), v = this.view;
    const d = ts.length >= 2 ? Math.hypot(ts[0].x - ts[1].x, ts[0].y - ts[1].y) : 0;
    const nz = g.d0 > 0 && d > 0 ? clamp(g.z0 * (d / g.d0), 0.15, 10) : g.z0;
    v.z = nz; v.tx = cur.vx - (g.c0.vx - g.tx0) * (nz / g.z0); v.ty = cur.vy - (g.c0.vy - g.ty0) * (nz / g.z0);
    this.applyView();
  }

  /* ---------- pointer handlers ---------- */
  _bind() {
    const vp = this.vp, opt = { passive: false };
    vp.addEventListener('pointerdown', (e) => this._down(e), opt);
    vp.addEventListener('pointermove', (e) => this._move(e), opt);
    vp.addEventListener('pointerup', (e) => this._up(e), opt);
    vp.addEventListener('pointercancel', (e) => this._up(e, true), opt);
    vp.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && this.cursor && !this.stroke) this.cursor.style.display = 'none'; });
    vp.addEventListener('wheel', (e) => {
      e.preventDefault(); const { vx, vy } = this._toV(e.clientX, e.clientY);
      if (e.shiftKey) { this.view.tx -= e.deltaY; this.view.ty -= e.deltaX; this.applyView(); } else this.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), vx, vy);
    }, opt);
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'contextmenu', 'dblclick', 'selectstart', 'dragstart']) vp.addEventListener(ev, (e) => e.preventDefault(), opt);
    vp.addEventListener('touchstart', (e) => e.preventDefault(), opt);
    vp.addEventListener('touchmove', (e) => e.preventDefault(), opt);
    window.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase(); if (['input', 'textarea', 'select'].includes(tag) && e.key !== 'Escape') return;
      if (e.code === 'Space') { this.spaceDown = true; vp.classList.add('panning'); if (e.target === document.body) e.preventDefault(); }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
      else if (!mod && e.key === '[') { this.setSize(this.sizeFor() * 0.85); this.emit('brush', { id: this.brushId, size: this.sizeFor(), opacity: this.opacity }); }
      else if (!mod && e.key === ']') { this.setSize(this.sizeFor() * 1.18); this.emit('brush', { id: this.brushId, size: this.sizeFor(), opacity: this.opacity }); }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { this.spaceDown = false; vp.classList.remove('panning'); } });
  }
  _down(e) {
    if (e.target && e.target.closest && e.target.closest('button,input,.step-card,.view-tools,.gesture-hint')) return; // overlay UI keeps its own taps
    e.preventDefault(); this._rect = this.vp.getBoundingClientRect();
    try { this.vp.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (e.pointerType === 'pen') {
      if (!this.pencilSeen) { this.pencilSeen = true; this.emit('pencil'); }
      this.penActive = true; this.pointers.clear(); this.gesture = null; this._cancelStroke(); this._beginStroke(e); return;
    }
    if (e.pointerType === 'touch') {
      if (this.penActive || performance.now() - this.penUpAt < 300) return; // palm rejection
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
      if (this.pointers.size === 1) this.tap = { t0: performance.now(), max: 1, moved: false };
      else if (this.tap) this.tap.max = Math.max(this.tap.max, this.pointers.size);
      if (this.pointers.size >= 2) { this.gestureLock = true; this._startGesture(); return; }
      if (this.gestureLock) return;
      if (this.fingerDraws) this._beginStroke(e); else this._startGesture();
      return;
    }
    if (e.button === 1 || e.button === 2 || this.spaceDown) { this.mousePan = { x: e.clientX, y: e.clientY, tx: this.view.tx, ty: this.view.ty }; return; }
    if (e.button !== 0) return;
    this._beginStroke(e);
  }
  _move(e) {
    e.preventDefault();
    if (e.pointerType === 'touch') {
      const p = this.pointers.get(e.pointerId); if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      if (this.tap && Math.hypot(p.x - p.sx, p.y - p.sy) > 14) this.tap.moved = true;
      if (this.gesture) { this._updateGesture(); return; }
    }
    if (this.mousePan) { this.view.tx = this.mousePan.tx + e.clientX - this.mousePan.x; this.view.ty = this.mousePan.ty + e.clientY - this.mousePan.y; this.applyView(); return; }
    this._moveCursor(e);
    const st = this.stroke;
    if (st && e.pointerId === st.id) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (evs && evs.length) for (const ce of evs) this._addSample(ce); else this._addSample(e);
    }
  }
  _up(e, cancelled = false) {
    e.preventDefault();
    try { this.vp.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (e.pointerType === 'pen') { this.penActive = false; this.penUpAt = performance.now(); this._endStroke(); return; }
    if (e.pointerType === 'touch') {
      this.pointers.delete(e.pointerId);
      if (this.stroke && this.stroke.id === e.pointerId) this._endStroke();
      if (this.pointers.size < 1 && this.gesture) this.gesture = null;
      if (this.pointers.size === 0) {
        const tap = this.tap; this.tap = null; this.gestureLock = false;
        if (tap && !cancelled && !tap.moved && performance.now() - tap.t0 < 380 && tap.max >= 2) { tap.max === 2 ? this.undo() : tap.max === 3 && this.redo(); this.emit('gesturetap', tap.max); }
      } else if (this.pointers.size === 1) this._startGesture(); // keep panning with the remaining finger, never start a stray stroke
      return;
    }
    if (this.mousePan) { this.mousePan = null; return; }
    this._endStroke();
  }
}
