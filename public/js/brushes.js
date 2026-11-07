// brushes.js — brush catalogue + a DOM-free StrokePainter that renders into any 2D context.
// The same painter drives the live canvas, the brush previews, and the headless tests.
import { hexToRgb, mulberry32 } from './construct.js';

export const BRUSH_LIST = [
  { id: 'pencil', name: 'Pencil', icon: '✏️', kind: 'stamp', tip: 'round', hardness: 0.6, grain: 0.55, size: [1.5, 40, 5], opacity: 1, flow: 0.24, spacing: 0.09, rotate: 'random', pressureSize: 0.6, pressureAlpha: 0.2, tilt: true, smoothing: 0.12, desc: 'Graphite. Press harder or tilt for tone.' },
  { id: 'ink', name: 'Fine pen', icon: '🖋️', kind: 'stamp', tip: 'round', hardness: 0.96, size: [1, 40, 6], opacity: 1, flow: 1, buffered: true, spacing: 0.05, pressureSize: 0.3, smoothing: 0.5, desc: 'Clean, smooth ink line. Great for contours.' },
  { id: 'marker', name: 'Marker', icon: '🖍️', kind: 'stamp', tip: 'chisel', angle: -0.6, hardness: 1, size: [6, 90, 24], opacity: 0.7, flow: 1, buffered: true, blend: 'multiply', spacing: 0.04, smoothing: 0.35, desc: 'Flat chisel tip that darkens where it overlaps.' },
  { id: 'airbrush', name: 'Soft round', icon: '💨', kind: 'stamp', tip: 'round', hardness: 0, size: [10, 220, 48], opacity: 1, flow: 0.09, spacing: 0.08, pressureSize: 0.7, pressureAlpha: 0.15, smoothing: 0.2, desc: 'Soft, buildable shading and glows.' },
  { id: 'watercolor', name: 'Watercolor', icon: '💧', kind: 'stamp', tip: 'wc', size: [10, 160, 38], opacity: 0.55, flow: 1, buffered: true, blend: 'multiply', spacing: 0.13, jitter: 0.1, pressureSize: 0.75, smoothing: 0.3, desc: 'Transparent wash with darker edges. Layers glaze darker.' },
  { id: 'oil', name: 'Oil / flat', icon: '🖌️', kind: 'bristle', size: [8, 140, 36], opacity: 0.95, bristles: 18, pressureSize: 0.6, smoothing: 0.3, desc: 'Streaky bristle brush for blocking in color.' },
  { id: 'charcoal', name: 'Charcoal', icon: '🖤', kind: 'stamp', tip: 'round', hardness: 0.35, grain: 1, size: [6, 100, 24], opacity: 1, flow: 0.32, spacing: 0.16, rotate: 'random', jitterPos: 0.12, pressureSize: 0.5, pressureAlpha: 0.35, tilt: true, smoothing: 0.1, desc: 'Rough, grainy, broad strokes.' },
  { id: 'pixel', name: 'Pixel', icon: '🟦', kind: 'pixel', size: [2, 64, 12], opacity: 1, smoothing: 0, desc: 'Hard square pixels snapped to a grid. Size = pixel size.' },
  { id: 'smudge', name: 'Blend', icon: '👆', kind: 'smudge', tip: 'round', hardness: 0.1, size: [10, 160, 40], opacity: 1, strength: 0.55, spacing: 0.12, smoothing: 0.2, desc: 'Smears existing paint to blend edges.' },
  { id: 'eraser', name: 'Eraser', icon: '🧽', kind: 'stamp', erase: true, tip: 'round', hardness: 0.75, size: [4, 160, 30], opacity: 1, flow: 1, spacing: 0.07, pressureSize: 0.5, smoothing: 0.2, desc: 'Removes paint on the active layer.' },
];
export const BRUSHES = Object.fromEntries(BRUSH_LIST.map((b) => [b.id, b]));

