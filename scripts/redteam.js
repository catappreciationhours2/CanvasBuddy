// npm run redteam — runs the whole attack battery and prints a scoreboard. Exit code 1 if any attack gets through.
import { runRedTeam } from '../public/js/redteam.js';
const r = runRedTeam({ secrets: ['sk-or-v1-demo-not-a-real-key-0123456789'], canary: 'cnry_demo0123456789' });
for (const c of r.categories) {
  const ok = c.cases.filter((x) => x.ok).length;
  console.log(`\n${ok === c.cases.length ? '✅' : '❌'} ${c.name}  (${ok}/${c.cases.length})\n   ${c.why}`);
  for (const x of c.cases) console.log(`   ${x.ok ? '✓' : '✗'} ${x.name} — ${x.detail}`);
}
console.log(`\n🛡️  ${r.passed}/${r.total} checks passed`);
console.log('\nKnown limits (handled by other layers):'); r.knownGaps.forEach((g) => console.log(' • ' + g));
process.exit(r.allPassed ? 0 : 1);
