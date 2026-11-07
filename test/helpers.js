// Synthetic "cat" line art used by tests and by the Perfect Artist demo (also bundled as an SVG sample).
import { makeMask, rasterizePrimitive } from '../public/js/artist.js';

export const CAT_SHAPES = [
  { kind: 'ellipse', center: [0.5, 0.72], radius: [0.27, 0.19], rotation: 0 },   // body
  { kind: 'ellipse', center: [0.5, 0.36], radius: [0.19, 0.17], rotation: 0 },   // head
  { kind: 'polygon', points: [[0.34, 0.26], [0.33, 0.1], [0.45, 0.2]] },          // left ear
  { kind: 'polygon', points: [[0.66, 0.26], [0.67, 0.1], [0.55, 0.2]] },          // right ear
];

export function catTruthMask(W, H) {
  const m = makeMask(W, H);
  for (const s of CAT_SHAPES) rasterizePrimitive(m, W, H, s, 'fill');
  return m;
}

/** RGBA line art: black outlines of the cat shapes on white. */
export function catLineArt(W, H) {
  const outline = makeMask(W, H);
  for (const s of CAT_SHAPES) rasterizePrimitive(outline, W, H, s, 'outline', 2);
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { const v = outline[i] ? 20 : 250; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
  return rgba;
}

/** RGBA "painting": warm orange blob on a cool background with a dark shadow patch. */
export function blobPainting(W, H) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4; const dx = (x / W - 0.5) / 0.3, dy = (y / H - 0.5) / 0.25, inside = dx * dx + dy * dy < 1;
    const shadow = inside && x / W > 0.55;
    const c = shadow ? [120, 60, 30] : inside ? [240, 170, 80] : [170, 200, 230];
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
  }
  return rgba;
}
