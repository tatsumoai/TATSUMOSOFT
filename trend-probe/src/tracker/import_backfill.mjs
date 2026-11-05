import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './runtime.mjs';
import { mergeRanges } from './growth.mjs';

export async function importBackfill(store, path, { onProgress = () => {} } = {}) {
  const state = JSON.parse(readFileSync(path.replace(/\.ndjson$/, '.json'), 'utf8'));
  if (state.status !== 'complete' || !Number.isFinite(state.start) || !Number.isFinite(state.end)
      || !Number.isFinite(state.firstEvent) || !Number.isFinite(state.lastEvent)
      || state.end <= state.start || state.end-state.start > 36*3600000 || state.firstEvent > state.start+60000
      || state.lastEvent < state.end) throw new Error('Backfill has not completed its requested window');
  let imported = 0;
  let batch = [];
  const flush = () => {
    store.transaction(() => { for (const item of batch) store.ingestPost(item); });
    imported += batch.length; batch = [];
    if (imported % 10000 === 0) onProgress({ imported, total: state.posts });
  };
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    batch.push(JSON.parse(line));
    if (batch.length >= 250) flush();
  }
  if (batch.length) flush();
  if (imported !== state.posts) throw new Error('Backfill record count does not match its capture report');
  const previous=store.get('usageBackfill');
  const ranges=mergeRanges([...(previous?.status==='imported' ? previous.ranges || [[previous.start,previous.end]] : []),[state.start,state.end]]);
  const earliestStart=ranges[0][0], start=ranges[0][0], end=ranges.at(-1)[1];
  store.set('usageBackfill', { ...state, start, end, ranges, earliestStart, status: 'imported', imported, importedAt: Date.now() });
  store.refresh();
  return { imported, start: new Date(state.start).toISOString(), end: new Date(state.end).toISOString() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = openStore();
  try { console.log(JSON.stringify(await importBackfill(store, resolve(process.argv[2] || 'data/bluesky-backfill.ndjson'), { onProgress: value => console.log(JSON.stringify(value)) }))); }
  finally { store.close(); }
}
