import { openStore, databasePath } from './runtime.mjs';
import { collectOnce } from './collector.mjs';
const store = openStore();
try {
  const ranking = await collectOnce(store);
  console.log(JSON.stringify({ databasePath, candidates: ranking.candidateCount, ranked: ranking.trends.length, updatedAt: ranking.updatedAt, sources: store.publicRanking().sources }, null, 2));
} finally { store.close(); }
