import { existsSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { databasePath } from './runtime.mjs';

export function previewSnapshot(store, exportedAt = Date.now()) {
  const ranking = store.get('ranking');
  const recordedAt = Date.parse(ranking?.updatedAt);
  if (!Number.isFinite(recordedAt) || !ranking.trends?.length) {
    throw new Error('Collect and rank real data before exporting a preview.');
  }
  // Preserve the original time window, including Reddit's rolling counts.
  // Exporting must not rerank old observations or make them appear freshly collected.
  return { ...store.publicRanking(recordedAt), stale: true,
    preview: { kind: 'snapshot', exportedAt: new Date(exportedAt).toISOString() } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(databasePath)) throw new Error('No collected database is available to export.');
  const store = new Store(databasePath);
  try {
    const snapshot = previewSnapshot(store);
    const output = new URL('../../../trend-preview.json', import.meta.url);
    const pending = new URL('../../../trend-preview.json.tmp', import.meta.url);
    writeFileSync(pending, JSON.stringify(snapshot) + '\n');
    renameSync(pending, output);
    console.log(`Exported ${snapshot.trends.length} trends recorded ${snapshot.updatedAt} to ${fileURLToPath(output)}`);
  } finally { store.close(); }
}