/* ---------- tip + grain caches ---------- */
const mkCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
};
const grainCache = new Map();
function grainCanvas(S, strength) {
  const key = `${S}|${strength}`;
  if (grainCache.has(key)) return grainCache.get(key);
  const c = mkCanvas(S, S), ctx = c.getContext('2d'), img = ctx.createImageData(S, S), rnd = mulberry32(1234 + Math.round(strength * 100));
  for (let i = 0; i < S * S; i++) {
    const a = 1 - strength + strength * Math.pow(rnd(), 1.5);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  ctx.putImageData(img, 0, 0); grainCache.set(key, c); return c;
}
const tipCache = new Map();
export function makeTip(brush, color) {
  const key = `${brush.id}|${color}`;
  if (tipCache.has(key)) return tipCache.get(key);
  const S = 96, c = mkCanvas(S, S), ctx = c.getContext('2d');
  const [r, g, b] = brush.erase ? [0, 0, 0] : hexToRgb(color) || [0, 0, 0];
  const rgba = (a) => `rgba(${r},${g},${b},${a})`;
  if (brush.tip === 'chisel') {
    ctx.translate(S / 2, S / 2); ctx.rotate(brush.angle || 0); ctx.fillStyle = rgba(1);
    const w = S * 0.98, h = S * 0.3, rad = h * 0.3;
    ctx.beginPath(); ctx.moveTo(-w / 2 + rad, -h / 2); ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, rad); ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, rad); ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, rad); ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, rad); ctx.fill();
  } else if (brush.tip === 'wc') {
    const gr = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, rgba(0.55)); gr.addColorStop(0.62, rgba(0.6)); gr.addColorStop(0.86, rgba(0.95)); gr.addColorStop(1, rgba(0));
    ctx.fillStyle = gr; ctx.fillRect(0, 0, S, S);
  } else {
    const gr = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2), h = Math.max(0, Math.min(0.97, brush.hardness ?? 0.5));
    gr.addColorStop(0, rgba(1)); gr.addColorStop(h, rgba(1)); gr.addColorStop(1, rgba(0));
    ctx.fillStyle = gr; ctx.fillRect(0, 0, S, S);
  }
  if (brush.grain) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(grainCanvas(S, brush.grain), 0, 0); }
  tipCache.set(key, c); return c;
}

function shade([r, g, b], d) { // quick lightness shift in RGB space (d: -1..1)
  const k = d >= 0 ? 255 : 0, t = Math.abs(d);
  return [r + (k - r) * t, g + (k - g) * t, b + (k - b) * t].map((v) => Math.round(Math.max(0, Math.min(255, v))));
}

/**
 * StrokePainter — renders one stroke.
 * opts: { brush, color, size, opacity, ctx (target layer), buf (buffer ctx for buffered brushes), docW, docH, seed }
 * call move(x,y,pressure,tiltAmount) repeatedly, then end(). `dirty` is the touched rect.
 */
