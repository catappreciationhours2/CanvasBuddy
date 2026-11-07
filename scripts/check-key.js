// Run this FIRST at the hackathon:  npm run check-key
// Verifies the OpenRouter key, lists cheap vision-capable models, and sends one tiny test request.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) for (const l of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(l); if (m && !l.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }

const key = process.env.OPENROUTER_API_KEY, base = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
if (!key) { console.error('✗ OPENROUTER_API_KEY is not set (put it in .env)'); process.exit(1); }

const r = await fetch(`${base}/models`).catch((e) => { console.error('✗ cannot reach OpenRouter:', e.message); process.exit(1); });
const models = (await r.json()).data || [];
const vision = models.filter((m) => (m.architecture?.input_modalities || []).includes('image') && (m.architecture?.output_modalities || ['text']).includes('text') && !/image/.test(m.id));
const cheap = [...vision].sort((a, b) => +a.pricing?.prompt - +b.pricing?.prompt).filter((m) => +m.pricing?.prompt > 0).slice(0, 12);
console.log(`✓ ${models.length} models; ${vision.length} accept image input. Cheapest paid vision models:`);
for (const m of cheap) console.log(`   ${m.id.padEnd(48)} $${(+m.pricing.prompt * 1e6).toFixed(2)}/M in`);
const want = process.env.OPENROUTER_MODEL || 'google/gemini-3-flash-preview';
console.log(`\nConfigured model: ${want} → ${models.some((m) => m.id === want) ? '✓ exists' : '✗ NOT in catalog (server will auto-pick a vision model, or set OPENROUTER_MODEL)'}`);

const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const t0 = Date.now();
const res = await fetch(`${base}/chat/completions`, {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: want, max_tokens: 20, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: ready' }, { type: 'image_url', image_url: { url: tiny } }] }] }),
});
const body = await res.text();
if (res.ok) console.log(`✓ test request OK in ${Date.now() - t0}ms: ${JSON.parse(body).choices?.[0]?.message?.content?.slice(0, 60)}`);
else console.log(`✗ test request failed: HTTP ${res.status} ${body.slice(0, 300)}`);
