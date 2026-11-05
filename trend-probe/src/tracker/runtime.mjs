import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Store } from './store.mjs';
export const databasePath = process.env.TREND_DB_PATH || fileURLToPath(new URL('../../data/trends.sqlite', import.meta.url));
export function openStore() {
  const store = new Store(databasePath);
  for (const evidence of JSON.parse(readFileSync(new URL('../../config/age-evidence.json', import.meta.url)))) store.addEvidence(evidence);
  return store;
}