export class StrokePainter {
  constructor(o) {
    Object.assign(this, { brush: o.brush, color: o.color, size: o.size, opacity: o.opacity ?? 1, ctx: o.ctx, bufCtx: o.buf, docW: o.docW, docH: o.docH });
    this.rnd = mulberry32(o.seed ?? ((Math.random() * 1e9) | 0));
    this.last = null; this.leftover = 0; this.dirty = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    this.len = 0; this.heading = null;
    const br = this.brush;
    this.target = br.buffered ? this.bufCtx : this.ctx;
    if (br.kind === 'bristle') {
      const rgb = hexToRgb(this.color) || [0, 0, 0], n = br.bristles || 16;
      this.bristles = Array.from({ length: n }, (_, i) => ({ off: (i / (n - 1)) * 2 - 1 + (this.rnd() - 0.5) * 0.08, col: shade(rgb, (this.rnd() - 0.5) * 0.28), a: 0.72 + this.rnd() * 0.28, w: 0.8 + this.rnd() * 0.6, prev: null }));
    }
    if (br.kind === 'smudge') { this.carry = mkCanvas(8, 8); this.tmp = mkCanvas(8, 8); this.carryReady = false; }
  }
  _grow(x, y, r) {
    const d = this.dirty; d.x0 = Math.min(d.x0, x - r); d.y0 = Math.min(d.y0, y - r); d.x1 = Math.max(d.x1, x + r); d.y1 = Math.max(d.y1, y + r);
  }
  _params(p, tilt) {
    const br = this.brush, pc = Math.pow(Math.max(0.02, p), 0.85);
    const ps = br.pressureSize ?? 1, pa = br.pressureAlpha ?? 1;
    let diam = this.size * (ps + (1 - ps) * pc), alpha = (br.flow ?? 1) * (pa + (1 - pa) * pc);
    if (br.tilt && tilt > 0) { diam *= 1 + tilt * 1.6; alpha *= 1 - tilt * 0.45; }
    if (br.jitter) diam *= 1 + (this.rnd() - 0.5) * 2 * br.jitter;
    return { diam: Math.max(1, diam), alpha: Math.max(0.01, Math.min(1, alpha)) };
  }
  move(x, y, p = 0.5, tilt = 0) {
    const br = this.brush; const cur = { x, y, p, tilt };
    if (!this.last) { this.last = cur; this._first(cur); return; }
    const a = this.last; const d = Math.hypot(x - a.x, y - a.y);
    if (br.kind === 'pixel') { this._pixelSeg(a, cur); this.last = cur; return; }
    if (d < 0.35) { this.last = { ...cur, x: a.x, y: a.y }; return; }
    this.len += d;
    if (br.kind === 'bristle') this._bristleSeg(a, cur, d);
    else this._stampSeg(a, cur, d);
    this.last = cur;
  }
  _first(c) {
    const br = this.brush;
    if (br.kind === 'bristle') { this._bristleSeg(c, { ...c, x: c.x + 0.01 }, 0.01); return; }
    if (br.kind === 'pixel') { this._pixelSeg(c, c); return; }
    if (br.kind === 'smudge') { this._smudgeSample(c); return; }
    this._dab(c.x, c.y, c.p, c.tilt);
  }
  _stampSeg(a, b, d) {
    const br = this.brush;
    const { diam } = this._params((a.p + b.p) / 2, (a.tilt + b.tilt) / 2);
    const spacing = Math.max(0.7, (br.spacing ?? 0.1) * diam);
    let dist = this.leftover, pos = 0;
    while (dist + (d - pos) >= spacing) {
      pos += spacing - dist; dist = 0; const t = pos / d;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, p = a.p + (b.p - a.p) * t, tl = a.tilt + (b.tilt - a.tilt) * t;
      if (br.kind === 'smudge') this._smudgeDab(x, y, p); else this._dab(x, y, p, tl);
    }
    this.leftover = dist + (d - pos);
  }
  _dab(x, y, p, tilt) {
    const br = this.brush, { diam, alpha } = this._params(p, tilt), ctx = this.target;
    if (br.jitterPos) { x += (this.rnd() - 0.5) * br.jitterPos * diam; y += (this.rnd() - 0.5) * br.jitterPos * diam; }
    const tip = makeTip(br, this.color), rot = br.rotate === 'random' ? this.rnd() * Math.PI * 2 : 0, c = Math.cos(rot), s = Math.sin(rot);
    const buffered = !!br.buffered;
    ctx.globalAlpha = buffered ? 1 : alpha * this.opacity;
    ctx.globalCompositeOperation = br.erase ? 'destination-out' : 'source-over';
    ctx.setTransform(c, s, -s, c, x, y);
    ctx.drawImage(tip, -diam / 2, -diam / 2, diam, diam);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    this._grow(x, y, diam * 0.75);
  }
  _bristleSeg(a, b, d) {
    const br = this.brush, ctx = this.ctx, { diam } = this._params(b.p, 0);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (this.heading === null) this.heading = ang;
    else { let da = ang - this.heading; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI; this.heading += da * 0.25; }
    const ax = -Math.sin(this.heading), ay = Math.cos(this.heading), W = diam, n = this.bristles.length;
    const load = 1 - Math.min(0.45, this.len / (this.size * 45)); // paint runs dry slowly → dry-brush texture
    ctx.lineCap = 'round';
    for (const br_ of this.bristles) {
      const cx = b.x + ax * br_.off * W / 2, cy = b.y + ay * br_.off * W / 2;
      const px = br_.prev ? br_.prev[0] : cx, py = br_.prev ? br_.prev[1] : cy;
      ctx.globalAlpha = Math.min(1, br_.a * load * this.opacity);
      ctx.strokeStyle = `rgb(${br_.col[0]},${br_.col[1]},${br_.col[2]})`;
      ctx.lineWidth = Math.max(1, (W / n) * 1.55 * br_.w);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cx, cy); ctx.stroke();
      br_.prev = [cx, cy];
    }
    ctx.globalAlpha = 1; this._grow(b.x, b.y, W * 0.8);
  }
  _pixelSeg(a, b) {
    const cell = Math.max(1, Math.round(this.size)), ctx = this.ctx;
    let x0 = Math.floor(a.x / cell), y0 = Math.floor(a.y / cell); const x1 = Math.floor(b.x / cell), y1 = Math.floor(b.y / cell);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let err = dx + dy;
    ctx.fillStyle = this.color; ctx.globalAlpha = this.opacity;
    for (let guard = 0; guard < 4000; guard++) {
      ctx.fillRect(x0 * cell, y0 * cell, cell, cell); this._grow(x0 * cell + cell / 2, y0 * cell + cell / 2, cell);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; }
    }
    ctx.globalAlpha = 1;
  }
  _smudgeSample(c) {
    const dm = Math.ceil(this.size); if (this.carry.width !== dm) { this.carry.width = this.carry.height = dm; this.tmp.width = this.tmp.height = dm; }
    const cc = this.carry.getContext('2d'); cc.clearRect(0, 0, dm, dm);
    cc.drawImage(this.ctx.canvas, c.x - dm / 2, c.y - dm / 2, dm, dm, 0, 0, dm, dm); this.carryReady = true;
  }
  _smudgeDab(x, y, p) {
    if (!this.carryReady) return;
    const dm = Math.ceil(this.size), ctx = this.ctx, tc = this.tmp.getContext('2d'), cc = this.carry.getContext('2d');
    tc.globalCompositeOperation = 'source-over'; tc.clearRect(0, 0, dm, dm); tc.drawImage(this.carry, 0, 0);
    tc.globalCompositeOperation = 'destination-in'; tc.drawImage(makeTip(this.brush, '#000000'), 0, 0, dm, dm);
    ctx.globalAlpha = (this.brush.strength ?? 0.5) * (0.5 + 0.5 * p); ctx.drawImage(this.tmp, x - dm / 2, y - dm / 2); ctx.globalAlpha = 1;
    cc.globalAlpha = 0.4; cc.drawImage(ctx.canvas, x - dm / 2, y - dm / 2, dm, dm, 0, 0, dm, dm); cc.globalAlpha = 1;
    this._grow(x, y, dm * 0.75);
  }
  /** Finish: commits buffered brushes onto the layer. Returns the dirty rect (integers, clipped) or null. */
  end() {
    const d = this.dirty; if (!isFinite(d.x0)) return null;
    const r = { x: Math.max(0, Math.floor(d.x0) - 2), y: Math.max(0, Math.floor(d.y0) - 2) };
    r.w = Math.min(this.docW, Math.ceil(d.x1) + 2) - r.x; r.h = Math.min(this.docH, Math.ceil(d.y1) + 2) - r.y;
    if (r.w <= 0 || r.h <= 0) return null;
    if (this.brush.buffered) {
      this.ctx.globalAlpha = this.opacity; this.ctx.globalCompositeOperation = this.brush.blend || 'source-over';
      this.ctx.drawImage(this.bufCtx.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      this.ctx.globalAlpha = 1; this.ctx.globalCompositeOperation = 'source-over';
      this.bufCtx.clearRect(r.x, r.y, r.w, r.h);
    }
    return r;
  }
}

/** Draw a sample squiggle for the brush picker / brush preview strip. */
export function renderBrushSample(canvas, brushId, color = '#34323D', size = null, opacity = 1) {
  const br = BRUSHES[brushId]; if (!br) return;
  const w = canvas.width, h = canvas.height, ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, w, h);
  const buf = mkCanvas(w, h), bctx = buf.getContext('2d');
  if (br.erase || br.kind === 'smudge') { ctx.fillStyle = '#7c6bb3'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#f6c8d6'; ctx.fillRect(0, h * 0.2, w, h * 0.3); }
  const sz = Math.min(size ?? br.size[2], h * 0.5);
  const sp = new StrokePainter({ brush: br, color, size: br.kind === 'pixel' ? Math.max(3, Math.round(h / 8)) : sz, opacity, ctx, buf: bctx, docW: w, docH: h, seed: 42 });
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const t = i / N, x = 10 + t * (w - 20), y = h / 2 + Math.sin(t * Math.PI * 2) * h * 0.22, p = 0.25 + 0.75 * Math.sin(t * Math.PI);
    sp.move(x, y, p, 0);
  }
  sp.end();
}
