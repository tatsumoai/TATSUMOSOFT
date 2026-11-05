import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sources, deferredSources } from './sources.mjs';
import { runRound } from './probe.mjs';
import { redact, renderHtml } from './report.mjs';

const { values } = parseArgs({ options: {
  sources: { type: 'string' }, rounds: { type: 'string', default: '1' },
  interval: { type: 'string', default: '60' }, label: { type: 'string', default: 'local-machine' },
  help: { type: 'boolean' }, list: { type: 'boolean' }
} });
if (values.help || values.list) {
  console.log('npm run probe -- [--sources id,id] [--rounds 2] [--interval 60] [--label local-machine]');
  console.log('Default: one bounded pass. Repeat interval is in seconds, minimum 60. Ctrl+C stops.');
  console.table(sources.map(s => ({ id: s.id, name: s.name, credential: s.credential?.env || 'none' })));
  process.exit(0);
}
const rounds = Number(values.rounds), interval = Number(values.interval);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error('--rounds must be an integer from 1 to 10');
if (!Number.isInteger(interval) || interval < 60 || interval > 3600) throw new Error('--interval must be 60 to 3600 seconds');
const ids = values.sources?.split(',');
if (ids?.some(id => !sources.some(s => s.id === id))) throw new Error('Unknown source ID. Use --list.');
const selected = ids ? sources.filter(s => ids.includes(s.id)) : sources;
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), completedAt: null, environment: values.label,
  nodeVersion: process.version, intervalSeconds: interval,
  limitations: 'Results describe access from this machine at these timestamps. Hosted-server access and sustained collection are untested. Success does not establish permission, refresh cadence, or complete coverage.',
  rounds: [], deferred: deferredSources };
const output = fileURLToPath(new URL('../reports/', import.meta.url));
await mkdir(output, { recursive: true });
const stem = report.startedAt.replaceAll(':', '-').replaceAll('.', '-');
let prior = [], lastStart = 0;
for (let i = 0; i < rounds; i++) {
  if (i) {
    console.log('Waiting for the next scheduled check. Ctrl+C stops.');
    await sleep(Math.max(0, lastStart + interval * 1000 - Date.now()));
  }
  lastStart = Date.now();
  console.log(`Round ${i + 1}/${rounds}`);
  const results = await runRound(selected, prior, { onResult: r => console.log(`${r.id}: ${r.status} (${r.recordCount} records${r.httpStatus ? `, HTTP ${r.httpStatus}` : ''})`) });
  report.rounds.push({ round: i + 1, startedAt: new Date(lastStart).toISOString(), results });
  report.completedAt = new Date().toISOString();
  const clean = redact(report);
  const json = JSON.stringify(clean, null, 2) + '\n';
  const html = renderHtml(clean);
  await Promise.all([
    writeFile(join(output, `${stem}.json`), json), writeFile(join(output, `${stem}.html`), html),
    writeFile(join(output, 'latest.json'), json), writeFile(join(output, 'latest.html'), html)
  ]);
  prior = results;
}
console.log(`Report: ${join(output, 'latest.html')}`);
console.log(`Data:   ${join(output, 'latest.json')}`);
