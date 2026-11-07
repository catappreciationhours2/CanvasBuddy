import test from 'node:test';
import assert from 'node:assert/strict';
import { runRedTeam } from '../public/js/redteam.js';

test('red-team battery: every attack is stopped and no normal input is blocked', () => {
  const r = runRedTeam({ secrets: ['sk-or-v1-testsecret0123456789'], canary: 'cnry_test0123456789ab' });
  const failed = r.categories.flatMap((c) => c.cases.filter((x) => !x.ok).map((x) => `${c.name}: ${x.name} (${x.detail})`));
  assert.deepEqual(failed, []);
  assert.ok(r.total >= 45, `battery too small: ${r.total}`);
  assert.ok(r.knownGaps.length >= 2, 'limits are reported honestly');
});

test('red-team details never contain the secret or canary', () => {
  const secret = 'sk-or-v1-testsecret0123456789', canary = 'cnry_test0123456789ab';
  const text = JSON.stringify(runRedTeam({ secrets: [secret], canary }));
  assert.ok(!text.includes(secret) && !text.includes(canary));
});
