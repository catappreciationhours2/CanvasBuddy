import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TINY = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function startMock(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const s = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const body = b ? JSON.parse(b) : {}; calls.push({ url: req.url, body }); handler(req, res, body, calls); });
    }).listen(0, '127.0.0.1', () => resolve({ s, calls, port: s.address().port }));
  });
}
function startApp(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const p = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, OPENROUTER_API_KEY: '', ...env, PORT: String(port), HOST: '127.0.0.1' } });
    let out = ''; p.stdout.on('data', (d) => { out += d; if (out.includes('running')) resolve({ p, port }); });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (c) => reject(new Error(`server exited ${c}: ${out}`)));
    setTimeout(() => reject(new Error('server start timeout: ' + out)), 5000);
  });
}
const post = (port, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('no API key: status says so, AI routes return a graceful fallback signal, static files work', async () => {
  const { p, port } = await startApp({});
  try {
    const st = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
    assert.equal(st.hasKey, false);
    const r = await post(port, '/api/analyze', { image: TINY, mode: 'sketch' });
    assert.equal(r.ok, false); assert.equal(r.reason, 'no_key');
    const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    assert.match(html, /CanvasBuddy/);
    const bad = await post(port, '/api/analyze', { image: 'not-an-image' });
    assert.equal(bad.ok, false);
    const trav = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
    assert.ok([403, 404].includes(trav.status));
    const env = await fetch(`http://127.0.0.1:${port}/.env`); assert.equal(env.status, 404);
  } finally { p.kill(); }
});

test('with a (mock) key: tolerant JSON parsing, response_format fallback, validation, critique', async () => {
  const lessonJson = {
    analysis: { image_type: 'line_art', complexity: 'beginner', confidence: 0.8, summary: 'A cat built from ovals.' },
    steps: [
      { id: 'step-1', title: 'Big ovals', instruction: 'Sketch two ovals.', why: 'Big shapes first.', guides: [{ kind: 'auto', name: 'construction_ellipses' }, { kind: 'ellipse', center: [9, 9], radius: [0.2, 0.2] }, { kind: 'polygon', points: [[0, 0]] }], tool_hint: 'light pencil' },
      { id: 'step-2', title: 'Outline', instruction: 'Connect them.', why: 'One flowing line.', guides: [{ kind: 'auto', name: 'contour' }] },
    ],
  };
  const mock = await startMock((req, res, body, calls) => {
    res.setHeader('Content-Type', 'application/json');
    if (body.response_format && calls.length === 1) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'response_format json_object not supported by this model' } })); }
    const sys = body.messages[0].content;
    const out = /progress check/.test(sys) ? { positive: 'Nice shapes', improve: 'Smooth the curve', evidence: 'curve', confidence: 'medium', tip: '' } : lessonJson;
    res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(out) + '\n```' } }] }));
  });
  const { p, port } = await startApp({ OPENROUTER_API_KEY: 'sk-test', OPENROUTER_BASE_URL: `http://127.0.0.1:${mock.port}`, OPENROUTER_MODEL: 'test/model' });
  try {
    const r = await post(port, '/api/analyze', { image: TINY, mode: 'sketch', medium: 'ink', level: 'beginner', hints: { stats: { guessedType: 'line_art' } } });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.source, 'ai');
    assert.equal(r.lesson.steps.length, 2);
    assert.deepEqual(r.lesson.steps[0].guides[1].center, [1, 1], 'out-of-range coords are clamped');
    assert.equal(r.lesson.steps[0].guides.length, 2, 'invalid polygon dropped');
    assert.equal(r.lesson.steps[0].brush, 'pencil');
    assert.ok(r.warnings.length >= 1);
    assert.ok(mock.calls.length >= 2, 'retried without response_format');
    assert.ok(mock.calls.at(-1).body.messages[1].content.some((c) => c.type === 'image_url'), 'image forwarded');
    const c = await post(port, '/api/critique', { reference: TINY, drawing: TINY, step: { title: 'x', instruction: 'y' }, metrics: { coverage: 0.5 } });
    assert.equal(c.ok, true); assert.equal(c.critique.positive, 'Nice shapes');
  } finally { p.kill(); mock.s.close(); }
});

test('provider failures never crash the server', async () => {
  const mock = await startMock((req, res) => { res.statusCode = 500; res.end('boom'); });
  const { p, port } = await startApp({ OPENROUTER_API_KEY: 'sk-test', OPENROUTER_BASE_URL: `http://127.0.0.1:${mock.port}` });
  try {
    const r = await post(port, '/api/analyze', { image: TINY });
    assert.equal(r.ok, false);
    const st = await fetch(`http://127.0.0.1:${port}/api/status`).then((x) => x.json());
    assert.ok(st.stats.failures >= 1);
  } finally { p.kill(); mock.s.close(); }
});

test('model returning non-JSON twice → clean fallback signal', async () => {
  const mock = await startMock((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'I think the picture is nice!' } }] })); });
  const { p, port } = await startApp({ OPENROUTER_API_KEY: 'sk-test', OPENROUTER_BASE_URL: `http://127.0.0.1:${mock.port}` });
  try {
    const r = await post(port, '/api/analyze', { image: TINY });
    assert.equal(r.ok, false); assert.equal(r.reason, 'bad_json');
  } finally { p.kill(); mock.s.close(); }
});
