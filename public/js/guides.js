// guides.js — draws a lesson step's guides into the SVG overlay (and serialises them for export).
import { resolveGuide } from './lesson.js';
import { renderGuideRaster } from './palette.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => { const e = document.createElementNS(NS, name); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
const STROKE = '#7c6bd6', FILL = 'rgba(201,184,240,0.16)';

export function setupGuideSvg(svg, w, h) {
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('xmlns', NS); svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink'); svg.replaceChildren();
}

const TONE_FILL = { darkest: 'rgba(40,38,52,.52)', dark: 'rgba(80,76,100,.40)', mid: 'rgba(158,152,176,.38)', light: 'rgba(255,230,150,.40)', highlight: 'rgba(255,240,170,.55)' };
export const ACTION_TEXT = (p) => p.action === 'blend_edges' ? 'Soften this edge' : p.action === 'lift' ? 'Lift out the light' : p.action === 'hatch' ? `Hatch ${p.strength >= 3 ? 'densely' : p.strength === 2 ? 'evenly' : 'lightly'}` : `Shade ${p.strength >= 3 ? 'strongly' : p.strength === 2 ? 'medium' : 'lightly'}`;

function patternDefs() {
  const d = el('defs');
  const pat = el('pattern', { id: 'cbHatch', width: 14, height: 14, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.appendChild(el('line', { x1: 0, y1: 0, x2: 0, y2: 14, stroke: 'rgba(52,50,61,.55)', 'stroke-width': 3.5 })); d.appendChild(pat);
  const dots = el('pattern', { id: 'cbDots', width: 16, height: 16, patternUnits: 'userSpaceOnUse' });
  dots.appendChild(el('circle', { cx: 8, cy: 8, r: 2.4, fill: 'rgba(214,170,40,.8)' })); d.appendChild(dots);
  return d;
}
/**
 * One marker, drawn as pure shape — no numbers, no text on the canvas (it would clog the drawing area; the step card lists what each
 * shape is). Look is the code: purple outline = draw this line; tinted hollow = a dark opening; hatching = shade here;
 * dots = lift light out; fat dotted edge = soften this edge. A <title> gives desktop users the name on hover.
 */
function drawTarget(svg, p, px, W) {
  const g = el('g', { class: `target ${p.role} ${p.action || ''}` });
  const geomAttrs = p.kind === 'ellipse' ? (() => { const [cx, cy] = px(p.center); return { tag: 'ellipse', a: { cx, cy, rx: p.radius[0] * W, ry: p.radius[1] * (px([0, 1])[1]), transform: `rotate(${p.rotation || 0} ${cx} ${cy})` } }; })()
    : { tag: 'polygon', a: { points: p.points.map((q) => px(q).join(',')).join(' ') } };
  const shape = (a) => el(geomAttrs.tag, { ...geomAttrs.a, ...a });
  if (p.role === 'feature') {
    g.appendChild(shape({ fill: p.outline ? 'none' : 'rgba(201,184,240,.18)', stroke: '#7c6bd6', 'stroke-width': 4, class: 'g', 'stroke-linejoin': 'round' }));
  } else if (p.action === 'blend_edges') {
    g.appendChild(shape({ fill: 'none', stroke: 'rgba(124,107,214,.35)', 'stroke-width': 22, 'stroke-linejoin': 'round', class: 'g' }));
    g.appendChild(shape({ fill: 'none', stroke: '#7c6bd6', 'stroke-width': 3.5, 'stroke-dasharray': '3 10', 'stroke-linecap': 'round', class: 'g' }));
  } else if (p.action === 'lift') {
    g.appendChild(shape({ fill: TONE_FILL[p.tone] || TONE_FILL.highlight, stroke: '#d6a928', 'stroke-width': 4, 'stroke-dasharray': '2 9', 'stroke-linecap': 'round', class: 'g' }));
    g.appendChild(shape({ fill: 'url(#cbDots)', stroke: 'none' }));
  } else {
    g.appendChild(shape({ fill: TONE_FILL[p.tone] || TONE_FILL.dark, stroke: '#4a4758', 'stroke-width': 4, 'stroke-linejoin': 'round', class: 'g' }));
    g.appendChild(shape({ fill: 'url(#cbHatch)', stroke: 'none', opacity: Math.min(1, 0.3 + 0.25 * (p.strength || 2)) }));
  }
  const t = el('title'); t.textContent = p.role === 'feature' ? p.label : `${p.label}: ${ACTION_TEXT(p)}`; g.appendChild(t);
  svg.appendChild(g);
}

/** Render guides for `step` into svg. Returns {prims, rasters} so callers can describe what is shown. */
export function renderStepGuides(svg, step, summary, maps, doc, { animate = true } = {}) {
  setupGuideSvg(svg, doc.w, doc.h);
  const W = doc.w, H = doc.h, px = (p) => [p[0] * W, p[1] * H];
  const prims = [], rasters = [];
  svg.appendChild(patternDefs());
    const common = { fill: 'none', stroke: STROKE, 'stroke-width': 4, class: 'g', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const thin = { ...common, class: 'g thin', 'stroke-width': 2, opacity: 0.7 };
  const add = (e, draw) => { if (animate && draw) { e.setAttribute('pathLength', '1'); e.classList.add('draw-in'); } svg.appendChild(e); };
  for (const g of step.guides || []) {
    for (const p of resolveGuide(g, summary)) {
      if (p.kind === 'raster') {
        const c = maps ? renderGuideRaster(maps, p.name) : null; if (!c) continue;
        const im = el('image', { x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none', class: 'raster-guide' });
        const url = c.toDataURL('image/png'); im.setAttribute('href', url); im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
        svg.appendChild(im); rasters.push(p.name); continue;
      }
      prims.push(p);
      if (p.kind === 'strokes') { // traced line art: one path, every stroke, no per-stroke animation (there can be hundreds)
        const d = p.paths.map((pa) => `M${pa.map(([x, y]) => `${(x * W).toFixed(1)} ${(y * H).toFixed(1)}`).join('L')}`).join(' ');
        const e = el('path', { d, fill: 'none', stroke: STROKE, 'stroke-width': p.level === 'fine' ? 2 : 3, opacity: p.level === 'fine' ? 0.7 : 0.92, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'g lineart' });
        const t = el('title'); t.textContent = p.label; e.appendChild(t); svg.appendChild(e); continue;
      }
      if (p.construct) { // build-up solids: light 3D scaffolding, no fill so overlapping solids stay readable; back edges and equators are dashed
        const cs = { ...common, fill: 'none', 'stroke-width': p.minor ? 2.5 : 3.5, opacity: p.minor ? 0.75 : 0.95, ...(p.minor || p.kind === 'line' ? { 'stroke-dasharray': '8 7' } : {}) };
        const pts = (a) => a.map((q) => px(q).join(',')).join(' ');
        let e = null;
        if (p.kind === 'ellipse') { const [cx, cy] = px(p.center); e = el('ellipse', { ...cs, cx, cy, rx: p.radius[0] * W, ry: p.radius[1] * H, transform: `rotate(${p.rotation || 0} ${cx} ${cy})` }); }
        else if (p.kind === 'polygon') e = el('polygon', { ...cs, points: pts(p.points) });
        else if (p.kind === 'polyline') e = el('polyline', { ...cs, points: pts(p.points) });
        else if (p.kind === 'line') { const [a, b] = p.points.map(px); e = el('line', { ...cs, x1: a[0], y1: a[1], x2: b[0], y2: b[1] }); }
        if (e) { const t = el('title'); t.textContent = p.label; e.appendChild(t); add(e, true); }
        continue;
      }
      switch (p.kind) {
        case 'ellipse': if (p.role) { drawTarget(svg, p, px, W); break; } { const [cx, cy] = px(p.center); add(el('ellipse', { ...common, fill: FILL, cx, cy, rx: p.radius[0] * W, ry: p.radius[1] * H, transform: `rotate(${p.rotation || 0} ${cx} ${cy})` }), true); break; }
        case 'polygon': if (p.role) { drawTarget(svg, p, px, W); break; } add(el('polygon', { ...common, fill: p.sketch ? 'none' : FILL, 'stroke-width': p.sketch ? 5 : 4, points: p.points.map((q) => px(q).join(',')).join(' ') }), true); break;
        case 'polyline': add(el('polyline', { ...common, points: p.points.map((q) => px(q).join(',')).join(' ') }), true); break;
        case 'line': { const [a, b] = p.points.map(px); add(el('line', { ...common, 'stroke-dasharray': '10 8', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }), false); break; }
        case 'rect': add(el('rect', { ...common, 'stroke-dasharray': '10 8', x: p.x * W, y: p.y * H, width: p.w * W, height: p.h * H, rx: 6 }), false); break;
        case 'grid': {
          for (let i = 1; i < p.cols; i++) svg.appendChild(el('line', { ...thin, x1: (i / p.cols) * W, y1: 0, x2: (i / p.cols) * W, y2: H }));
          for (let j = 1; j < p.rows; j++) svg.appendChild(el('line', { ...thin, x1: 0, y1: (j / p.rows) * H, x2: W, y2: (j / p.rows) * H }));
          break;
        }
        case 'cross': { const [cx, cy] = px(p.center), s = (p.size || 0.04) * Math.max(W, H); svg.appendChild(el('line', { ...common, x1: cx - s, y1: cy, x2: cx + s, y2: cy })); svg.appendChild(el('line', { ...common, x1: cx, y1: cy - s, x2: cx, y2: cy + s })); svg.appendChild(el('circle', { ...common, cx, cy, r: s * 0.35 })); break; }
        default: break;
      }
    }
  }
  return { prims, rasters };
}

/** Serialise the current guide overlay as a standalone SVG string (for export into other apps). */
export function guideSvgString(svg) {
  const clone = svg.cloneNode(true); clone.removeAttribute('style'); clone.removeAttribute('class');
  clone.querySelectorAll('.draw-in').forEach((e) => { e.classList.remove('draw-in'); e.removeAttribute('pathLength'); });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/** Rasterise the guide SVG to a transparent PNG blob. */
export function guidePng(svg, w, h) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([guideSvgString(svg)], { type: 'image/svg+xml' }), url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); URL.revokeObjectURL(url); c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not rasterise guides')); }; img.src = url;
  });
}
